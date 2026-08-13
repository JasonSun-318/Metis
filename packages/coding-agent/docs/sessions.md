# Sessions

Metis saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.metis/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure.

```bash
metis -c                  # Continue most recent session
metis -r                  # Browse and select from past sessions
metis --no-session        # Ephemeral mode; do not save
metis --name "my task"    # Set session display name at startup
metis --agent-mode chat   # New Chat session with a managed workspace
metis --cwd ./project     # Bind a new session to an existing directory
metis --session <path|id> # Use a specific session file or partial session ID
metis --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, mode, workspace path/ownership, permission state, message count, tokens, and cost.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

Only persisted primary Code sessions may select [Ultra](subagents.md). Ordinary Chat sessions never receive subagent tools. A legacy Chat session with existing children receives cleanup-only controls until those children are closed.

## Chat and Code modes

Every session has one immutable classification mode:

| Action | Resulting mode |
|---|---|
| Start Metis with no mode option | `code` |
| `metis --agent-mode chat` | New `chat` session |
| `/new` | Choose Chat or Code, with the current mode listed first |
| `/new chat` or `/new code` | Skip the mode choice and create in that mode |
| Resume, continue, or import | Use the stored session mode |
| Fork or clone | Inherit the source session mode |
| Navigate with `/tree` | Keep the current session mode |

The two modes currently use the same general-purpose system prompt, tools, model configuration, and resources. Chat mode may write code when required, and Code mode may perform research, writing, planning, or analysis. They differ in workspace creation and default permissions:

| New session | No directory supplied | Directory supplied | Default permissions |
|---|---|---|---|
| Chat | Metis creates `~/.metis/agent/workspaces/<session-id>/` | The chosen existing directory is stored | Auto |
| Code | The terminal working directory captured at startup is stored | The chosen existing directory is stored | Auto |

`/new` reuses the normal TUI option and input components. After the mode choice, Chat offers a managed workspace, the captured terminal directory, or another directory; Code offers the captured terminal directory or another directory. The selection is made only while creating the session. Cancelling or entering an invalid path leaves the current session unchanged.

The mode, primary workspace path, and workspace ownership are immutable after creation. Resuming or switching restores the stored values; creation-only CLI flags cannot mutate an existing session. Code sessions may separately change their additional file-access roots as described below. Permission settings are per-session but can be changed later with `/permissions`. See [Permissions](permissions.md).

### Code additional directories

`/add-dir <path>` adds one existing directory to the current Code session without changing its primary working directory. Relative paths still resolve from the primary directory, and Bash still starts there. `/dirs` lists the effective roots; `/remove-dir <path>` revokes one added root.

Metis stores only canonical path controls. It does not scan or preload the directory, and it does not load `AGENTS.md`, `.metis`, skills, prompts, extensions, hooks, themes, or project memory from it. Files enter model context only after a tool reads them.

The same session restores its roots on resume and keeps them through `/tree` and compaction. `/new`, `/clone`, `/fork`, and import into a new session start without inherited additional directories. A temporarily missing root remains listed so the session can recover and the user can remove it.

Mode does not change `--system-prompt` or `--append-system-prompt` behavior.

Sessions for both modes remain JSONL files under `~/.metis/agent/sessions/<encoded-cwd>/` (or the configured session directory). For managed Chat sessions, the encoded cwd is the managed workspace path. Forking or cloning a managed session copies its workspace into a new owned directory; external workspaces remain shared. Deleting a closed session removes its workspace only when Metis can prove that exact directory is owned by that session.

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new [chat\|code]` | Create a session and choose its immutable primary workspace |
| `/permissions` | Change the current session's Ask, Auto, or Full setting |
| `/add-dir <path>` | Code only: add one existing directory as a file-access root for this session |
| `/remove-dir <path>` | Code only: remove one previously added directory |
| `/dirs` | Code only: list the primary and additional working directories |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `metis -r` opens the same picker at startup.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, metis uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
metis --name "Refactor auth module"
metis --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `metis -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, metis can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
