import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { MarketplaceGroupItem, MarketplacePlugin } from './marketplace';
import { fetchWithGitHubAuth } from './github-auth';
import { getLogger } from './logger';
import { gitCloneShallowToTemp } from './git-clone';
import { getInstallHost, resolveWorkspaceComponentRoots, resolveUserInstallRoot, type WorkspaceComponentRoots } from './ide-host';

export type InstallScope = 'workspace' | 'user';

export interface InstallPayload {
    version: 'v1';
    operation: 'installOrUpdate';
    scope: InstallScope;
    targetPath: string;
    requestedAt: string;
    plugins: Array<{
        id: string;
        name: string;
        version?: string;
        sourceUrl: string;
        downloadUrl?: string;
    }>;
    marketplaceUrls: string[];
}

export interface OperationResult {
    success: boolean;
    error?: string;
}

interface InstalledPathCollection {
    skillPaths: string[];
    agentPaths: string[];
    hookPaths: string[];
    mcpPaths: string[];
    lspPaths: string[];
}

interface RepoContext {
    owner: string;
    repo: string;
    branch: string;
    rawBaseUrl: string;
}

interface GitHubContentEntry {
    type?: string;
    name?: string;
    path?: string;
}

function sanitizePathSegment(value: string): string {
    const sanitized = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

    if (sanitized === '..' || sanitized === '.') {
        return 'unknown';
    }

    return sanitized.length > 0 ? sanitized : 'unknown';
}

function getMarketplaceName(sourceUrl: string): string {
    try {
        const parsed = new URL(sourceUrl);
        if (parsed.hostname.includes('github.com')) {
            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length >= 2) {
                return sanitizePathSegment(segments[1].replace(/\.git$/i, ''));
            }
        }

        const segments = parsed.pathname.split('/').filter(Boolean).reverse();
        for (const segment of segments) {
            if (segment.toLowerCase() !== 'marketplace.json') {
                return sanitizePathSegment(segment.replace(/\.json$/i, ''));
            }
        }
    } catch {
        return sanitizePathSegment(sourceUrl);
    }

    return 'marketplace';
}

function getPluginName(plugin: MarketplacePlugin): string {
    return sanitizePathSegment(plugin.name || plugin.id);
}

function normalizeRelativePath(value: string): string {
    return value
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\//, '')
        .replace(/\/+$/, '');
}

function encodePath(value: string): string {
    return value
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function getRepoContext(plugin: MarketplacePlugin): RepoContext | undefined {
    const match = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//i.exec(
        plugin.marketplaceDocumentUrl
    );
    if (!match) {
        return undefined;
    }

    const owner = match[1];
    const repo = match[2];
    const branch = match[3];
    return {
        owner,
        repo,
        branch,
        rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
    };
}

