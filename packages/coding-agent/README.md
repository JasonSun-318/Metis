ArcMind is a minimal general-purpose terminal agent. Adapt ArcMind to your workflows without modifying its internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes).

ArcMind ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask arcmind to build what you want or install a third party arcmind package that matches your workflow.

ArcMind runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps. See [openclaw/openclaw](https://github.com/openclaw/openclaw) for a real-world SDK integration.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [ArcMind Packages](#arcmind-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g --ignore-scripts @arcmind/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. ArcMind does not require install scripts for normal npm installs.

Installer alternative:

```bash
curl -fsSL https://gitee.com/sun124578963_0/arc-mind/install.sh | sh
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
arcmind
```

Or store an API key interactively:

```bash
arcmind
/login  # Then select an API-key provider
```

Then just talk to arcmind. By default, arcmind gives the model five tools: `read`, `grep`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [arcmind packages](#arcmind-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, arcmind maintains a list of tool-capable models, updated with every release. Store an API key with `/login` or provide it through the environment, then select any model from that provider via `/model` (or Ctrl+L).

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**Custom providers & models:** Add providers via `~/.arcmind/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage (`↑` input, `↓` output, `R` cache read, `W` cache write, `CH` latest cache hit rate), cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |
| Clipboard | Ctrl+V to paste an image or text (Alt+V on Windows), or drag images onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Store or remove provider API keys |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| [`/new [chat\|code]`](docs/sessions.md#chat-and-code-modes) | Create a session and choose its immutable workspace |
| [`/permissions`](docs/permissions.md) | Choose Ask, Auto with review, or Full for this session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, mode, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions (restart required) |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL file |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/memory [on\|off]` | Show or toggle long-term memory |
| `/dream` | Show Dream status and the latest 10 memory-maintenance runs |
| `/reload` | Reload resources, context files, and memory |
| `/hotkeys` | Show all keyboard shortcuts |
| `/quit` | Quit arcmind |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.arcmind/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |
| Ctrl+X | Copy the last assistant message |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so arcmind can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.arcmind/agent/sessions/` organized by working directory.

```bash
arcmind -c                  # Continue most recent session
arcmind -r                  # Browse and select from past sessions
arcmind --no-session        # Ephemeral mode (don't save)
arcmind --name "my task"    # Set session display name at startup
arcmind --session <path|id> # Use specific session file or ID
arcmind --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Ctrl+X to copy the selected message
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Long-Term Memory

ArcMind keeps long-term memory outside session JSONL files. `~/.arcmind/agent/memory/MEMORY.md` is the global index. Each exact working directory gets a separate `memory/projects/--<cwd>--/project.md` index, so sessions, forks, and tree branches in the same directory share project memory without relying on Git.

The first 200 lines or 25KB of each index are loaded into the system prompt. Detailed notes belong in linked topic files and are read on demand. Use `/memory` to inspect paths, `/memory off` to disable injection, and `/reload` after editing an index outside ArcMind. Memory is not exported with or deleted alongside session JSONL files.

Dream runs silently alongside manual and automatic context compaction when long-term memory is enabled. It reconciles only global memory and the project memory for the current working directory. Ordinary messages and images stay queued until Compact and Dream both settle.

`/dream` is read-only and remains available while Dream is running. It shows live state and the latest 10 metadata-only records from `~/.arcmind/agent/memory/dream-history.jsonl`; it never starts Dream manually.

While Compact/Dream runs, Shell commands, extension commands, and built-ins that mutate model, settings, authentication, sessions, imports, exports, or memory are rejected and left in the editor. `/copy`, `/session`, `/hotkeys`, `/memory`, `/dream`, `/quit`, `/debug`, Escape, and display-only shortcuts remain available.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.arcmind/agent/settings.json` | Global (all projects) |
| `.arcmind/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

On interactive startup, arcmind asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.arcmind/agent/trust.json`. Trusting a project allows arcmind to load `.arcmind/settings.json` and `.arcmind` resources, install missing project packages, and execute project extensions.

Before the trust decision, arcmind loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.arcmind/agent/settings.json`, or change it with `/settings`.

`arcmind config` and package commands use the same project trust flow, except `arcmind update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.arcmind/agent/trust.json` only; the current session is not reloaded, so restart arcmind for changes to take effect.

### Network behavior

ArcMind does not perform version checks or install telemetry. Package update checks only apply to packages you install. Optional provider attribution headers are disabled by default and can be enabled with `enableProviderAttribution` or `ARCMIND_PROVIDER_ATTRIBUTION=1`.

---

## Context Files

ArcMind loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.arcmind/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.arcmind/SYSTEM.md` (project) or `~/.arcmind/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.arcmind/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.arcmind/agent/prompts/`, `.arcmind/prompts/`, or a [arcmind package](#arcmind-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.arcmind/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.arcmind/agent/skills/`, `~/.agents/skills/`, `.arcmind/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [arcmind package](#arcmind-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend arcmind with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (arcmind: ExtensionAPI) {
  arcmind.registerTool({ name: "deploy", ... });
  arcmind.registerCommand("stats", { ... });
  arcmind.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. arcmind waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `arcmind.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make arcmind look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.arcmind/agent/extensions/`, `.arcmind/extensions/`, or a [arcmind package](#arcmind-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and arcmind immediately applies changes.

Place in `~/.arcmind/agent/themes/`, `.arcmind/themes/`, or a [arcmind package](#arcmind-packages) to share with others. See [docs/themes.md](docs/themes.md).

### ArcMind Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** ArcMind packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
arcmind install npm:@foo/arcmind-tools
arcmind install npm:@foo/arcmind-tools@1.2.3      # pinned version
arcmind install git:github.com/user/repo
arcmind install git:github.com/user/repo@v1  # tag or commit
arcmind install git:git@github.com:user/repo
arcmind install git:git@github.com:user/repo@v1  # tag or commit
arcmind install https://github.com/user/repo
arcmind install https://github.com/user/repo@v1      # tag or commit
arcmind install ssh://git@github.com/user/repo
arcmind install ssh://git@github.com/user/repo@v1    # tag or commit
arcmind remove npm:@foo/arcmind-tools
arcmind uninstall npm:@foo/arcmind-tools          # alias for remove
arcmind list
arcmind update                               # update arcmind only
arcmind update --all                         # update arcmind and packages
arcmind update --extensions                  # update packages only
arcmind update --self                        # update arcmind only
arcmind update --self --force                # reinstall arcmind even if current
arcmind update npm:@foo/arcmind-tools             # update one package
arcmind config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.arcmind/agent/git/` (git) or `~/.arcmind/agent/npm/` (npm). Use `-l` for project-local installs (`.arcmind/git/`, `.arcmind/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `arcmind update --extensions` and `arcmind update --all`, so use `arcmind install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `arcmind` key to `package.json`:

```json
{
  "name": "my-arcmind-package",
  "keywords": ["arcmind-package"],
  "arcmind": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `arcmind` manifest, arcmind auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@arcmind/coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
arcmind --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

ArcMind is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [arcmind packages](#arcmind-packages). This keeps the core minimal while letting you shape arcmind to fit how you work.

**MCP:** Run `/mcp` to add and authenticate trusted stdio or Streamable HTTP servers without editing JSON. ArcMind supports token-backed authentication, resources, prompts, permission-aware calls, and Codex-style lazy tool discovery. See [docs/mcp.md](docs/mcp.md).

**Explicit multi-agent tier.** Persisted Chat and Code sessions can select Ultra for maximum model reasoning plus recoverable first-class subagents. The process-spawning extension remains available for custom isolation and chained workflows. See [Ultra and Subagents](docs/subagents.md).

**Explicit permission boundary.** Ask and Auto use one-shot approvals and SRT for model-initiated local processes; Full is an explicit unsandboxed mode. Installed extension code remains trusted. See [Permissions and Sandbox](docs/permissions.md).

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

---

## CLI Reference

```bash
arcmind [options] [@files...] [messages...]
```

### Package Commands

```bash
arcmind install <source> [-l]     # Install package, -l for project-local
arcmind remove <source> [-l]      # Remove package
arcmind uninstall <source> [-l]   # Alias for remove
arcmind update [source|self|arcmind]   # Update arcmind only, or one package source
arcmind update --all              # Update arcmind and packages
arcmind update --extensions       # Update packages only
arcmind update --self             # Update arcmind only
arcmind update --self --force     # Reinstall arcmind even if current
arcmind update --extension <src>  # Update one package
arcmind list                      # List installed packages
arcmind config                    # Enable/disable package resources
```

`arcmind config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `arcmind update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, arcmind also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | arcmind -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `--agent-mode <chat\|code>` | Classify a newly created session (default: `code`) |
| `--cwd <path>` | Bind a newly created session to an existing directory |
| `--permission-mode <ask\|auto\|full>` | Set permissions for a newly created session |
| `--reviewer`, `--no-reviewer` | Enable or disable Auto review for a newly created session |
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
arcmind @prompt.md "Answer this"
arcmind -p @screenshot.png "What's in this image?"
arcmind @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
arcmind "List all .ts files in src/"

# Non-interactive
arcmind -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | arcmind -p "Summarize this text"

# Named one-shot session
arcmind --name "release audit" -p "Audit this repository"

# Different model
arcmind --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
arcmind --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
arcmind --model sonnet:high "Solve this complex problem"

# Limit model cycling
arcmind --models "claude-*,gpt-4o"

# Read-only mode
arcmind --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
arcmind --exclude-tools ask_question

# High thinking level
arcmind --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ARCMIND_CODING_AGENT_DIR` | Override config directory (default: `~/.arcmind/agent`) |
| `ARCMIND_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `ARCMIND_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `ARCMIND_OFFLINE` | Disable startup network operations, including package update checks |
| `ARCMIND_PROVIDER_ATTRIBUTION` | Enable ArcMind attribution headers for supported model providers with `1`/`true`/`yes` |
| `ARCMIND_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

---

## Contributing & Development

See [docs/development.md](docs/development.md) for setup and debugging.

## License

MIT

## See Also

- [@arcmind/ai](https://www.npmjs.com/package/@arcmind/ai): Core LLM toolkit
- [@arcmind/agent-core](https://www.npmjs.com/package/@arcmind/agent-core): Agent framework
- [@arcmind/tui](https://www.npmjs.com/package/@arcmind/tui): Terminal UI components
