# Using Metis

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected message |
| Attachments | Paste an image or local file with Ctrl+V (Alt+V on Windows), or drag a file into the terminal; files display as `[filename]` |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage model and web-search OAuth/API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Web search, thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new [chat\|code]` | Create a session and choose its immutable primary workspace |
| `/permissions` | Choose Ask, Auto, or Full for this session |
| `/add-dir <path>` | Code only: add one existing directory as a file-access root for this session |
| `/remove-dir <path>` | Code only: remove one previously added directory |
| `/dirs` | Code only: list the primary and additional working directories |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, mode, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/memory [on\|off\|use on\|off\|contribute on\|off\|undo [id]\|undo-run <runId>\|dream]` | Long-term memory status, toggles, undo, and Dream — see [Memory](memory.md) |
| `/reload` | Reload resources, context files, and memory |
| `/hotkeys` | Show all keyboard shortcuts |
| `/quit` | Quit metis |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want metis to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.metis/agent/sessions/`, organized by working directory.

```bash
metis -c                  # Continue most recent session
metis -r                  # Browse and select a session
metis --no-session        # Ephemeral mode; do not save
metis --name "my task"    # Set session display name at startup
metis --session <path|id> # Use a specific session file or session ID
metis --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Long-Term Memory

Long-term memory is separate from session JSONL and compaction summaries. Markdown files in the vault are the source of truth; search indexes are in-memory derivatives:

```text
~/.metis/agent/memory/
├── global/
│   ├── MEMORY.md           # link-only index
│   ├── _pinned/            # high-frequency standing context (user, feedback)
│   └── notes/              # one file per note
├── projects/<projectKey>/
│   ├── MEMORY.md
│   ├── _pinned/            # project, active
│   ├── notes/
│   └── .project.json
├── .history/               # per-write snapshots for undo
├── .dream/
└── .meta/
```

- The project scope key derives from the nearest git root (worktrees included) or the canonical cwd when no `.git` exists. Chat and Code share the same project scope.
- At session start, metis injects one frozen snapshot of the pinned blocks and `MEMORY.md` indexes. The snapshot is re-read only after compaction, `/reload`, or a `/memory` toggle — never per turn.
- The agent reaches the rest of the vault through the `memory_search`, `memory_read`, and `memory_write` tools; results arrive as ordinary tool results. `memory_search` uses in-memory BM25 — no embedding or rerank models are configured or required.
- `memory_write` is the only supported way to modify the vault. Ordinary write/edit/Bash access to the memory directory is rejected; reads are limited to the global scope and the current project scope. Writes are journaled to `.history/` snapshots and journaled changes can be reverted with `/memory undo [id]` or the undo support on `memory_write` results. A whole Dream run rolls back with `/memory undo-run <runId>`.
- Deleting sessions or a mode-specific project does not delete the vault. Export and import do not copy it.
- Memory is untrusted reference data; secrets, transient state, and raw tool output are never recorded.

Use `/memory` for on/off state, scope directories, and recent changes. `/memory on|off` toggles memory for new work immediately. See [Memory](memory.md) for the vault layout, note format, tools, undo, and Dream consolidation.

## Context Files

Metis loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.metis/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.metis/SYSTEM.md` for a project
- `~/.metis/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, metis asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.metis/agent/trust.json`. Trusting a project allows metis to load `.metis/settings.json` and `.metis` resources, install missing project packages, and execute project extensions.

Before the trust decision, metis loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.metis/agent/settings.json`, or change it with `/settings`.

`metis config` and package commands use the same project trust flow, except `metis update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.metis/agent/trust.json` only; the current session is not reloaded, so restart metis for changes to take effect.


## Exporting Sessions

Use `/export [file]` to write a session to HTML.

## CLI Reference

```bash
metis [options] [@files...] [messages...]
```

### Package Commands

```bash
metis install <source> [-l]     # Install package, -l for project-local
metis remove <source> [-l]      # Remove package
metis uninstall <source> [-l]   # Alias for remove
metis update [source|self|metis]   # Update metis only, or one package source
metis update --all              # Update metis and packages; reconcile pinned git refs
metis update --extensions       # Update packages only; reconcile pinned git refs
metis update --self             # Update metis only
metis update --extension <src>  # Update one package
metis list                      # List installed packages
metis config                    # Enable/disable package resources
```

These commands manage metis packages and `metis update` can update the metis CLI installation. To uninstall metis itself, see [Quickstart](quickstart.md#uninstall). `metis config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `metis update` never prompts for project trust.

See [Metis Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, metis also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | metis -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `--agent-mode <chat\|code>` | Classify a newly created session (default: `code`) |
| `--cwd <path>` | Bind a newly created session to an existing directory |
| `--permission-mode <ask\|auto\|full>` | Set permissions for a newly created session (default: Auto) |
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web_fetch`, `web_search`, `set_tasks`.

`web_fetch` is enabled by default and converts HTTP(S) pages to Markdown. Redirects that change the host or port require another `web_fetch` call so the new network target receives its own permission decision. `set_tasks` is enabled by default for primary sessions and is intended only for complex multi-step work. Each call replaces the complete visible list with `{ task, completed }` items; multiple items may remain incomplete, and `[]` clears the list. Tool allowlists, exclusions, `--no-builtin-tools`, and `--no-tools` apply normally.

`web_search` is disabled by default. Open **Web search** in `/settings`, choose a provider, and enter its API key in the masked prompt. Project settings cannot enable or switch this global paid-service choice. `/login web-search:<provider>` remains available for compatibility. The model-facing contract is:

```ts
web_search({ query: string, type?: "web" | "images", limit?: number })

type WebOutput = { type: "web"; results: Array<{ title: string; url: string; snippet?: string }> };
type ImageOutput = { type: "images"; results: Array<{ url: string; title?: string; sourceUrl?: string }> };
```

Search returns metadata and URLs; use `web_fetch` to retrieve a selected page as Markdown. Images are not downloaded, and returned image URLs may expire or reject hotlinking. Tavily's image mode returns images related to its search response rather than a dedicated image-only index, so it generally has no `sourceUrl`.

When either web tool returns more than 50,000 characters, Metis immediately saves the full text under the session's `tool-results` directory and keeps a preview plus the file path in active model context. Press Ctrl+O to expand or collapse the visible TUI result.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
metis --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
metis @prompt.md "Answer this"
metis -p @screenshot.png "What's in this image?"
metis @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
metis "List all .ts files in src/"

# Non-interactive
metis -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | metis -p "Summarize this text"

# Named one-shot session
metis --name "release audit" -p "Audit this repository"

# Different model
metis --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
metis --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
metis --model sonnet:high "Solve this complex problem"

# Limit model cycling
metis --models "claude-*,gpt-4o"

# Read-only mode
metis --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
metis --exclude-tools ask_question
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `METIS_CODING_AGENT_DIR` | Override config directory; default is `~/.metis/agent` |
| `METIS_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `METIS_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `METIS_OFFLINE` | Disable startup network operations, including package update checks |
| `METIS_PROVIDER_ATTRIBUTION` | Enable Metis attribution headers for supported model providers with `1`/`true`/`yes` |
| `METIS_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

## Design Principles

Metis keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It intentionally does not include built-in MCP, a separate plan mode, a manual to-do manager, or background bash. The core `set_tasks` tool only publishes the current visible checklist for complex work. Persisted primary Code sessions have [first-class Agents](subagents.md) at every thinking level. Auto is the default; Ask prompts more often, and both sandbox ordinary model-initiated Bash. Full skips approval and runs on the host. See [Permissions](permissions.md).
