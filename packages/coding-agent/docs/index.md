# Metis Documentation

Metis is a minimal general-purpose terminal agent. It is designed to stay small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, and metis packages.

## Quick start

Install Metis with npm:

```bash
npm install -g --ignore-scripts @metis/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Metis does not require install scripts for normal npm installs.

On Linux or macOS, you can also use the installer:

```bash
curl -fsSL https://gitee.com/sun124578963_0/metis/install.sh | sh
```

To uninstall metis itself, use npm for curl and npm installs:

```bash
npm uninstall -g @metis/coding-agent
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @metis/coding-agent`, `yarn global remove @metis/coding-agent`, or `bun uninstall -g @metis/coding-agent`.

Then run it in a project directory:

```bash
metis
```

Store an API key with `/login`, or set one such as `ANTHROPIC_API_KEY` before starting metis.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Metis](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](providers.md) - API-key setup for built-in providers.
- [Security](security.md) - project trust, action permissions, external isolation, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox metis with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Ultra and Subagents](subagents.md) - highest model reasoning plus recoverable multi-agent orchestration.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Metis packages](packages.md) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed metis in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