async function fetchGitHubPathContents(repoContext: RepoContext, relativePath: string): Promise<unknown | undefined> {
    const encoded = encodePath(relativePath);
    const url = `https://api.github.com/repos/${repoContext.owner}/${repoContext.repo}/contents/${encoded}?ref=${encodeURIComponent(repoContext.branch)}`;

    try {
        const response = await fetchWithGitHubAuth(url, {
            headers: {
                'User-Agent': 'vscode-agent-plugins',
                'Accept': 'application/vnd.github+json'
            }
        });
        if (!response.ok) {
            getLogger()?.trace(`GitHub API returned ${response.status} ${response.statusText} for ${url}`);
            return undefined;
        }

        return (await response.json()) as unknown;
    } catch (error) {
        getLogger()?.trace(`Failed to fetch GitHub path contents for ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

async function downloadRawFile(rawUrl: string, targetPath: string, logger?: { warn: (msg: string) => void }): Promise<boolean> {
    try {
        const response = await fetchWithGitHubAuth(rawUrl);
        if (!response.ok) {
            logger?.warn(`Failed to download ${rawUrl}: ${response.status} ${response.statusText}`);
            return false;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, bytes);
        return true;
    } catch (error) {
        logger?.warn(`Failed to download ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

async function fetchRawText(rawUrl: string): Promise<string | undefined> {
    try {
        const response = await fetchWithGitHubAuth(rawUrl);
        if (!response.ok) {
            getLogger()?.trace(`Fetch returned ${response.status} ${response.statusText} for ${rawUrl}`);
            return undefined;
        }
        return await response.text();
    } catch (error) {
        getLogger()?.trace(`Failed to fetch raw text from ${rawUrl}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

async function copyGithubEntryTree(repoContext: RepoContext, sourcePath: string, targetPath: string): Promise<boolean> {
    const contents = await fetchGitHubPathContents(repoContext, sourcePath);
    if (!contents) {
        return false;
    }

    if (Array.isArray(contents)) {
        let copied = false;
        for (const entry of contents) {
            const record = entry as GitHubContentEntry;
            if (!record.type || !record.path || !record.name) {
                continue;
            }

            if (record.type === 'dir') {
                const childCopied = await copyGithubEntryTree(repoContext, record.path, path.join(targetPath, record.name));
                copied = copied || childCopied;
                continue;
            }

            if (record.type === 'file') {
                const rawUrl = `${repoContext.rawBaseUrl}/${record.path}`;
                const fileCopied = await downloadRawFile(rawUrl, path.join(targetPath, record.name));
                copied = copied || fileCopied;
            }
        }
        return copied;
    }

    const record = contents as GitHubContentEntry;
    if (record.type === 'file' && record.path) {
        const rawUrl = `${repoContext.rawBaseUrl}/${record.path}`;
        const fileName = path.basename(record.path);
        return downloadRawFile(rawUrl, path.join(targetPath, fileName));
    }

    if (record.type === 'dir' && record.path) {
        return copyGithubEntryTree(repoContext, record.path, targetPath);
    }

    return false;
}

async function gitCloneToTemp(gitUrl: string): Promise<string> {
    return gitCloneShallowToTemp(gitUrl, 'agent-plugins-git');
}

async function copyLocalTree(src: string, dest: string): Promise<void> {
    const stat = await fs.stat(src);
    if (stat.isFile()) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(src, dest);
    } else {
        await fs.mkdir(dest, { recursive: true });
        await fs.cp(src, dest, { recursive: true });
    }
}

function workspaceRootForGroup(roots: WorkspaceComponentRoots, groupKey: string): string | undefined {
    switch (groupKey) {
        case 'skills':
            return roots.skillsRoot;
        case 'rules':
            return roots.rulesRoot ? roots.rulesRoot : undefined;
        case 'agents':
            return roots.agentsRoot;
        case 'hooks':
            return roots.hooksRoot;
        case 'mcp':
            return roots.mcpRoot;
        case 'lsp':
            return roots.lspRoot;
        case 'commands':
            return roots.commandsRoot;
        case 'tools':
            return roots.toolsRoot;
        case 'prompts':
            return roots.promptsRoot;
        case 'workflows':
            return roots.workflowsRoot;
        default:
            return undefined;
    }
}

async function installPluginFromGit(plugin: MarketplacePlugin, roots: WorkspaceComponentRoots): Promise<void> {
    const gitUrl = plugin.gitUrl!;
    const tmpDir = await gitCloneToTemp(gitUrl);
    try {
        for (const group of plugin.groups) {
            const root = workspaceRootForGroup(roots, group.key);
            if (!root) {
                continue;
            }

            const groupItems = group.items.filter((item) => item.path);

            const copyGroup = async () => {
                if (groupItems.length > 0) {
                    for (const item of groupItems) {
                        const src = path.join(tmpDir, normalizeRelativePath(item.path!));
                        const srcStat = await fs.stat(src).catch(() => undefined);
                        const dest = srcStat?.isFile()
                            ? path.join(root, path.basename(item.path!))
                            : path.join(root, sanitizePathSegment(item.name));
                        await copyLocalTree(src, dest);
                    }
                } else {
                    await copyLocalTree(tmpDir, path.join(root, sanitizePathSegment(plugin.name || plugin.id)));
                }
            };

            await copyGroup();
        }

        if (plugin.groups.length === 0) {
            await copyLocalTree(tmpDir, path.join(roots.skillsRoot, sanitizePathSegment(plugin.name || plugin.id)));
        }
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

async function fallbackDownloadItemDescriptor(item: MarketplaceGroupItem, targetPath: string): Promise<boolean> {
    const candidates = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
    for (const candidate of candidates) {
        const fileName = path.basename(new URL(candidate).pathname) || 'descriptor.md';
        if (await downloadRawFile(candidate, path.join(targetPath, fileName))) {
            return true;
        }
    }

    return false;
}

async function installSkillItem(plugin: MarketplacePlugin, item: MarketplaceGroupItem, skillsRoot: string): Promise<void> {
    const skillFolder = path.join(skillsRoot, sanitizePathSegment(item.name));

    // Local disk install: item.localPath points to the primary descriptor file inside the skill
    // directory. Copy the whole parent directory (the skill folder itself) to the target.
    if (item.localPath) {
        const srcDir = path.dirname(item.localPath);
        await copyLocalTree(srcDir, skillFolder);
        return;
    }

    await fs.mkdir(skillFolder, { recursive: true });
    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;
    if (repoContext && sourcePath) {
        const copied = await copyGithubEntryTree(repoContext, sourcePath, skillFolder);
        if (copied) {
            return;
        }
    }

    await fallbackDownloadItemDescriptor(item, skillFolder);
}

/**
 * Installs a manifest item that is either a single file (.md / .mdc) or a directory tree
 * (rules, commands, tools, prompts, workflows, and similar bundles).
 */
async function installFileOrDirectoryItem(plugin: MarketplacePlugin, item: MarketplaceGroupItem, targetRoot: string): Promise<void> {
    await fs.mkdir(targetRoot, { recursive: true });

    if (item.localPath) {
        const stat = await fs.stat(item.localPath).catch(() => undefined);
        if (stat?.isDirectory()) {
            const destDir = path.join(targetRoot, sanitizePathSegment(item.name));
            await copyLocalTree(item.localPath, destDir);
            return;
        }

        const destFile = path.join(targetRoot, path.basename(item.localPath));
        await fs.copyFile(item.localPath, destFile);
        return;
    }

    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;
    if (repoContext && sourcePath) {
        if (looksLikeFilePath(sourcePath)) {
            const rawUrl = `${repoContext.rawBaseUrl}/${sourcePath}`;
            const fileName = path.basename(sourcePath);
            const copied = await downloadRawFile(rawUrl, path.join(targetRoot, fileName));
            if (copied) {
                return;
            }
        }
        const itemFolder = path.join(targetRoot, sanitizePathSegment(item.name));
        await fs.mkdir(itemFolder, { recursive: true });
        const copied = await copyGithubEntryTree(repoContext, sourcePath, itemFolder);
        if (copied) {
            return;
        }
    }

    await fallbackDownloadItemDescriptor(item, targetRoot);
}

async function getAgentText(plugin: MarketplacePlugin, item: MarketplaceGroupItem): Promise<string | undefined> {
    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;

    if (repoContext && sourcePath) {
        const contents = await fetchGitHubPathContents(repoContext, sourcePath);
        if (contents && !Array.isArray(contents)) {
            const record = contents as GitHubContentEntry;
            if (record.type === 'file' && record.path) {
                const text = await fetchRawText(`${repoContext.rawBaseUrl}/${record.path}`);
                if (text) {
                    return text;
                }
            }
        }

        if (Array.isArray(contents)) {
            const entries = contents as GitHubContentEntry[];
            const preferred = ['AGENT.md', 'AGENTS.md', 'README.md'];
            for (const fileName of preferred) {
                const match = entries.find((entry) => entry.type === 'file' && entry.name?.toLowerCase() === fileName.toLowerCase());
                if (match?.path) {
                    const text = await fetchRawText(`${repoContext.rawBaseUrl}/${match.path}`);
                    if (text) {
                        return text;
                    }
                }
            }

            const anyMarkdown = entries.find((entry) => entry.type === 'file' && entry.path && /\.md$/i.test(entry.path));
            if (anyMarkdown?.path) {
                const text = await fetchRawText(`${repoContext.rawBaseUrl}/${anyMarkdown.path}`);
                if (text) {
                    return text;
                }
            }
        }
    }

    const descriptorCandidates = [item.metadataUrl, ...item.metadataFallbackUrls].filter((entry): entry is string => Boolean(entry));
    for (const candidate of descriptorCandidates) {
        const text = await fetchRawText(candidate);
        if (text) {
            return text;
        }
    }

    if (item.description) {
        return `# ${item.name}\n\n${item.description}\n`;
    }

    return undefined;
}

async function installAgentItem(plugin: MarketplacePlugin, item: MarketplaceGroupItem, agentsRoot: string): Promise<void> {
    await fs.mkdir(agentsRoot, { recursive: true });

    // Local disk install: copy the file directly preserving its name.
    if (item.localPath) {
        const destFile = path.join(agentsRoot, path.basename(item.localPath));
        await fs.copyFile(item.localPath, destFile);
        return;
    }

    const fileBase = sanitizePathSegment(item.name.replace(/\.agent\.md$/i, '').replace(/\.md$/i, ''));
    const filePath = path.join(agentsRoot, `${fileBase}.agent.md`);

    const content = await getAgentText(plugin, item);
    if (!content) {
        return;
    }

    await fs.writeFile(filePath, content, 'utf8');
}

function looksLikeFilePath(value: string): boolean {
    return /\.[a-z0-9]+$/i.test(path.posix.basename(value));
}

async function installConfigItem(
    plugin: MarketplacePlugin,
    item: MarketplaceGroupItem,
    groupRoot: string,
    groupKey: 'hooks' | 'mcp' | 'lsp'
): Promise<void> {
    await fs.mkdir(groupRoot, { recursive: true });

    // Local disk install: copy the file directly.
    if (item.localPath) {
        const destFile = path.join(groupRoot, path.basename(item.localPath));
        await fs.copyFile(item.localPath, destFile);
        return;
    }

    if (typeof item.inlineContent !== 'undefined') {
        const fileName = groupKey === 'hooks'
            ? 'hooks.json'
            : groupKey === 'mcp'
                ? '.mcp.json'
                : 'lsp.json';
        const filePath = path.join(groupRoot, fileName);
        const serialized = JSON.stringify(item.inlineContent, null, 2);
        await fs.writeFile(filePath, `${serialized}\n`, 'utf8');
        return;
    }

    const repoContext = getRepoContext(plugin);
    const sourcePath = item.path ? normalizeRelativePath(item.path) : undefined;
    if (repoContext && sourcePath) {
        const copyTarget = looksLikeFilePath(sourcePath)
            ? groupRoot
            : path.join(groupRoot, sanitizePathSegment(item.name));
        const copied = await copyGithubEntryTree(repoContext, sourcePath, copyTarget);
        if (copied) {
            return;
        }
    }

    const fallbackRoot = sourcePath && looksLikeFilePath(sourcePath)
        ? groupRoot
        : path.join(groupRoot, sanitizePathSegment(item.name));

    await fs.mkdir(fallbackRoot, { recursive: true });
    await fallbackDownloadItemDescriptor(item, fallbackRoot);
}

/**
 * Ensures `.gitignore` in the workspace root contains a pattern for each
 * installed plugin's `.cursor/` subtree. Only appends entries that are not
 * already present; creates the file if it does not exist.
 *
 * Pattern added per plugin: `.cursor/STAR/MARKETPLACE/PLUGIN/`
 * The `*` wildcard covers all component types (skills, rules, agents, …).
 */
export async function ensureGitignoreEntries(workspaceRoot: string, plugins: MarketplacePlugin[]): Promise<void> {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    let existing = '';
    try {
        existing = await fs.readFile(gitignorePath, 'utf8');
    } catch {
        // File does not exist yet — start with empty content.
    }

    const existingLines = new Set(existing.split(/\r?\n/));
    const toAdd: string[] = [];

    for (const plugin of plugins) {
        const marketplace = getMarketplaceName(plugin.sourceUrl);
        const pluginName = getPluginName(plugin);
        const pattern = `.cursor/*/${marketplace}/${pluginName}/`;
        if (!existingLines.has(pattern)) {
            toAdd.push(pattern);
        }
    }

    if (toAdd.length === 0) {
        return;
    }

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const appendix = (needsLeadingNewline ? '\n' : '') + toAdd.join('\n') + '\n';
    await fs.appendFile(gitignorePath, appendix, 'utf8');
}

async function materializeLocalInstallStructure(workspaceRoot: string, plugins: MarketplacePlugin[]): Promise<void> {
    const host = getInstallHost();
    const installPromises: Promise<void>[] = [];

    for (const plugin of plugins) {
        const pluginBase = host === 'cursor'
            ? path.join(getMarketplaceName(plugin.sourceUrl), getPluginName(plugin))
            : getPluginName(plugin);
        const roots = resolveWorkspaceComponentRoots(workspaceRoot, pluginBase, host);
        const { skillsRoot, rulesRoot, agentsRoot, hooksRoot, mcpRoot, lspRoot, commandsRoot, toolsRoot, promptsRoot, workflowsRoot } = roots;

        if (plugin.gitUrl) {
            installPromises.push(installPluginFromGit(plugin, roots));
            continue;
        }

        for (const group of plugin.groups) {
            if (group.key === 'skills') {
                for (const item of group.items) {
                    installPromises.push(installSkillItem(plugin, item, skillsRoot));
                }
            }

            if (group.key === 'rules' && rulesRoot) {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, rulesRoot));
                }
            }

            if (group.key === 'agents') {
                for (const item of group.items) {
                    installPromises.push(installAgentItem(plugin, item, agentsRoot));
                }
            }

            if (group.key === 'hooks') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, hooksRoot, 'hooks'));
                }
            }

            if (group.key === 'mcp') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, mcpRoot, 'mcp'));
                }
            }

            if (group.key === 'lsp') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, lspRoot, 'lsp'));
                }
            }

            if (group.key === 'commands') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, commandsRoot));
                }
            }

            if (group.key === 'tools') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, toolsRoot));
                }
            }

            if (group.key === 'prompts') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, promptsRoot));
                }
            }

            if (group.key === 'workflows') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, workflowsRoot));
                }
            }
        }
    }

    await Promise.all(installPromises);

    if (host === 'cursor') {
        await ensureGitignoreEntries(workspaceRoot, plugins);
    }
}

