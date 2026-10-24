# Agents

Persisted primary Chat and Code sessions have a first-class Agent system at every thinking level.

Scheduled, in-memory, raw `AgentSession`, and child sessions that cannot delegate do not receive Agent control tools. A delegating depth-one child receives the same controls for its own descendants. The maximum depth is two.

## Model tools

The model sees exactly six controls:

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start a uniquely named independent conversation asynchronously and return its role revision, mode, model, effective tools, write policy, and delegation capability |
| `inspect_agents` | List owned descendants, read one task's safe durable activity, or read a source-labelled input by message ID with bounded text pagination |
| `send_message` | Steer a currently running task |
| `followup_task` | Queue a new task on an existing Agent |
| `wait_agents` | Wait for one to eight terminal or approval events when progress truly depends on them |
| `interrupt_agent` | Stop queued or running work while preserving its history |

Spawning and follow-up are always asynchronous. Completed work also reaches the direct parent's durable mailbox, so polling is unnecessary. Task traces expose visible assistant text, tool name/status, and final text, without hidden reasoning or raw tool payloads. Reading a specific input exposes its trusted origin, delivery state, instruction revision, bounded text, and image count.

## Roles and permissions

Built-in roles are `default`, `explorer`, `worker`, and `reviewer`. Effective tools are always intersected with the parent's currently delegatable tools:

- `default`: all parent tools plus the six coordination tools when delegation is allowed; inherited write policy; may delegate below the depth limit.
- `explorer`: `read`, `grep`, `find`, `ls`, `web_fetch`, and `web_search`; filesystem writes and delegation denied.
- `worker`: all parent tools plus the six coordination tools when delegation is allowed; inherited write policy; may delegate below the depth limit.
- `reviewer`: `read`, `grep`, `find`, `ls`, and `bash`; filesystem writes and delegation denied.

The runtime owns each role's prompt, tool ceiling, write policy, and delegation capability. Explorer and reviewer do not load extension hooks, and extension or MCP tools cannot replace their trusted built-in read tools by reusing a name. The model chooses a role but cannot grant arbitrary tools, filesystem roots, permission mode, cwd, thinking level, timeout, or developer instructions. The same role definitions generate the parent prompt and tool schema, while `spawn_agent` and `inspect_agents` expose the final runtime snapshot.

The role catalog uses the session's explicit agent directory, including custom templates. It lists each role's purpose, effective tools, write policy, delegation limit, revision, and unavailable capabilities. Empty template tool lists mean inheritance of delegatable parent tools. A missing role at creation is an error, not an implicit fallback to `default`.

Each new child saves its role instructions and revision at creation. Editing or deleting the template does not change that child's role; current permissions are still rechecked and may narrow its capabilities. Legacy children without a snapshot receive a recorded compatibility baseline on explicit execution. Merely reading them does not migrate their journals.

Every child inherits a permission ceiling from its parent. A later parent downgrade narrows all descendants, including queued, starting, running, and cold sessions. Child approval requests identify the Agent and route to the owning parent UI. A child model must already be configured; its actual thinking level is the highest supported level not above the parent's current level.

## Persistence and lifecycle

Agents are ordinary v15 session journals, inheriting the parent's Chat or Code mode, under:

```text
<agentDir>/agents/<rootSessionId>/
```

Each immutable Agent header records ownership, path, role, capability snapshot, model, actual thinking level, cwd, and context fork. The inherited permission ceiling is saved at creation; append-only ceiling records preserve later narrowing across restarts. Each initial or follow-up task has its own `taskId` and append-only `agent_task` state records. Tasks and steering messages are limited to 64 KiB, one Agent retains at most 256 tasks, and one root tree retains at most 32 queued tasks; start a new uniquely named Agent after the lifetime task bound is reached.

Children start with independent context unless an explicit history fork is requested. Their system prompt combines current mode and tool rules, the child identity and coordination contract, frozen role instructions, and applicable project context. It does not copy the entire parent system prompt or inject automatic memory, skills, or prompt templates. Parent task messages carry agent origin; they cannot serve as human permission approval.

`agent_input` persists accepted messages and delivery receipts; `agent_run_control` persists stop/resume permission. Inputs use stable message IDs, independent of their text. `accepted` means saved, `queued` means waiting, and `delivered` means included in a model request—not understood or obeyed. Tasks record both the accepted instruction revision and the revision consumed by the model.

Archive hides terminal Agents without deleting history. An Agent with active descendants cannot be archived. An archived ancestor also blocks task execution and automatic mailbox continuations throughout its subtree. Delete is a permanent subtree operation: descendants are stopped, one durable group manifest is written before any session is removed, and deletion then proceeds leaf-first. Recovery resumes the whole group after a crash; if recovery cannot finish, Agent orchestration stays disabled instead of exposing a partially deleted tree. Tombstones reserve names for the root session's lifetime. Project files and the assigned cwd are never deleted. Deleting the root session removes its canonical owned Agent directory; old data in removed layouts is ignored and left untouched.

## Mailbox delivery

Terminal task events reach the direct parent. Human intervention reaches the direct parent and root, deduplicated when they are the same conversation. Events include stable identities and bounded text; the complete child history remains in the child journal. Delivery state updates revise the existing visible notification rather than adding another model turn.

`agent_mailbox_event` persists at most 256 pending events before notification. Delivery claims are limited to eight events and 32 KiB of final prompt text at a time. `agent_mailbox_delivery` records `started` and `completed`; a started delivery without completion remains pending after recovery. An enabled, idle or waiting parent can continue automatically; a busy parent consumes notifications at an execution boundary. Cold child continuations run as system-origin tasks through the same scheduler and task limits. Transient notification failures are retried; terminal, human-intervention, and human stop/resume events can also be reconstructed from durable child records without waking a model during history recovery. Waiting children release their scheduler slot while descendants work.

Stopping a child pauses its subtree and cancels active and queued tasks there; siblings and the parent remain independent. Stopping the root pauses the whole tree. The model’s interrupt tool persists an interrupted execution fence before waiting for an initializing runtime to finish, so a stop cannot race into a first model request. Model instructions cannot resume a user-paused child. Human resume enables only the selected conversation, and a new human message cannot bypass a paused ancestor. Cancelled tasks are not silently replayed. After application restart, reading history does not run a model; resuming coordination requires an explicit user action.

## Desktop conversations and host tools

The sidebar nests children below their parent with status and unread indicators. A child opens in the main conversation area with its own history, draft, attachments, source labels, and controls. Sending while it runs steers its current task; “Send after current task” queues a new task. Sending after completion continues the same child context with a new task ID. Reading the catalog or opening child history does not create a runtime or model request.

Browser, question, permission, and delivered-file operations carry the actual child and root identity. Tools are available only where the role and parent permit them. A browser page has one agent owner: another agent receives `PAGE_IN_USE` until an explicit handoff. User takeover blocks automation for all agents. Child images and delivered files are read through ownership-checked child references, without acquiring a writer or starting a model.
