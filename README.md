# wherdr

**Upgrading to 2.0.0?** Read the [release notes](docs/release-notes-2.0.0.md) for breaking changes and the 1.x migration checklist.

wherdr is an unofficial, self-hosted web client for [Herdr](https://herdr.dev).
Start coding agents on your computer, follow their work and reply from your phone or browser.
It uses the same Herdr session, with live conversations, real terminals and a herdr-projects Board.

<p align="center">
  <img src="assets/wherdr-readme.webp" width="720" alt="Animated demonstration of the current wherdr interface: launch an agent on desktop, continue on a phone, approve its request, view project tasks and open the Board. Real app, fictional demo data.">
</p>

[Try the demo](https://wherdr.dev/demo/) · [Website](https://wherdr.dev) · [Launch film](assets/wherdr-launch.mp4)

## Quick start

On the Linux or macOS computer running **Herdr ≥ 0.9.1**, run:

```sh
curl -fsSL https://wherdr.dev/install | sh
```

The installer checks prerequisites, offers Node.js 22 if needed, installs the Herdr plugin
and starts wherdr as your user at **http://localhost:7683**. It also configures automatic
startup: at login on macOS; at boot on Linux with lingering enabled, otherwise at login. The installer reports which case applies.
Open that address, or press **prefix+i** in Herdr, to follow the setup guide: agents, phone access
through Tailscale, optional passkey lock and notifications. See [first launch](docs/quick-start.md).

Prefer help from your coding agent? Paste:

```text
Read https://wherdr.dev/agent.md and help me set up wherdr. Check what is already installed first, and ask me before installing anything.
```

**wherdr is a remote shell as your user.** Keep it on localhost or a private network such as
Tailscale; never expose it to the public Internet. Read [Security](docs/security.md) before remote access.

## Documentation

- **[Overview and architecture](docs/overview.md)** — What wherdr does, why it exists and how it connects to Herdr. Includes the launch film and license.
- **[First launch](docs/quick-start.md)** — Install the native service and follow the setup guide. Includes the desktop, Board and phone screenshots.
- **[Home and agent list](docs/home.md)** — Find agents, create a session and filter machines or projects. Covers compact rows and state grouping.
- **[Conversation and replies](docs/conversation.md)** — Read transcripts, answer questions, attach files and manage drafts. Includes quoted replies and decision tables.
- **[Terminal](docs/terminal.md)** — Use the real terminal, copy text, open links and paste images. Explains take-over and size restoration.
- **[Files and changes](docs/files.md)** — Review Git changes and comment on lines or blocks. Compose a review for the agent.
- **[Computer, phone and iPad](docs/devices.md)** — Use split panes, keyboard shortcuts and touch controls. Describes device-specific layouts.
- **[Installation and updates](docs/installation.md)** — Requirements, native installer, agent PATH, updates and migration from Docker.
- **[Migrate from a 1.x Docker install](docs/migrate-from-1.x-docker.md)** — Move a wherdr 1.x container to the native 2.0 service, keeping its port, passkeys and data. Written so an AI agent can run it step by step.
- **[Phone access and private networks](docs/networks.md)** — Set up Tailscale or another private network with HTTPS. Includes always-on servers and keep-awake.
- **[The wherdr command](docs/command.md)** — Install through npm or Homebrew and manage the native service from the command line.
- **[Herdr plugins](docs/plugins.md)** — Install and configure the wherdr plugin, its panel key and plugin actions.
- **[Install as an app](docs/phone.md)** — Add wherdr to your home screen on a phone or install it in a desktop browser.
- **[Settings and configuration](docs/configuration.md)** — Configure the service through environment variables and the app through shared and device-specific preferences.
- **[Machines and SSH](docs/machines.md)** — Register remote machines and use their agents through SSH. Includes sessions and connection troubleshooting.
- **[Claude and Codex quotas](docs/quotas.md)** — Show remaining usage and handle Codex updates, limits and restarts.
- **[Notifications](docs/notifications.md)** — Enable Web Push, relay Herdr notifications and configure Do not disturb.
- **[Board and coordinators](docs/board.md)** — Work with herdr-projects tasks, reviews, approvals and coordinators across machines.
- **[Board with beads](docs/beads.md)** — Run the Board on [beads](https://github.com/steveyegge/beads) issues instead of herdr-projects, and start agents on them.
- **[Security](docs/security.md)** — Understand remote-shell access, passkeys and network restrictions. Read this before enabling remote access.
- **[Development and tests](docs/development.md)** — Run from source and follow the contribution and agent test rules.
- **[Troubleshooting](docs/troubleshooting.md)** — Resolve startup, permissions, network, SSH and conversation problems.

[All documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

Unofficial project; not affiliated with or endorsed by Herdr, Anthropic or OpenAI.
