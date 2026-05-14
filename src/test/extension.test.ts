import * as assert from 'assert';
import * as vscode from 'vscode';
import { normalizeMarketplaceUrlInput, validateMarketplaceUrlInput } from '../features/config';
import { buildInstallPayload } from '../features/delegation';
import { fetchWithGitHubAuth } from '../features/github-auth';
import { initLogger } from '../features/logger';
import {
	fetchMarketplace,
	fetchGroupItemContent,
	getSupportedSkillProfileDirectories,
	normalizeMarketplaceDocument,
	resolveMarketplaceDocumentReference
} from '../features/marketplace';
import { getInstallHost, resolveWorkspaceComponentRoots, resolveUserInstallRoot } from '../features/ide-host';

suite('Extension Test Suite', () => {
	const originalFetch = globalThis.fetch;
	const originalGetSession = vscode.authentication.getSession;

	teardown(() => {
		globalThis.fetch = originalFetch;
		(vscode.authentication as typeof vscode.authentication & { getSession: typeof vscode.authentication.getSession }).getSession = originalGetSession;
	});

	test('normalizes marketplace plugin entries', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'alpha',
						name: 'Alpha Plugin',
						version: '1.2.3',
						description: 'Test plugin',
						downloadUrl: 'https://example.com/alpha.tgz',
						skills: [{ name: 'summarize' }],
						agents: ['triage-agent']
					}
				]
			},
			'https://marketplace.example/marketplace.json'
		);

		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(result.warnings.length, 0);
		assert.strictEqual(result.plugins.length, 1);
		assert.strictEqual(result.plugins[0].id, 'alpha');
		assert.strictEqual(result.plugins[0].name, 'Alpha Plugin');
		assert.strictEqual(result.plugins[0].groups.length, 2);
		assert.strictEqual(result.plugins[0].groups[0].items[0].name, 'summarize');
	});

	test('builds install payload with selected plugins', () => {
		const payload = buildInstallPayload(
			[
				{
					id: 'alpha',
					name: 'Alpha Plugin',
					version: '1.2.3',
					groups: [],
					sourceUrl: 'https://marketplace.example/marketplace.json',
					marketplaceDocumentUrl: 'https://marketplace.example/marketplace.json',
					downloadUrl: 'https://example.com/alpha.tgz',
					raw: {}
				}
			],
			'workspace',
			'd:/repo/.copilot/installed-plugins',
			['https://marketplace.example/marketplace.json']
		);

		assert.strictEqual(payload.version, 'v1');
		assert.strictEqual(payload.operation, 'installOrUpdate');
		assert.strictEqual(payload.scope, 'workspace');
		assert.strictEqual(payload.plugins.length, 1);
		assert.strictEqual(payload.marketplaceUrls.length, 1);
	});

	test('normalizes GitHub owner repo marketplace shorthand', () => {
		assert.strictEqual(
			normalizeMarketplaceUrlInput('anthropics/skills'),
			'https://github.com/anthropics/skills'
		);
		assert.strictEqual(
			normalizeMarketplaceUrlInput('anthropics/skills.git'),
			'https://github.com/anthropics/skills'
		);
	});

	test('accepts GitHub owner repo marketplace shorthand in validation', () => {
		assert.strictEqual(validateMarketplaceUrlInput('anthropics/skills'), undefined);
	});

	test('resolves relative marketplace document references', () => {
		const result = resolveMarketplaceDocumentReference(
			'../.github/plugin/marketplace.json',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(
			result,
			'https://raw.githubusercontent.com/dotnet/skills/main/.github/plugin/marketplace.json'
		);
	});

	test('resolves absolute marketplace document references', () => {
		const result = resolveMarketplaceDocumentReference(
			'https://example.com/marketplace.json',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(result, 'https://example.com/marketplace.json');
	});

	test('resolves plain text redirect references', () => {
		const result = resolveMarketplaceDocumentReference(
			'../.github/plugin/marketplace.json\n',
			'https://raw.githubusercontent.com/dotnet/skills/main/.claude-plugin/marketplace.json'
		);

		assert.strictEqual(
			result,
			'https://raw.githubusercontent.com/dotnet/skills/main/.github/plugin/marketplace.json'
		);
	});

	test('normalizes hooks, mcp, and lsp groups', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'spec-plugin',
						name: 'Spec Plugin',
						hooks: './hooks.json',
						mcpServers: './.mcp.json',
						lspServers: './lsp.json'
					}
				]
			},
			'https://example.com/marketplace.json'
		);

		const groups = result.plugins[0].groups.map((group) => group.key).sort();
		assert.deepStrictEqual(groups, ['hooks', 'lsp', 'mcp']);
	});

	test('normalizes inline mcpServers object as installable item', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'inline-config-plugin',
						name: 'Inline Config Plugin',
						mcpServers: {
							myServer: {
								command: 'node',
								args: ['server.js']
							}
						}
					}
				]
			},
			'https://example.com/marketplace.json'
		);

		const mcpGroup = result.plugins[0].groups.find((group) => group.key === 'mcp');
		assert.ok(mcpGroup);
		assert.strictEqual(mcpGroup?.items.length, 1);
		assert.strictEqual(mcpGroup?.items[0].name, 'mcp');
		assert.ok(typeof mcpGroup?.items[0].inlineContent === 'object');
	});

	test('treats mcpServers file path as direct file metadata URL', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'file-config-plugin',
						name: 'File Config Plugin',
						mcpServers: './.mcp.json'
					}
				]
			},
			'https://example.com/marketplace.json',
			'https://raw.githubusercontent.com/org/repo/main/.github/plugin/marketplace.json'
		);

		const mcpGroup = result.plugins[0].groups.find((group) => group.key === 'mcp');
		assert.ok(mcpGroup);
		assert.strictEqual(
			mcpGroup?.items[0].metadataUrl,
			'https://raw.githubusercontent.com/org/repo/main/.mcp.json'
		);
	});

	test('returns inline group item content as formatted JSON', async () => {
		const result = await fetchGroupItemContent({
			name: 'mcp',
			metadataFallbackUrls: [],
			inlineContent: { myServer: { command: 'node' } }
		});

		assert.ok(result.content);
		assert.ok(result.content?.includes('"myServer"'));
	});

	test('adds <name>.agent.md fallback for directory-based agent entries', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'agent-plugin',
						name: 'Agent Plugin',
						agents: ['./agents/code-reviewer']
					}
				]
			},
			'https://github.com/org/repo',
			'https://raw.githubusercontent.com/org/repo/main/.claude-plugin/marketplace.json',
			{
				owner: 'org',
				repo: 'repo',
				branch: 'main',
				rawBaseUrl: 'https://raw.githubusercontent.com/org/repo/main',
				blobBaseUrl: 'https://github.com/org/repo/blob/main'
			}
		);

		const agentsGroup = result.plugins[0].groups.find((group) => group.key === 'agents');
		assert.ok(agentsGroup);
		assert.ok(agentsGroup?.items[0].metadataFallbackUrls.includes('https://raw.githubusercontent.com/org/repo/main/agents/code-reviewer/code-reviewer.agent.md'));
	});

	test('detects curated skill profile directory', () => {
		const profiles = getSupportedSkillProfileDirectories([
			{ type: 'dir', name: '.curated' },
			{ type: 'dir', name: '.system' },
			{ type: 'dir', name: 'doc' },
			{ type: 'file', name: 'README.md' }
		]);

		assert.deepStrictEqual(profiles, ['.curated']);
	});

	test('returns no supported profiles when curated is absent', () => {
		const profiles = getSupportedSkillProfileDirectories([
			{ type: 'dir', name: '.system' },
			{ type: 'dir', name: '.experimental' }
		]);

		assert.deepStrictEqual(profiles, []);
	});

	test('hydrates manifest skill directories from plugin source config', async () => {
		(vscode.authentication as typeof vscode.authentication & { getSession: typeof vscode.authentication.getSession }).getSession = (async () => undefined) as unknown as typeof vscode.authentication.getSession;

		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: input.url;

			if (url === 'https://raw.githubusercontent.com/Aaronontheweb/dotnet-skills/main/.claude-plugin/marketplace.json') {
				return new Response('not found', { status: 404, statusText: 'Not Found' });
			}

			if (url === 'https://raw.githubusercontent.com/Aaronontheweb/dotnet-skills/master/.claude-plugin/marketplace.json') {
				return new Response(JSON.stringify({
					plugins: [
						{
							name: 'dotnet-skills',
							source: './'
						}
					]
				}), { status: 200, statusText: 'OK' });
			}

			if (url === 'https://raw.githubusercontent.com/Aaronontheweb/dotnet-skills/master/.claude-plugin/plugin.json') {
				return new Response(JSON.stringify({
					name: 'dotnet-skills',
					skills: ['./skills/testcontainers', './skills/project-structure'],
					agents: ['./agents/dotnet-performance-analyst.md']
				}), { status: 200, statusText: 'OK' });
			}

			if (url === 'https://api.github.com/repos/Aaronontheweb/dotnet-skills/contents/skills/testcontainers?ref=master') {
				return new Response(JSON.stringify([
					{ type: 'file', name: 'SKILL.md', path: 'skills/testcontainers/SKILL.md' },
					{ type: 'dir', name: 'resources', path: 'skills/testcontainers/resources' }
				]), { status: 200, statusText: 'OK' });
			}

			if (url === 'https://api.github.com/repos/Aaronontheweb/dotnet-skills/contents/skills/project-structure?ref=master') {
				return new Response(JSON.stringify([
					{ type: 'file', name: 'SKILL.md', path: 'skills/project-structure/SKILL.md' }
				]), { status: 200, statusText: 'OK' });
			}

			if (url === 'https://api.github.com/repos/Aaronontheweb/dotnet-skills/contents/agents/dotnet-performance-analyst.md?ref=master') {
				return new Response(JSON.stringify({
					type: 'file',
					name: 'dotnet-performance-analyst.md',
					path: 'agents/dotnet-performance-analyst.md'
				}), { status: 200, statusText: 'OK' });
			}

			return new Response('not found', { status: 404, statusText: 'Not Found' });
		}) as typeof globalThis.fetch;

		const result = await fetchMarketplace('https://github.com/Aaronontheweb/dotnet-skills');

		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(result.plugins.length, 1);
		const skillsGroup = result.plugins[0].groups.find((group) => group.key === 'skills');
		assert.ok(skillsGroup);
		assert.deepStrictEqual(skillsGroup?.items.map((item) => item.path), [
			'skills/testcontainers',
			'skills/project-structure'
		]);
	});

	test('retries a 403 GitHub request without auth header', async () => {
		const seenAuthHeaders: Array<string | null> = [];
		(vscode.authentication as typeof vscode.authentication & { getSession: typeof vscode.authentication.getSession }).getSession = async () => ({
			id: 'session-id',
			accessToken: 'token-123',
			account: { id: 'account-id', label: 'test-user' },
			scopes: ['repo']
		});

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seenAuthHeaders.push(headers.get('authorization'));

			if (seenAuthHeaders.length === 1) {
				return new Response('forbidden', { status: 403, statusText: 'Forbidden' });
			}

			return new Response('ok', { status: 200, statusText: 'OK' });
		}) as typeof globalThis.fetch;

		const response = await fetchWithGitHubAuth('https://api.github.com/repos/example/repo/contents/file.txt');

		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(seenAuthHeaders, ['Bearer token-123', null]);
	});

	test('logs an error when the unauthenticated retry still looks rate-limited', async () => {
		const errors: string[] = [];
		initLogger({
			trace: () => undefined,
			error: (message: string) => {
				errors.push(message);
			}
		} as any);

		(vscode.authentication as typeof vscode.authentication & { getSession: typeof vscode.authentication.getSession }).getSession = async () => ({
			id: 'session-id',
			accessToken: 'token-123',
			account: { id: 'account-id', label: 'test-user' },
			scopes: ['repo']
		});

		let callCount = 0;
		globalThis.fetch = (async () => {
			callCount += 1;
			if (callCount === 1) {
				return new Response('forbidden', { status: 403, statusText: 'Forbidden' });
			}

			return new Response('API rate limit exceeded', {
				status: 403,
				statusText: 'Forbidden',
				headers: {
					'x-ratelimit-remaining': '0'
				}
			});
		}) as typeof globalThis.fetch;

		const response = await fetchWithGitHubAuth('https://api.github.com/repos/example/repo/contents/file.txt');

		assert.strictEqual(response.status, 403);
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /rate-limited/i);
	});

	test('normalizes rules group from plugin manifest', () => {
		const result = normalizeMarketplaceDocument(
			{
				plugins: [
					{
						id: 'rules-plugin',
						name: 'Rules Plugin',
						rules: './rules/',
						skills: './skills/'
					}
				]
			},
			'https://example.com/marketplace.json'
		);

		assert.strictEqual(result.errors.length, 0);
		const groups = result.plugins[0].groups.map((g) => g.key).sort();
		assert.ok(groups.includes('rules'), 'expected a rules group');
		assert.ok(groups.includes('skills'), 'expected a skills group');
	});

	test('hydrates rules group from .cursor-plugin/plugin.json', async () => {
		(vscode.authentication as typeof vscode.authentication & { getSession: typeof vscode.authentication.getSession }).getSession = (async () => undefined) as unknown as typeof vscode.authentication.getSession;

		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = typeof input === 'string'
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;

			if (url === 'https://raw.githubusercontent.com/example/cursor-plugin-repo/main/.cursor-plugin/marketplace.json') {
				return new Response(JSON.stringify({
					plugins: [{ name: 'my-cursor-plugin', source: './' }]
				}), { status: 200 });
			}

			if (url === 'https://raw.githubusercontent.com/example/cursor-plugin-repo/main/.cursor-plugin/plugin.json') {
				return new Response(JSON.stringify({
					name: 'my-cursor-plugin',
					rules: './rules/',
					skills: './skills/'
				}), { status: 200 });
			}

			if (url.includes('/api.github.com/repos/example/cursor-plugin-repo/contents/rules') ||
				url === 'https://api.github.com/repos/example/cursor-plugin-repo/contents/rules?ref=main') {
				return new Response(JSON.stringify([
					{ type: 'file', name: 'my-rule.mdc', path: 'rules/my-rule.mdc' },
					{ type: 'file', name: 'another-rule.md', path: 'rules/another-rule.md' }
				]), { status: 200 });
			}

			if (url.includes('/api.github.com/repos/example/cursor-plugin-repo/contents/skills') ||
				url === 'https://api.github.com/repos/example/cursor-plugin-repo/contents/skills?ref=main') {
				return new Response(JSON.stringify([
					{ type: 'dir', name: 'demo-skill', path: 'skills/demo-skill' }
				]), { status: 200 });
			}

			return new Response('not found', { status: 404 });
		}) as typeof globalThis.fetch;

		const result = await fetchMarketplace('https://raw.githubusercontent.com/example/cursor-plugin-repo/main/.cursor-plugin/marketplace.json');

		assert.strictEqual(result.errors.length, 0);
		assert.strictEqual(result.plugins.length, 1);

		const rulesGroup = result.plugins[0].groups.find((g) => g.key === 'rules');
		assert.ok(rulesGroup, 'expected a rules group after hydration');
		const ruleNames = rulesGroup?.items.map((i) => i.name) ?? [];
		assert.ok(ruleNames.includes('my-rule.mdc'), 'expected .mdc rule file item');
		assert.ok(ruleNames.includes('another-rule.md'), 'expected .md rule file item');
	});

	test('resolveWorkspaceComponentRoots returns .cursor paths for Cursor host', () => {
		const roots = resolveWorkspaceComponentRoots('/workspace/my-repo', 'my-plugin', 'cursor');
		assert.ok(roots.skillsRoot.includes('.cursor'), 'skillsRoot should be under .cursor');
		assert.ok(roots.skillsRoot.includes('my-plugin'), 'skillsRoot should include plugin id');
		assert.ok(roots.rulesRoot.includes('.cursor'), 'rulesRoot should be under .cursor');
		assert.ok(roots.agentsRoot.includes('.cursor'), 'agentsRoot should be under .cursor');
		assert.ok(roots.hooksRoot.includes('.cursor'), 'hooksRoot should be under .cursor');
		assert.ok(roots.mcpRoot.includes('.cursor'), 'mcpRoot should be under .cursor');
		assert.ok(roots.lspRoot.includes('.cursor'), 'lspRoot should be under .cursor');
		assert.ok(roots.commandsRoot.includes('.cursor'), 'commandsRoot should be under .cursor');
		assert.ok(roots.toolsRoot.includes('.cursor'), 'toolsRoot should be under .cursor');
		assert.ok(roots.promptsRoot.includes('.cursor'), 'promptsRoot should be under .cursor');
		assert.ok(roots.workflowsRoot.includes('.cursor'), 'workflowsRoot should be under .cursor');
	});

	test('resolveWorkspaceComponentRoots returns legacy paths for vscode host', () => {
		const roots = resolveWorkspaceComponentRoots('/workspace/my-repo', 'my-plugin', 'vscode');
		assert.ok(roots.skillsRoot.includes('.agents'), 'skillsRoot should be under .agents on legacy host');
		assert.ok(roots.agentsRoot.includes('.github'), 'agentsRoot should be under .github on legacy host');
		assert.ok(roots.hooksRoot.includes('.github'), 'hooksRoot should be under .github on legacy host');
		assert.ok(roots.commandsRoot.includes('.github'), 'commandsRoot should be under .github on legacy host');
		assert.ok(roots.toolsRoot.includes('.github'), 'toolsRoot should be under .github on legacy host');
		assert.ok(roots.promptsRoot.includes('.github'), 'promptsRoot should be under .github on legacy host');
		assert.ok(roots.workflowsRoot.includes('.github'), 'workflowsRoot should be under .github on legacy host');
		assert.strictEqual(roots.rulesRoot, '', 'rulesRoot should be empty on legacy host');
	});

	test('resolveUserInstallRoot returns ~/.cursor/plugins/local for Cursor', () => {
		const root = resolveUserInstallRoot('cursor');
		assert.ok(root.includes('.cursor'), 'user root should be under .cursor for Cursor');
		assert.ok(root.includes('plugins'), 'user root should include plugins directory');
	});

	test('resolveUserInstallRoot returns ~/.copilot/installed-plugins for legacy', () => {
		const root = resolveUserInstallRoot('vscode');
		assert.ok(root.includes('.copilot'), 'user root should be under .copilot for legacy host');
	});
});
