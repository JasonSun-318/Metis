# Quickstart

This page gets you from install to a useful first arcmind session.

## Install

ArcMind is distributed as an npm package:

```bash
npm install -g --ignore-scripts @arcmind/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. ArcMind does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed arcmind. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @arcmind/coding-agent

# pnpm
pnpm remove -g @arcmind/coding-agent

# Yarn
yarn global remove @arcmind/coding-agent

# Bun
bun uninstall -g @arcmind/coding-agent
```

Uninstalling arcmind leaves settings, credentials, sessions, and installed arcmind packages in `~/.arcmind/agent/`.

Then start arcmind in the directory or workspace you want it to work on:

```bash
cd /path/to/project
arcmind
```

## Authenticate

ArcMind uses API keys supplied through environment variables or the auth file.

### Option 1: interactive API-key setup

Start arcmind and run:

```text
/login
```

Then select a provider and enter its API key. ArcMind stores it in `~/.arcmind/agent/auth.json`.

### Option 2: environment variable

Set an API key before launching arcmind:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
arcmind
```

You can also run `/login` and select an API-key provider to store the key in `~/.arcmind/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

### Optional: enable web search

`web_search` is built in but disabled by default. Run `/settings`, enable **Web search**, and select Brave Search, Tavily, or SerpApi. Then store the selected provider's API key:

```text
/login web-search:brave
/login web-search:tavily
/login web-search:serpapi
```

Only one search provider is selected at a time, and the model receives `web_search` only while the global setting is enabled. Search returns URLs and result metadata; `web_fetch` retrieves a selected page as Markdown.

## First session

Once arcmind starts, type a request and press Enter:

```text
Review this workspace and summarize its purpose, contents, and important next steps.
```

By default, a primary session gives the model seven tools:

- `read` - read files
- `grep` - search file contents with bounded output
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands
- `web_fetch` - fetch an HTTP(S) URL as Markdown
- `update_plan` - track progress on complex multi-step work

Additional built-in read-only tools (`find`, `ls`, and opt-in `web_search`) are available through tool options and settings. ArcMind runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give arcmind project instructions

ArcMind loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

ArcMind loads:

- `~/.arcmind/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart arcmind, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
arcmind @README.md "Summarize this"
arcmind @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
arcmind -c                  # Continue most recent session
arcmind -r                  # Browse previous sessions
arcmind --name "my task"    # Set session display name at startup
arcmind --session <path|id> # Open a specific session
```

Inside arcmind, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
arcmind -p "Summarize this codebase"
cat README.md | arcmind -p "Summarize this text"
arcmind -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using ArcMind](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [ArcMind Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