/**
 * Cursor user-scope install: shallow clone the plugin's git repo and copy the
 * plugin source subtree (from plugin.raw.source, e.g. "plugins/encompass-demo/")
 * into `localPluginsRoot/<pluginId>/`, replacing any prior install.
 *
 * This is the Cursor "plugin" installation method — the whole package directory
 * lands under ~/.cursor/plugins/local/ so Cursor can discover rules, skills,
 * agents, hooks, and MCP config from one consistent place.
 *
 * Non-gitUrl plugins cannot use this method; they fall back to the legacy
 * decomposed install (see materializeUserInstallStructureLegacy).
 */
async function installCursorLocalPlugin(plugin: MarketplacePlugin, localPluginsRoot: string): Promise<void> {
    const pluginId = getPluginName(plugin);
    const destRoot = path.join(localPluginsRoot, pluginId);

    const gitUrl = plugin.gitUrl!;
    const tmpDir = await gitCloneToTemp(gitUrl);
    try {
        const source = typeof plugin.raw.source === 'string' ? plugin.raw.source : undefined;
        const sourceSubdir = source ? normalizeRelativePath(source).replace(/\/+$/, '') : '';
        const srcPath = sourceSubdir ? path.join(tmpDir, sourceSubdir) : tmpDir;

        await fs.rm(destRoot, { recursive: true, force: true });
        await copyLocalTree(srcPath, destRoot);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
    }
}

