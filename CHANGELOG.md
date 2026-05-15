# Change Log

All notable changes to this extension will be documented in this file.

This repository is a fork of [timheuer/vscode-agent-plugins](https://github.com/timheuer/vscode-agent-plugins). Entries under **[Unreleased]** describe behavior and packaging **added or changed in this fork** compared to that upstream project (as of upstream `main` through _Fix cache refresh and skill relative discovery_).

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.1]

### Added

- **Cursor host profile** — Detects when the app is Cursor (`vscode.env.appName`) and installs accordingly: workspace components under `.cursor/{skills,rules,agents,hooks,mcp,lsp,commands,tools,prompts,workflows}/<plugin-id>/`, and user-scope plugins under `~/.cursor/plugins/local/` so Cursor can load third-party marketplace content like locally installed plugins.
- **Non-GitHub marketplace sources** — Resolves and fetches marketplaces from generic HTTPS git repository URLs (for example Azure DevOps), `git://` URLs, and `git@host:...` SSH-style entries; settings pattern and marketplace/delegation logic extended beyond GitHub-only flows.
- **`src/features/ide-host.ts`** — Centralized install-root resolution for Cursor vs legacy (VS Code) layouts and tests covering those paths.
- **`src/features/git-clone.ts`** — Support for cloning or working with non-GitHub-hosted plugin repositories where upstream assumed GitHub-only fetch paths.
- **Open VSX publishing** — `deploy:openvsx` / `package:vsix` scripts and CI step to publish the packaged VSIX to the Open VSX Registry (alongside existing VS Marketplace packaging in workflow).
- **Tests** — Additional extension tests for install-path helpers and related behavior.

### Changed

- **Extension identity and metadata** — Package renamed to `agent-plugins-installer`, display name _Agent Plugins Installer_, publisher `smhc`, repository and issue URLs point to [smhc/cursor-agent-plugins](https://github.com/smhc/cursor-agent-plugins); contributor metadata added. Minimum VS Code engine aligned to `^1.105.0` in this fork (upstream remains `^1.109.0`).
- **Install UX** — Install confirmation removed; marketplace tree and install flow refined (including clearer marketplace labels from `marketplace.json` name/title or derived URL labels).
- **Cache** — Persistence behavior adjusted with limits to avoid unbounded cache growth.
- **Contributed UI** — Activity bar navigation: browse command gets a toolbar icon; GitHub sign-in vs browse ordering in the view title area updated; `onView` activation for the marketplace explorer added.
- **Documentation** — README expanded for non-GitHub URLs, Cursor vs VS Code install targets, `~/.cursor/plugins/local` for user installs, and guidance on workspace installs and `.gitignore` for third-party marketplaces.
