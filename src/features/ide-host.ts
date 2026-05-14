import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';

/**
 * The IDE/host the extension is running in.
 *
 * Detection uses `vscode.env.appName`. Cursor identifies itself as "Cursor";
 * anything else (VS Code, VS Code Insiders, etc.) falls back to the legacy
 * profile so no Cursor-specific directories are written on foreign hosts.
 */
export type InstallHost = 'cursor' | 'vscode';

/**
 * Returns the host the extension is currently running in.
 * Centralise this here so any future change to Cursor's appName string
 * only needs to be updated in one place.
 */
export function getInstallHost(): InstallHost {
    const name = vscode.env.appName ?? '';
    return name.toLowerCase().includes('cursor') ? 'cursor' : 'vscode';
}

/**
 * Directories returned by `resolveWorkspaceComponentRoots`.
 * Every value is an absolute path; callers create them with `fs.mkdir`.
 */
export interface WorkspaceComponentRoots {
    skillsRoot: string;
    rulesRoot: string;
    agentsRoot: string;
    hooksRoot: string;
    mcpRoot: string;
    lspRoot: string;
    commandsRoot: string;
    toolsRoot: string;
    promptsRoot: string;
    workflowsRoot: string;
}

/**
 * Resolves the install roots for each component type given a workspace
 * folder root, a sanitised plugin id, and the active host profile.
 *
 * Cursor  → workspace/.cursor/<component>/<pluginId>/
 * Legacy  → workspace/.agents/skills/  and  workspace/.github/{agents,hooks,mcp,lsp,commands,tools,prompts,workflows}/
 *           (rules have no legacy equivalent and are simply skipped on
 *           legacy hosts — the caller should check rulesRoot only on Cursor)
 */
export function resolveWorkspaceComponentRoots(
    workspaceRoot: string,
    pluginId: string,
    host: InstallHost
): WorkspaceComponentRoots {
    if (host === 'cursor') {
        const cursorRoot = path.join(workspaceRoot, '.cursor');
        return {
            skillsRoot: path.join(cursorRoot, 'skills', pluginId),
            rulesRoot:  path.join(cursorRoot, 'rules',  pluginId),
            agentsRoot: path.join(cursorRoot, 'agents', pluginId),
            hooksRoot:  path.join(cursorRoot, 'hooks',  pluginId),
            mcpRoot:    path.join(cursorRoot, 'mcp',    pluginId),
            lspRoot:    path.join(cursorRoot, 'lsp',    pluginId),
            commandsRoot: path.join(cursorRoot, 'commands', pluginId),
            toolsRoot: path.join(cursorRoot, 'tools', pluginId),
            promptsRoot: path.join(cursorRoot, 'prompts', pluginId),
            workflowsRoot: path.join(cursorRoot, 'workflows', pluginId),
        };
    }

    // Legacy (VS Code / unknown host): keep original directory layout.
    // Rules are not written on legacy hosts (no equivalent convention).
    const agentsSkillsRoot = path.join(workspaceRoot, '.agents', 'skills');
    const githubRoot = path.join(workspaceRoot, '.github');
    return {
        skillsRoot: agentsSkillsRoot,
        rulesRoot:  '',  // intentionally empty — skip rule installs on legacy hosts
        agentsRoot: path.join(githubRoot, 'agents'),
        hooksRoot:  path.join(githubRoot, 'hooks'),
        mcpRoot:    path.join(githubRoot, 'mcp'),
        lspRoot:    path.join(githubRoot, 'lsp'),
        commandsRoot: path.join(githubRoot, 'commands'),
        toolsRoot: path.join(githubRoot, 'tools'),
        promptsRoot: path.join(githubRoot, 'prompts'),
        workflowsRoot: path.join(githubRoot, 'workflows'),
    };
}

/**
 * Returns the user-scope install root for the active host.
 *
 * Cursor  → ~/.cursor/plugins/local
 * Legacy  → ~/.copilot/installed-plugins
 */
export function resolveUserInstallRoot(host: InstallHost): string {
    if (host === 'cursor') {
        return path.join(os.homedir(), '.cursor', 'plugins', 'local');
    }
    return path.join(os.homedir(), '.copilot', 'installed-plugins');
}