async function materializeUserInstallStructure(userRoot: string, plugins: MarketplacePlugin[]): Promise<InstalledPathCollection> {
    const host = getInstallHost();

    if (host === 'cursor') {
        // Cursor profile: full-tree copy via git clone for each gitUrl plugin.
        // Non-gitUrl plugins are not supported for user-scope on Cursor.
        const installPromises = plugins
            .filter((p) => {
                if (!p.gitUrl) {
                    getLogger()?.warn(`User-scope install skipped for "${p.name}": no gitUrl (Cursor profile requires a git-cloneable source).`);
                    return false;
                }
                return true;
            })
            .map((p) => installCursorLocalPlugin(p, userRoot));

        await Promise.all(installPromises);

        // Cursor local plugins are discovered by Cursor itself from the directory
        // structure under ~/.cursor/plugins/local — no workspace settings needed.
        return { skillPaths: [], agentPaths: [], hookPaths: [], mcpPaths: [], lspPaths: [] };
    }

    // Legacy (VS Code) profile: decomposed install under marketplace/plugin segments.
    return materializeUserInstallStructureLegacy(userRoot, plugins);
}

async function materializeUserInstallStructureLegacy(userRoot: string, plugins: MarketplacePlugin[]): Promise<InstalledPathCollection> {
    const skillPaths = new Set<string>();
    const agentPaths = new Set<string>();
    const hookPaths = new Set<string>();
    const mcpPaths = new Set<string>();
    const lspPaths = new Set<string>();

    const installPromises: Promise<void>[] = [];

    for (const plugin of plugins) {
        const pluginRoot = path.join(userRoot, getMarketplaceName(plugin.sourceUrl), getPluginName(plugin));
        const skillsRoot = path.join(pluginRoot, 'skills');
        const agentsRoot = path.join(pluginRoot, 'agents');
        const hooksRoot = path.join(pluginRoot, 'hooks');
        const mcpRoot = path.join(pluginRoot, 'mcp');
        const lspRoot = path.join(pluginRoot, 'lsp');
        const commandsRoot = path.join(pluginRoot, 'commands');
        const toolsRoot = path.join(pluginRoot, 'tools');
        const promptsRoot = path.join(pluginRoot, 'prompts');
        const workflowsRoot = path.join(pluginRoot, 'workflows');

        const userGitRoots: WorkspaceComponentRoots = {
            skillsRoot,
            rulesRoot: '',
            agentsRoot,
            hooksRoot,
            mcpRoot,
            lspRoot,
            commandsRoot,
            toolsRoot,
            promptsRoot,
            workflowsRoot
        };

        if (plugin.gitUrl) {
            installPromises.push(installPluginFromGit(plugin, userGitRoots));
            for (const group of plugin.groups) {
                if (group.key === 'skills') { skillPaths.add(skillsRoot); }
                if (group.key === 'agents') { agentPaths.add(agentsRoot); }
                if (group.key === 'hooks') { hookPaths.add(hooksRoot); }
                if (group.key === 'mcp') { mcpPaths.add(mcpRoot); }
                if (group.key === 'lsp') { lspPaths.add(lspRoot); }
            }
            if (plugin.groups.length === 0) {
                skillPaths.add(skillsRoot);
            }
            continue;
        }

        for (const group of plugin.groups) {
            if (group.key === 'skills') {
                for (const item of group.items) {
                    installPromises.push(installSkillItem(plugin, item, skillsRoot));
                }
                if (group.items.length > 0) {
                    skillPaths.add(skillsRoot);
                }
            }

            if (group.key === 'agents') {
                for (const item of group.items) {
                    installPromises.push(installAgentItem(plugin, item, agentsRoot));
                }
                if (group.items.length > 0) {
                    agentPaths.add(agentsRoot);
                }
            }

            if (group.key === 'hooks') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, hooksRoot, 'hooks'));
                }
                if (group.items.length > 0) {
                    hookPaths.add(hooksRoot);
                }
            }

            if (group.key === 'mcp') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, mcpRoot, 'mcp'));
                }
                if (group.items.length > 0) {
                    mcpPaths.add(mcpRoot);
                }
            }

            if (group.key === 'lsp') {
                for (const item of group.items) {
                    installPromises.push(installConfigItem(plugin, item, lspRoot, 'lsp'));
                }
                if (group.items.length > 0) {
                    lspPaths.add(lspRoot);
                }
            }

            if (group.key === 'commands') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, commandsRoot));
                }
            }

            if (group.key === 'tools') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, toolsRoot));
                }
            }

            if (group.key === 'prompts') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, promptsRoot));
                }
            }

            if (group.key === 'workflows') {
                for (const item of group.items) {
                    installPromises.push(installFileOrDirectoryItem(plugin, item, workflowsRoot));
                }
            }
        }
    }

    await Promise.all(installPromises);

    return {
        skillPaths: Array.from(skillPaths),
        agentPaths: Array.from(agentPaths),
        hookPaths: Array.from(hookPaths),
        mcpPaths: Array.from(mcpPaths),
        lspPaths: Array.from(lspPaths)
    };
}

