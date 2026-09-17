# Long-Term Memory

Metis keeps long-term memory in a markdown **vault** outside session JSONL files. The files are the source of truth; search indexes are in-memory derivatives rebuilt from them. There is no SQLite store, embedding service, or rerank service.

## Vault Layout

```text
~/.metis/agent/memory/            # <agentDir>/memory; respects METIS_CODING_AGENT_DIR
├── global/
│   ├── MEMORY.md                 # link-only index, ≤200 lines / 25KB
│   ├── _pinned/user.md           # standing context about you, ≤4KB
│   ├── _pinned/feedback.md       # corrections and feedback, ≤4KB
│   └── notes/<slug>.md           # one file per note
├── projects/<projectKey>/
│   ├── .project.json             # { root, createdAt } — display and migration metadata
│   ├── MEMORY.md
│   ├── _pinned/project.md        # project standing context, ≤4KB
│   ├── _pinned/active.md         # active-task context, ≤2KB (only when activeContext is on)
│   └── notes/<slug>.md
├── .history/
│   ├── changelog.jsonl           # one line per change
│   ├── <scope>/<target>/<ts>.md  # pre-change snapshots for undo
│   └── legacy-<ts>/              # archived pre-refactor data (one-shot migration)
├── .dream/
│   ├── state.json                # lastRunAt, lastRun, processedSessionIds
│   └── staging/<sessionId>.jsonl # phase-1 candidates, cleaned after each run
└── .meta/usage.json              # { "global/notes/<slug>" | "projects/<key>/notes/<slug>": { useCount, lastUsed } }
```

