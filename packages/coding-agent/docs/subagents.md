# Ultra and Subagents

Ultra is ArcMind's highest execution tier. It combines the selected model's highest supported real thinking level with first-class subagent orchestration. `ultra` is a UI/runtime selection only: provider requests, child configuration, compaction, and the AI package continue to use the existing real levels through `max`.

Ultra is available only in persisted primary **Code** sessions. It is unavailable in ordinary Chat, `--no-session`, raw/in-memory, and child sessions. A legacy Chat session that already owns children receives cleanup tools only; it cannot create, steer, or resume a child.

| Session state | Subagent tools |
|---|---|
| Persisted primary Code + Ultra | All six |
| Persisted primary Code, normal thinking, no children | None |
| Persisted primary Code, normal thinking, residual children | Inspect, wait, interrupt, close |
| Legacy Chat with residual children | Inspect, wait, interrupt, close |
| Ordinary Chat, child, raw, in-memory, or `--no-session` | None |

## Model-visible tools

While Ultra is selected, the main agent receives six normal tools:

| Tool | Purpose |
|---|---|
| `spawn_agent` | Create a child with a unique name, task, explicit tool list, cwd/read/write roots, and optional role/model/thinking/permission/fork/timeout snapshot |
| `inspect_agents` | List compact summaries or page through one child's recent visible activity |
| `message_agent` | Steer a running child or queue a follow-up that rehydrates a cold child under the same ID |
| `wait_agents` | Wait for a selected child event without polling |
| `interrupt_agent` | Stop queued/running work while preserving its recoverable session |
| `close_agent` | Permanently delete a child and retain only a parent tombstone |

The main agent may own at most 10 non-closed children. The process runs at most four children globally and four per parent, in FIFO order. Children cannot create children or talk directly to siblings.

Leaving Ultra does not interrupt existing children. Until all children are closed, the main agent keeps only `inspect_agents`, `wait_agents`, `interrupt_agent`, and `close_agent`; creation and messaging require re-entering Ultra.

A typical creation request is:

```json
{
  "name": "frontend-reviewer",
  "task": "Review the frontend change and report concrete defects.",
  "tools": ["read", "grep", "bash"],
  "cwd": "./frontend",
  "readPaths": ["."],
  "writePaths": ["."],
  "permissionMode": "ask",
  "forkTurns": 0,
  "timeoutSeconds": 1800
}
```

Paths are resolved relative to the selected child cwd, canonicalized, and must be existing directories within the parent workspace. Each write root must be contained by a read root. Omitted read and write roots default independently to `[cwd]`.

## Context and prompt isolation

A child receives ArcMind's normal Code base prompt, its actual tools/permission/path context, applicable `AGENTS.md`, a fixed runtime-owned child contract, and a subordinate JSON-encoded parent assignment profile. The task remains a separate user message. It does not copy the parent's assembled system prompt, skills, auto-memory block, prompt templates, Ultra coordinator block, or subagent tools.

The parent chooses a least-capability subset of its active tools. A child gets a fresh loader, extension/MCP runtime, tool registry, permission policy, sandbox coordinator, listeners, and approval state. If a configured tool or exact model is unavailable on a later cold resume, that run fails visibly instead of silently changing configuration.

The runtime-owned coordinator prompt and child contract have one implementation source in `src/core/subagents/prompts.ts` and byte-for-byte tests. User-supplied names, roles, and instructions are encoded as assignment data rather than interpolated as runtime policy.

`forkTurns` defaults to `0`. A positive number or `"all"` copies only visible parent conversation turns and strips hidden thinking. The child's initial task is always a new user message.

## Asynchronous results

Queued/running progress is visible to the host but is not inserted into the parent model context. Only bounded terminal mailbox events are model-visible. A terminal event contains identity/status and a UTF-8-safe 4 KiB final/error prefix, never thinking, tool arguments, credentials, prompts, or the full transcript. Child permission requests go directly to the active user approval UI, remain audited in the child session, and never enter the parent mailbox.