function toTildePath(absolutePath: string): string {
    const home = os.homedir();
    if (absolutePath.startsWith(home)) {
        return '~' + absolutePath.slice(home.length).replace(/\\/g, '/');
    }
    return absolutePath.replace(/\\/g, '/');
}

function getWorkspaceSettingObject(key: string): Record<string, boolean> {
    const inspection = vscode.workspace.getConfiguration().inspect<Record<string, boolean>>(key);
    const workspaceValue = inspection?.workspaceValue;
    return workspaceValue && typeof workspaceValue === 'object' && !Array.isArray(workspaceValue)
        ? workspaceValue
        : {};
}

async function updateWorkspaceChatFileSettings(paths: InstalledPathCollection): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        return;
    }

    // Only merge Cursor-style workspace settings when running inside Cursor.
    // On legacy hosts the paths are still under .agents/skills and .github/agents,
    // and those do not require an explicit workspace setting entry to be discovered.
    if (getInstallHost() !== 'cursor') {
        return;
    }

    // User-scope Cursor installs land under ~/.cursor/plugins/local and are discovered
    // without workspace entries. Avoid calling ConfigurationTarget.Workspace updates with
    // nothing new — that still prompts to modify workspace settings.
    if (paths.skillPaths.length === 0 && paths.agentPaths.length === 0) {
        return;
    }

    const existingSkills = getWorkspaceSettingObject('chat.agentSkillsLocations');
    const existingAgents = getWorkspaceSettingObject('chat.agentFilesLocations');

    const mergedSkills: Record<string, boolean> = { ...existingSkills };
    for (const skillPath of paths.skillPaths) {
        mergedSkills[toTildePath(skillPath)] = true;
    }

    const mergedAgents: Record<string, boolean> = { ...existingAgents };
    for (const agentPath of paths.agentPaths) {
        mergedAgents[toTildePath(agentPath)] = true;
    }

    await vscode.workspace
        .getConfiguration()
        .update('chat.agentSkillsLocations', mergedSkills, vscode.ConfigurationTarget.Workspace);
    await vscode.workspace
        .getConfiguration()
        .update('chat.agentFilesLocations', mergedAgents, vscode.ConfigurationTarget.Workspace);
}


