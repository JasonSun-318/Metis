# Quickstart

This page gets you from a source checkout to a useful first metis session.

## Install

`@metis/coding-agent` is not published on npm. Node.js 22.19 or newer is required. Clone https://gitee.com/sun124578963_0/metis.git, then run these commands from the repository root:

```bash
npm ci --ignore-scripts
./metis-test.sh
```

`npm ci --ignore-scripts` installs the locked dependencies and skips package lifecycle scripts. `./metis-test.sh` starts the CLI from source. There is no global `metis` binary. Commands on this page that show `metis` take the same arguments when passed to `./metis-test.sh`.

Invoke the script by path when the project you want to work on is not the Metis checkout. Metis keeps that working directory:

```bash
cd /path/to/project
/path/to/metis/metis-test.sh
```

Deleting the checkout does not remove settings, credentials, sessions, or installed metis packages in `~/.metis/agent/`.

## Authenticate

Metis uses API keys supplied through environment variables or the auth file.

### Option 1: interactive API-key setup

Start metis and run:

```text
/login
```

Then select a provider and enter its API key. Metis stores it in `~/.metis/agent/auth.json`.

### Option 2: environment variable

Set an API key before launching metis:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./metis-test.sh
```

You can also run `/login` and select an API-key provider to store the key in `~/.metis/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

### Optional: enable web search

`web_search` is built in but disabled by default. Run `/settings`, open **Web search**, select Brave Search, Tavily, or SerpApi, and enter the provider's API key in the masked prompt.

Only one search provider is selected at a time, and the model receives `web_search` only while the global setting is enabled. Search returns URLs and result metadata; `web_fetch` retrieves a selected page as Markdown.

## First session

Once metis starts, type a request and press Enter:

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
- `set_tasks` - show the current checklist for complex multi-step work

Additional built-in read-only tools (`find`, `ls`, and opt-in `web_search`) are available through tool options and settings. Metis runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give metis project instructions

Metis loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Metis loads:

- `~/.metis/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart metis, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
metis @README.md "Summarize this"
metis @src/app.ts @src/app.test.ts "Review these together"
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
metis -c                  # Continue most recent session
metis -r                  # Browse previous sessions
metis --name "my task"    # Set session display name at startup
metis --session <path|id> # Open a specific session
```

Inside metis, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
metis -p "Summarize this codebase"
cat README.md | metis -p "Summarize this text"
metis -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Metis](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Metis Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
