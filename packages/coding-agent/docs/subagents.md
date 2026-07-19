# Ultra and Subagents

Ultra is ArcMind's highest execution tier. It combines the selected model's highest supported real thinking level with first-class subagent orchestration. `ultra` is a UI/runtime selection only: provider requests, child configuration, compaction, and the AI package continue to use the existing real levels through `max`.

Ultra is available in persisted primary Chat and Code sessions. It is intentionally unavailable in `--no-session`, raw in-memory, and child sessions because child ownership, recovery, and permanent deletion require a durable parent identity.

## Model-visible tools

While Ultra is selected, the main agent receives six normal tools:

| Tool | Purpose |
|---|---|
| `spawn_agent` | Create an isolated child with a unique name, task, tool list, and optional role/model/thinking/permission/cwd/fork/timeout snapshot |
| `inspect_agents` | List compact summaries or page through one child's recent visible activity |
| `message_agent` | Steer a running child or queue a follow-up that rehydrates a cold child under the same ID |
| `wait_agents` | Wait for a selected child event without polling |
| `interrupt_agent` | Stop queued/running work while preserving its recoverable session |
| `close_agent` | Permanently delete a child and retain only a parent tombstone |

The main agent may own at most 10 non-closed children. The process runs at most four children globally and four per parent, in FIFO order. Children cannot create children or talk directly to siblings.

Leaving Ultra does not interrupt existing children. Until all children are closed, the main agent keeps only `inspect_agents`, `wait_agents`, `interrupt_agent`, and `close_agent`; creation and messaging require re-entering Ultra.

## Context and prompt isolation

A child receives ArcMind's normal base prompt, its actual tools and permission snapshot, applicable `AGENTS.md` context, fixed collaboration rules, and any role/developer instructions supplied at creation. It does not copy the parent's assembled system prompt, skills, memory block, prompt templates, Ultra coordinator block, or subagent tools.

`forkTurns` defaults to `0`. A positive number or `"all"` copies only visible parent conversation turns and strips hidden thinking. The child's initial task is always a new user message.

## Lifecycle and storage

Each active child is a normal v7 JSONL session under:

```text
<agentDir>/subagents/<parentSessionId>/
```

Only a running child owns an in-memory runtime/model context. `done`, `failed`, and `stopped` children are cold but resumable. Restart never silently resumes work: prior `queued` and `running` states become `stopped`, and a follow-up is required to run again.

`close_agent` is different from `interrupt_agent`. Interrupt preserves the child transcript. Close drains the runtime, deletes the child JSONL and owned assets, and appends a minimal parent tombstone containing its ID, name, closed state, task summary, bounded final summary, and close time. A durable close marker lets recovery finish a crash-interrupted deletion. Failed deletion reports `close_failed` with the residual path and can be retried.

## Permissions

Child permissions are snapshotted at creation and may only be stricter than the parent's current setting. Tools and reviewer settings do not change when the parent later changes. Each child has a fresh permission policy, sandbox coordinator, and one-shot grant state.

When a child needs approval, only that child pauses. The request is routed to the parent session's current interactive owner and identifies the child name/ID plus the exact tool, arguments, risks, paths, and network targets. With no owner, it fails closed. An approval never grants authority to a sibling.

## Built-in runtime versus the legacy extension

The example at `examples/extensions/subagent/` remains available as a process-isolation and custom-workflow alternative. It spawns separate ArcMind processes and supports extension-defined agents/chains. The first-class Ultra runtime instead owns durable child sessions, recovery, parent-scoped events, permission routing, cold resume, and safe deletion in the core runtime. The two mechanisms are independent.
