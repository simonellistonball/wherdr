# Documentation

**Updating to 2.5.0?** Read the [2.5.0 release notes](release-notes-2.5.0.md) for phone key ordering, push delivery results, the English-only interface and cross-machine recovery fixes.

**Updating to 2.4.0?** Read the [2.4.0 release notes](release-notes-2.4.0.md) for Shepherdr 2 protection, Board search, terminal controls and wake reconnection fixes.

**Updating to 2.3.0?** Read the [2.3.0 release notes](release-notes-2.3.0.md) for grouped worktrees, project headers, notification menus and agent naming fixes.

**Updating to 2.2.0?** Read the [2.2.0 release notes](release-notes-2.2.0.md) for task types, plan approval, faster conversation opening and paste fixes.

**Updating to 2.1.0?** Read the [2.1.0 release notes](release-notes-2.1.0.md) for new task controls, Board improvements and fixes.

**Upgrading to 2.0.0?** Read the [release notes](release-notes-2.0.0.md) for breaking changes and the 1.x migration checklist.

Read only the page relevant to your task. Start with [Installation and updates](installation.md) for setup,
[Security](security.md) for remote access, or [Development and tests](development.md) for repository changes.

- [Overview and architecture](overview.md) — What wherdr does, why it exists and how it connects to Herdr. Includes the launch film and license.
- [First launch](quick-start.md) — Install the native service and follow the setup guide. Includes the desktop, Board and phone screenshots.
- [Home and agent list](home.md) — Find agents, create a session and filter machines or projects. Covers compact rows and state grouping.
- [Conversation and replies](conversation.md) — Read transcripts, answer questions, attach files and manage drafts. Includes quoted replies and decision tables.
- [Terminal](terminal.md) — Use the real terminal, copy text, open links and paste images. Explains take-over and size restoration.
- [Files and changes](files.md) — Review Git changes and comment on lines or blocks. Compose a review for the agent.
- [Computer, phone and iPad](devices.md) — Use split panes, keyboard shortcuts and touch controls. Describes device-specific layouts.
- [Installation and updates](installation.md) — Requirements, native installer, agent PATH, updates and migration from Docker.
- [Phone access and private networks](networks.md) — Set up Tailscale or another private network with HTTPS. Includes always-on servers and keep-awake.
- [The wherdr command](command.md) — Install through npm or Homebrew and manage the native service from the command line.
- [Herdr plugins](plugins.md) — Install and configure the wherdr plugin, its panel key and plugin actions.
- [Install as an app](phone.md) — Add wherdr to your home screen on a phone or install it in a desktop browser.
- [Settings and configuration](configuration.md) — Configure the service through environment variables and the app through shared and device-specific preferences.
- [Board with beads](beads.md) — Run the Board on beads issues instead of herdr-projects: hub and per-repo databases, columns and Start.
- [Machines and SSH](machines.md) — Register remote machines and use their agents through SSH. Includes sessions and connection troubleshooting.
- [Claude and Codex quotas](quotas.md) — Show remaining usage and handle Codex updates, limits and restarts.
- [Notifications](notifications.md) — Enable Web Push, relay Herdr notifications and configure Do not disturb.
- [Board and coordinators](board.md) — Work with herdr-projects tasks, reviews, approvals and coordinators across machines.
- [Security](security.md) — Understand remote-shell access, passkeys and network restrictions. Read this before enabling remote access.
- [Design rules](design.md) — The single reference for interface styling, state indicators, controls and responsive checks.
- [Development and tests](development.md) — Run from source and follow the contribution and agent test rules.
- [Troubleshooting](troubleshooting.md) — Resolve startup, permissions, network, SSH and conversation problems.

Also see [herdr-projects 1.x migration](herdr-projects-1x.md), [Releasing](RELEASING.md),
[keyboard shortcut specification](product/keyboard-shortcuts.md) and [Contributing](../CONTRIBUTING.md).

## Section reference

- [Quick start](quick-start.md#quick-start)
- [Why wherdr](overview.md#why-wherdr)
- [Features](home.md#features)
- [How it works](overview.md#how-it-works)
- [Requirements](installation.md#requirements)
- [Installation](installation.md#installation): [ask your AI agent](installation.md#ask-your-ai-agent) ·
  [or run the installer yourself](installation.md#the-one-command) ·
  [which setup?](installation.md#which-setup) ·
  [always-on server + Tailscale](networks.md#recommended-always-on-server--tailscale) ·
  [other private networks](networks.md#other-private-networks) ·
  [as a Herdr plugin](plugins.md#install-as-a-herdr-plugin) ·
  [the `wherdr` command (npm, Homebrew)](command.md#the-wherdr-command) ·
  [from source](development.md#from-source) ·
  [moving from Docker to the native service](migrate-from-1.x-docker.md)
- [Updating](installation.md#updating)
- [Install it as an app](phone.md#install-it-as-an-app)
- [Configuration](configuration.md#configuration)
- [Several machines (SSH)](machines.md#several-machines-ssh)
- [Claude and Codex quotas](quotas.md#claude-and-codex-quotas)
- [Notifications](notifications.md#notifications)
- [Works great with herdr-projects](board.md#works-great-with-herdr-projects)
- [Herdr plugins](plugins.md#herdr-plugins)
- [Security](security.md#security)
- [Troubleshooting](troubleshooting.md#troubleshooting)
- [Contributing](development.md#contributing) · [License](overview.md#license)