export function resolveAgentsPath(scope: InstallScope, workspaceFolder?: vscode.WorkspaceFolder): string | undefined {
    if (scope === 'user') {
        return resolveUserInstallRoot(getInstallHost());
    }

    const folder = workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return undefined;
    }

    return folder.uri.fsPath;
}

export function buildInstallPayload(
    plugins: MarketplacePlugin[],
    scope: InstallScope,
    targetPath: string,
    marketplaceUrls: string[]
): InstallPayload {
    return {
        version: 'v1',
        operation: 'installOrUpdate',
        scope,
        targetPath,
        requestedAt: new Date().toISOString(),
        plugins: plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            sourceUrl: plugin.sourceUrl,
            downloadUrl: plugin.downloadUrl
        })),
        marketplaceUrls
    };
}

export async function persistLastOperation(
    context: vscode.ExtensionContext,
    payload: InstallPayload,
    result: OperationResult
): Promise<void> {
    const key = payload.scope === 'workspace' ? 'lastOperation.workspace' : 'lastOperation.user';
    const store = payload.scope === 'workspace' ? context.workspaceState : context.globalState;
    await store.update(key, {
        timestamp: new Date().toISOString(),
        scope: payload.scope,
        targetPath: payload.targetPath,
        pluginCount: payload.plugins.length,
        success: result.success,
        error: result.error
    });
}

export async function executeInstall(
    context: vscode.ExtensionContext,
    plugins: MarketplacePlugin[],
    payload: InstallPayload
): Promise<OperationResult> {
    try {
        if (payload.scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
            return { success: false, error: 'Open a workspace folder to install local skills and agents.' };
        }

        if (payload.scope === 'workspace') {
            await materializeLocalInstallStructure(payload.targetPath, plugins);
        } else {
            const installedPaths = await materializeUserInstallStructure(payload.targetPath, plugins);
            await updateWorkspaceChatFileSettings(installedPaths);
        }

        await persistLastOperation(context, payload, { success: true });
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await persistLastOperation(context, payload, { success: false, error: message });
        return { success: false, error: message };
    }
}
