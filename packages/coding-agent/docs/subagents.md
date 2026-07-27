# Ultra and Subagents

Ultra is ArcMind's highest execution tier. It combines the selected model's highest supported real thinking level with first-class subagent orchestration. `ultra` is a UI/runtime selection only: provider requests, child configuration, compaction, and the AI package continue to use the existing real levels through `max`.

Ultra is available only in persisted primary **Code** sessions. It is unavailable in ordinary Chat, `--no-session`, raw/in-memory, and child sessions. A legacy Chat session that already owns children receives cleanup tools only; it cannot create, steer, or resume a child.

| Session state | Subagent tools |
|---|---|
| Persisted primary Code + Ultra, not activated, no children | `activate_subagents` |
| Persisted primary Code + Ultra, not activated, residual children | `activate_subagents`, inspect, interrupt, close |
| Persisted primary Code + Ultra, activated | All five orchestration tools |
| Persisted primary Code, normal thinking, no children | None |
| Persisted primary Code, normal thinking, residual children | Inspect, interrupt, close |
| Legacy Chat with residual children | Inspect, interrupt, close |
| Ordinary Chat, child, scheduled, raw, in-memory, or `--no-session` | None |

## Model-visible tools

While Ultra is selected but orchestration is inactive, the main agent receives only `activate_subagents`. Its strict parameters are `{}`. It is intended for complex work that can be split into independent, bounded assignments or requires broad multi-file exploration; it should not be used for simple, known-location, or inherently sequential work.

The first successful call returns `{ "activated": true, "alreadyActivated": false }`. A repeated call from an already-issued or batched tool call is harmless and returns `alreadyActivated: true`. Activation refreshes tools before the next automatic provider request in the same user turn, so no second user message is required.

After activation, `activate_subagents` is hidden and the main agent receives these five normal tools:

| Tool | Purpose |
|---|---|
| `spawn_agent` | Create a child and explicitly choose foreground (`background: false`) or background (`background: true`) delivery |
| `inspect_agents` | List compact summaries or page through one child's recent visible activity |
| `message_agent` | Steer a running child, or follow up with an explicit foreground/background choice |
| `interrupt_agent` | Stop queued/running work while preserving its recoverable session |
| `close_agent` | Permanently delete a child and retain only a parent tombstone |

The main agent may own at most 10 non-closed children. The process runs at most four children globally and four per parent, in FIFO order. Children cannot create children or talk directly to siblings.

Activation is runtime-only and is not written to the session journal or settings. Leaving Ultra clears it immediately. Re-entering Ultra, replacing or reopening a session, or constructing a new runtime requires `activate_subagents` again. Ordinary provider requests, context compaction, and prompt rebuilding within the same active runtime keep it enabled.

Leaving Ultra does not interrupt existing children. Until all children are closed, the main agent keeps only `inspect_agents`, `interrupt_agent`, and `close_agent`; creation and messaging remain hidden. Re-entering Ultra adds `activate_subagents` beside those cleanup controls, and successful activation restores all five orchestration tools.

The five tool schemas are the detailed lazy-loaded usage contract: they describe foreground/background delivery, assignment shape, least-capability tools, permission/model/thinking defaults, cwd, forked turns, timeout, inspection, messaging, interruption, and deletion. Version 1 does not add a separate subagent index or inject child prompts/transcripts into the parent context.

A typical creation request is:

```json
{
  "name": "frontend-reviewer",
  "task": "Review the frontend change and report concrete defects.",
  "tools": ["read", "grep", "bash"],
  "background": true,
  "cwd": "./frontend",
  "permissionMode": "ask",
  "timeoutSeconds": 1800
}
```

`cwd` is resolved against the parent's primary cwd, canonicalized, and must be an existing directory inside one of the parent's current workspace roots. A directory added after the manager starts is available to future children; existing child sessions keep their stored cwd. Workspace roots select cwd and Ask auto-read behavior, but they are not an OS filesystem capability boundary.

## Context and prompt isolation

A child receives ArcMind's normal Code base prompt, its actual tools/permission/cwd context, applicable `AGENTS.md`, a fixed runtime-owned child contract, and a subordinate JSON-encoded parent assignment profile. The task remains a separate user message. It does not copy the parent's assembled system prompt, skills, auto-memory block, prompt templates, Ultra coordinator block, or subagent tools.

The parent chooses a least-capability subset of its active tools. A child gets a fresh loader, extension/MCP runtime, tool registry, permission policy, listeners, and approval state. If a configured tool or exact model is unavailable on a later cold resume, that run fails visibly instead of silently changing configuration.

The runtime-owned coordinator prompt and child contract have one implementation source in `src/core/subagents/prompts.ts` and byte-for-byte tests. User-supplied names, roles, and instructions are encoded as assignment data rather than interpolated as runtime policy.