Mailbox events are persisted first and injected FIFO at the next provider boundary that was already going to occur. A completion cannot mutate an in-flight request and never wakes an idle parent model by itself. `wait_agents` is therefore not the normal next step after spawn: continue useful independent work, and wait only when the next critical step depends on a new event. Wait returns updated agent IDs, not transcript content. Use `inspect_agents` or the host's paginated child activity view for the full visible record.

## Lifecycle and storage

Each active child is a normal v7 JSONL session under:

```text
<agentDir>/subagents/<parentSessionId>/
```

Only a running child owns an in-memory runtime/model context. `done`, `failed`, and `stopped` children are cold but resumable. Restart never silently resumes work: prior `queued` and `running` states become `stopped`, and a follow-up is required to run again.

| State | Meaning |
|---|---|
| `queued` | Durable run exists and is waiting for a scheduler slot |
| `running` | A hot runtime owns the child context |
| `done` | Run completed; session is cold and resumable |
| `failed` | Run failed or timed out; session is cold and resumable |
| `stopped` | Run was interrupted, unloaded, or recovered after restart |
| `close_failed` | Deletion was incomplete and must be retried |
| `closed` | Child files are gone; only the parent tombstone remains |

Parent runtime unload records active children as `stopped / parent_unloaded`. A child cleanup error remains attached to that stopped state and is also reported by parent teardown; it does not turn the interrupted task into `failed`.

`close_agent` is different from `interrupt_agent`. Interrupt preserves the child transcript. Close drains the runtime, deletes the child JSONL and session-owned image/tool-result assets, and appends a minimal parent tombstone containing its ID, name, closed state, task summary, bounded final summary, and close time. It never deletes the assigned cwd/read/write roots or a worktree/directory created for the task. A durable close marker lets recovery finish a crash-interrupted deletion. Failed deletion reports `close_failed` with the residual path and can be retried.

Closing is idempotent after success. Names remain reserved for the lifetime of the parent even after close. Deleting the parent session removes its owned subagent directory before deleting the parent journal; failure preserves the parent so cleanup can be retried.

## Permissions

Child permissions are snapshotted at creation and may only be stricter than the parent's current setting. Tools and reviewer settings do not change when the parent later changes. Each child has a fresh permission policy, sandbox coordinator, and one-shot grant state.

| Parent mode | Allowed child modes |
|---|---|
| `ask` | `ask` |
| `auto` | `ask`, `auto` |
| `full` | `ask`, `auto`, `full` |

Built-in local tools are clamped to the child project roots even when the child permission mode is Full. The sandbox denies sibling regions of the parent workspace and re-allows only assigned read roots; action-specific grants cannot widen assigned write roots. Explicitly delegated SDK and Extension tools are trusted capabilities that enforce their own resource semantics. MCP calls are not local filesystem capabilities; they retain MCP annotations and the child's snapshotted permission mode.

When a child needs approval, only that child pauses. The request is routed to the parent session's current interactive owner and identifies the child name/ID plus the exact tool, arguments, risks, paths, and network targets. With no owner, it fails closed. An approval never grants authority to a sibling.

Read/write scopes may overlap. Spawn reports overlaps but does not reject, lock, serialize, create a worktree, or promise conflict-free writes. The main agent should assign disjoint directories/worktrees when isolation matters; every child must preserve unrelated changes and report unresolved concurrent edits.

Runs are never retried automatically because tool side effects may already have happened. Per-run usage is recorded in the child projection and aggregated into the parent session accounting without replaying transcript content into the parent model.

## Built-in runtime versus the legacy extension

The example at `examples/extensions/subagent/` remains available as a process-isolation and custom-workflow alternative. It spawns separate ArcMind processes and supports extension-defined agents/chains. The first-class Ultra runtime instead owns durable child sessions, recovery, parent-scoped events, permission routing, cold resume, and safe deletion in the core runtime. The two mechanisms are independent.