Directories are `0700` and files are `0600`. `.history/`, `.dream/`, and `.meta/` are internal: the agent's file tools cannot read them, and `other projects'` scopes are likewise outside the read boundary — reads are limited to `global/` and the current `projects/<key>/`.

## Scopes and Project Identity

- **global** — cross-project notes about you and your preferences.
- **project** — notes about one codebase. The scope key is `sha256(root)` where `root` is the nearest git root (worktrees included, via `.git` file) or the canonical working directory when no `.git` exists. Chat and Code sessions in the same root share the scope; subdirectories of a repo resolve to the repo root.
- **Managed workspaces** (for example, Chat tasks that Metis creates under `~/.metis/agent/workspaces/`) have no project scope. Their snapshot has no project section and `memory_write` with `scope: "project"` is refused, so temporary directories never leave orphan `projects/<key>/` folders.

## Notes

Each note is a markdown file with YAML frontmatter:

```markdown
---
name: pnpm-only
description: This project uses pnpm only; npm install breaks the lockfile  # ≤120 chars, indexed
type: project                 # user | feedback | project | reference | decision
aliases: [pnpm, package manager]   # optional, searched
created: 2026-09-10
updated: 2026-09-14
sources: [session:abc123]     # session:<id> | dream:<runId> | user | migrated
confidence: high              # high | medium | low
applies_to: ["packages/desktop/**"]   # optional globs
---
# pnpm only
**Why:** …
**How to apply:** …  See [[ci-pipeline]]
```

- Slugs are lowercase `[a-z0-9._-]`, up to 120 characters, no `..`. The note's filename is `notes/<slug>.md`.
- The body is limited to 16KB; `memory_write` refuses larger content and suggests splitting.
- `[[slug]]` links point at other notes in the same scope or in global. Backlinks are computed on demand.
- Each `MEMORY.md` index holds `- [type] [slug](notes/slug.md) — description` lines sorted by `updated` descending. Writes maintain it automatically. When an index is full (200 lines / 25KB) the note still saves with an "index full" warning; Dream trims it later. Hand-edited or malformed index lines are ignored — the next write rebuilds the index from the notes on disk.

## Pinned Blocks

Pinned blocks are small, high-frequency standing context injected with every snapshot. `user` and `feedback` belong to the global scope; `project` and `active` belong to the project scope. `active` exists only when `memory.activeContext` is enabled (see [Settings](settings.md#long-term-memory)). Total pinned content injected is capped at 12KB.

## Memory Tools

Three built-in tools are available to the primary agent when memory is enabled — not to subagents, scheduled/unattended runs, or sessions with `useMemory` off:

| Tool | Purpose |
|------|---------|
| `memory_search` | Keyword search over notes: `{ query, scope?, type?, limit? }` → matching slugs with snippets and scores. In-memory BM25 (name/aliases ×3, description ×2, body ×1) plus recency decay and a small usage bonus. Results record usage into `.meta/usage.json`. |
| `memory_read` | Read one note by `{ slug, scope? }` → frontmatter, body, links, backlinks. Without a scope it tries project then global. |
| `memory_write` | The only supported way to change the vault: `{ op, scope, target, newSlug?, frontmatter?, content?, oldText?, newText? }`. Ops: `create`, `append`, `replace`, `str_replace`, `rename`, `delete`. `target` is `{ slug }` or `{ block: "user" \| "feedback" \| "project" \| "active" }`; blocks support `append`/`replace`/`str_replace` only. |

The system prompt tells the agent to search before tasks that may depend on prior work or preferences, and to write immediately when you correct it or state a durable preference or project fact. Feedback notes are expected to carry `**Why:**` and `**How to apply:**`. `memory_write` calls are auto-approved — no permission prompt — while ordinary `write`/`edit`/`bash` against the vault directory are hard-rejected, and reads are limited to the two current scopes.

## The Frozen Snapshot

At session start Metis injects one snapshot of the protocol, both `MEMORY.md` indexes, and the pinned blocks into the system prompt — then freezes it for the rest of the session. It is re-read only after:

- a compaction completes,
- `/reload`,
- a `/memory` toggle (`on`/`off`, `use`, `contribute`), or a settings update that changes memory-affecting values (`autoMemoryEnabled`, `memory.*`).

Per-turn prompt rebuilds reuse the cached snapshot, so the prompt stays byte-stable for prefix caching. Side effect: writes from other sessions or Dream are not visible in the frozen prefix — but `memory_search`/`memory_read` always read the live vault, so the agent can still reach the latest content on demand.

## History and Undo

Every `memory_write` is journaled to `.history/`:

- `changelog.jsonl` appends `{ id, ts, actor, op, scope, target, projectKey?, snapshot?, operationId?, ... }` where `actor` is `agent` (with `sessionId`), `dream` (with `runId`), `user`, or `migrate`. Entries sharing an `operationId` form one atomic undo group — a `rename` and the `[[link]]` rewrites it triggered are undone together.
- Pre-change file contents are snapshotted to `.history/<scope>/<target>/<timestamp>.md`. `create` has no snapshot — undoing it deletes the new file. A `rename` is journaled as two entries sharing one snapshot.

`/memory undo [id]` reverts a change. With no argument it undoes the latest undoable change; an argument is matched as a change-id prefix (the `/memory` list shows 8-character prefixes). Only the newest un-undone change on a target can be undone — undo newer ones first. Project-scope entries are owned by their `projectKey`: a session can only undo changes belonging to its own project, and the desktop resolves each entry's owning project before undoing it. A rename whose `[[link]]` rewrites span several projects is still one undo group: session-scoped vaults stay confined to their own project, while the host-level vault (desktop undo, `undoMemoryRun`, `/memory undo-run`) reverts the whole group — but only when every foreign leg is a provable referrer rewrite (a `replace` entry whose snapshot still contains the old `[[slug]]` link), so a corrupt changelog line cannot pull an undo into another project.

`/memory undo-run <runId>` (SDK: `undoMemoryRun`, desktop: **Undo last run**) rolls back an entire Dream run in reverse order; targets touched by other actors after the run are skipped and reported. Retention is 20 snapshots per target and 90 days, pruned during Dream runs. Undo history does not rely on git.

**Compatibility limits.** Snapshots written before this layout remain undoable; old `rename` entries without `operationId` revert only the renamed file itself, not the link-rewrite group. Usage keys written before project-keyed scoping are inherited conservatively — same-slug usage from different projects cannot be reconstructed exactly. With `memory.activeContext` off, `_pinned/active.md` stays on disk but is neither injected into the snapshot nor writable through `memory_write` or Dream.

Editing vault files directly in an external editor produces no changelog or snapshot — accepted behavior; the search index picks the files up via mtime.

## Dream

Dream is the background consolidation pass that keeps the vault tidy. It runs outside your sessions: the App Server checks once at startup and every 6 hours; the interactive CLI runs one non-blocking check at startup; `/memory dream` and `memory/dream/run` trigger a manual run.

A gated run requires all of:

- `autoMemoryEnabled` and `memory.dream.enabled` (both default on),
- at least `memory.dream.minHours` (default 24) since the last run,
- at least `memory.dream.minSessions` (default 5) eligible unprocessed sessions,
- a credentialed memory model, and a free vault lock.

Manual runs skip the enabled/timing/count thresholds but still need a model and the lock, and never reprocess already-mined sessions.

**Eligible sessions** are persisted, non-scheduled, non-subagent sessions that have been idle for at least 2 hours, are not held by a live process lease, and have not opted out via `contributeMemory: false`.

**Phase 1** serializes each session's active branch — user/assistant text, tool calls, and tool results, capped to the most recent ~40k characters with secret-looking lines redacted — and asks the memory model for candidates via a forced `propose_memories` call. Sessions that fetched web or MCP content are flagged `polluted`. Candidates stage to `.dream/staging/`.

**Phase 2** runs one agent with only the three memory tools plus `finish_dream` over all staged candidates: dedupe against existing notes, supersede contradictions (newer evidence wins), turn relative dates absolute, merge fragments into structured notes with `[[links]]`, drop or downgrade polluted candidates, forget notes with zero useCount unused for `memory.dream.maxUnusedDays` (default 90), and keep pinned blocks and indexes within their limits. A run is capped at 50 writes, 30 agent turns, and 10 minutes; a per-run `runId` tags every changelog entry so the whole run can be rolled back with `undoRun` (desktop: **Undo last run**).

The memory model is `memory.dream.model` when set, otherwise the cheapest credentialed model by input cost. Dream calls always use `cacheRetention: "none"` so they never evict your session's prompt cache, and Dream-time searches do not inflate usage stats.

## Settings

All memory settings are global (`~/.metis/agent/settings.json`); see [Settings](settings.md#long-term-memory).

| Setting | Default | Description |
|---------|---------|-------------|
| `autoMemoryEnabled` | `true` | Inject the frozen snapshot and expose the memory tools |
| `memory.activeContext` | `false` | Maintain `_pinned/active.md` for the current project |
| `memory.dream.enabled` | `true` | Allow gated Dream runs |
| `memory.dream.model` | — | `{ provider, modelId }` override; unset picks the cheapest credentialed model |
| `memory.dream.minHours` | `24` | Minimum hours between runs |
| `memory.dream.minSessions` | `5` | Minimum eligible unprocessed sessions |
| `memory.dream.maxUnusedDays` | `90` | Forget unused notes older than this |

Legacy settings keys (`memoryEngine`, `embedding`, `rerank`, `memoryEmbeddingModel`, `memoryRerankModel`, `memoryMigrationNotice`) are deleted from settings files on load.

## Per-Session Flags

Each session stores two flags in its display metadata:

- **Use memory** (`/memory use on|off`, default on) — off removes the snapshot and all three memory tools from the session.
- **Learn from this session** (`/memory contribute on|off`, default on) — off keeps `memory_search`/`memory_read` but removes `memory_write` and excludes the session from Dream mining.

## `/memory` Subcommands

| Command | Effect |
|---------|--------|
| `/memory` | Show enabled state, scope directories, truncation flag, and the 10 most recent changes |
| `/memory on` / `/memory off` | Toggle `autoMemoryEnabled`; refreshes tools and snapshot immediately |
| `/memory use on\|off` | Toggle this session's use of memory |
| `/memory contribute on\|off` | Toggle this session's writes and Dream eligibility |
| `/memory undo [id]` | Revert the latest change, or the change whose id starts with `id` |
| `/memory undo-run <runId>` | Roll back every change of one Dream run, newest first |
| `/memory dream` | Run consolidation now, ignoring gate thresholds |

`/dream` no longer exists and prints a pointer to `/memory`. `memory_write` results and `memory/changed` events surface as "Saved memory: <target>" notifications with undo support.

## Desktop

Settings → **Memory** shows the same surface: the enable and Active Context toggles, the vault path, per-session **Use memory** / **Learn from this session** switches, a notes browser (global/project tabs, search, create/edit/delete), the Dream section (toggle, last-run summary, **Run now**, **Undo last run**), and a recent-changes list with inline diffs and per-change undo. App Server clients get `memory/get`, `memory/update`, `memory/notes/list|read|write`, `memory/history/list|read`, `memory/undo`, `memory/undoRun`, `memory/dream/run`, `session/setMemoryFlags`, and the `memory/changed` and `memory/dreamCompleted` events.

## Security Model

- Memory content is **untrusted reference data**: it is escaped and labeled in the system prompt and never treated as instructions.
- `memory_write` refuses content that looks like a secret (API keys, PEM blocks, `.env`-style assignments); Dream transcripts redact secret-looking lines before the model sees them.
- Vault writes take a filesystem lock and apply atomically; directories are `0700`, files `0600`.
- The agent's ordinary file and shell tools cannot write under the vault root and cannot read `.history/`, `.dream/`, `.meta/`, or other projects' scopes.
- Deleting sessions or a mode-specific project does not delete the vault; session export/import does not include it.

## Migration from the Old System

On first startup with pre-refactor data, `memory.sqlite*` files, stray `global/*.md` projections, and old `projects/<key>` directories are moved into `.history/legacy-<timestamp>/` with their relative paths preserved. Active facts become notes (`type: reference`, `sources: [migrated]`, `confidence: medium`); legacy project keys are remapped through the old `memory_projects.canonical_cwd` table to the new git-root keys, merging multiple old keys that resolve to the same root. A `.history/migrated.json` marker keeps the migration idempotent — it runs once and never deletes the archived originals.