`forkTurns` defaults to `0`. A positive number or `"all"` copies only visible parent conversation turns and strips hidden thinking. The child's initial task is always a new user message.

Before activation, the compact activation tool definition is the only subagent-specific model context. After activation, the parent receives the five tool definitions plus the compact runtime-owned coordinator block. Tool changes are recorded on the activation result and are used by the next automatic provider request; neither activation nor a child completion mutates a request already in flight.

## Asynchronous results

Queued/running progress is visible to the host but is not inserted into the parent model context. Only bounded terminal mailbox events are model-visible. A terminal event contains identity/status and a UTF-8-safe 4 KiB final/error prefix, never thinking, tool arguments, credentials, prompts, or the full transcript. Child permission requests go directly to the active user approval UI, remain audited in the child session, and never enter the parent mailbox.

Foreground and background delivery are explicit per run:

- Foreground: the tool call remains active, child approvals go to the user, terminal state is persisted, and the terminal summary returns as the tool result. No mailbox event is created.
- Background: admission returns immediately, the parent continues useful work, terminal state and mailbox event are persisted, and Runtime resumes the parent at the next safe point. Full activity remains behind `inspect_agents`.

A completion cannot mutate an in-flight request. Background events are persisted FIFO; the runtime waits for the current request to settle, coalesces available events, and starts one hidden continuation. If a user turn starts first, that turn consumes the events and the scheduled continuation becomes a no-op. A failed automatic continuation is not retried in a loop; its durable event remains available to the next user turn or reopened runtime.

## Lifecycle and storage

Each active child is a normal v11 JSONL session under:

```text
<agentDir>/subagents/<parentSessionId>/
```

Only a running child owns an in-memory runtime/model context. `done`, `failed`, and `stopped` children are cold but resumable. Restart never silently resumes work: prior `queued` and `running` states become `stopped`, and a follow-up is required to run again.

First-class subagent ownership and control records were introduced in session format v7. Per-run delivery mode and durable two-phase mailbox controls were added in v11, the current format.

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

`close_agent` is different from `interrupt_agent`. Interrupt preserves the child transcript. Close drains the runtime, deletes the child JSONL and session-owned image/tool-result assets, and appends a minimal parent tombstone containing its ID, name, closed state, task summary, bounded final summary, and close time. It never deletes the assigned cwd or a worktree/directory created for the task. A durable close marker lets recovery finish a crash-interrupted deletion. Failed deletion reports `close_failed` with the residual path and can be retried.

Closing is idempotent after success. Names remain reserved for the lifetime of the parent even after close. Deleting the parent session removes its owned subagent directory before deleting the parent journal; failure preserves the parent so cleanup can be retried.

## Permissions

Child permissions inherit or narrow the parent's current mode. Each child has a fresh permission policy and one-action approval state.

| Parent mode | Allowed child modes |
|---|---|
| `ask` | `ask` |
| `full` | `ask`, `full` |

When the parent changes from Full to Ask, ArcMind immediately lowers every non-closed child's in-memory ceiling and durably appends Ask to hot, cold, and queued child sessions. A child starting during the transition sees Ask before its first prompt. Changing the parent back to Full never re-upgrades an existing child.

Ask automatically permits only proven safe structured reads and `inspect_agents`; other model-facing calls ask. Approved built-ins execute directly as the current OS user, and installed integrations use their configured runtime. Extension, SDK, and MCP code is trusted when installed/configured, but their model-facing tools still follow Ask/Full.

When a child needs approval, only that child pauses. The request uses the parent's single approval queue and identifies the child name/ID plus the exact tool, arguments, risks, paths, and network targets. With no owner, it fails closed. The decision is audited in the child journal and never grants authority to a sibling or enters the parent model transcript.

Children share the host filesystem. Spawn does not detect overlap, lock, serialize, create a worktree, or promise conflict-free writes. The main agent should assign disjoint directories/worktrees when isolation matters; every child must preserve unrelated changes and report unresolved concurrent edits.

Runs are never retried automatically because tool side effects may already have happened. Per-run usage is recorded in the child projection and aggregated into the parent session accounting without replaying transcript content into the parent model.

Scheduled/unattended sessions never bind or activate the Subagent manager and do not expose Subagent tools. The Subagent path does not use the scheduled/unattended workspace sandbox.

## Built-in runtime versus the legacy extension

The example at `examples/extensions/subagent/` remains available as a process-isolation and custom-workflow alternative. It spawns separate ArcMind processes and supports extension-defined agents/chains. The first-class Ultra runtime instead owns durable child sessions, recovery, parent-scoped events, permission routing, cold resume, and safe deletion in the core runtime. The two mechanisms are independent.
