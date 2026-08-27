# Agents

Persisted primary Code sessions have a first-class Agent system at every thinking level. Ultra is only a thinking selection: it resolves to the selected model's highest supported real reasoning level and does not enable, disable, or otherwise change Agent tools.

Chat, scheduled, in-memory, raw `AgentSession`, and child sessions that cannot delegate do not receive Agent control tools. A delegating depth-one child receives the same controls for its own descendants. The maximum depth is two.

## Model tools

The model sees exactly six controls:

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Start a uniquely named child with a self-contained task and optional built-in role, context fork, or configured model |
| `inspect_agents` | List owned descendants or read one task's safe durable activity, newest first |
| `send_message` | Steer a currently running task |
| `followup_task` | Queue a new task on an existing Agent |
| `wait_agents` | Wait for one to eight terminal or approval events when progress truly depends on them |
| `interrupt_agent` | Stop queued or running work while preserving its history |

Spawning and follow-up are always asynchronous. Completed work also reaches the direct parent's durable mailbox, so polling is unnecessary. `inspect_agents` exposes only visible assistant text, tool name/status, and final text; it never exposes hidden reasoning, tool arguments, tool results, user messages, or raw tool messages.

## Roles and permissions

Built-in roles are `default`, `explorer`, `worker`, and `reviewer`. The runtime owns each role's prompt, tool ceiling, write policy, and delegation capability. Explorer and reviewer are read-only; worker and default inherit the parent's write policy. The model chooses a role but cannot grant arbitrary tools, filesystem roots, permission mode, cwd, thinking level, timeout, or developer instructions.

Every child inherits a permission ceiling from its parent. A later parent downgrade narrows all descendants, including queued, starting, running, and cold sessions. Child approval requests identify the Agent and route to the owning parent UI. A child model must already be configured; its actual thinking level is the highest supported level not above the parent's current level.

## Persistence and lifecycle

Agents are ordinary v13 Code session journals under:

```text
<agentDir>/agents/<rootSessionId>/
```

Each immutable Agent header records ownership, path, role, capability snapshot, model, actual thinking level, cwd, context fork, and permission ceiling. Each initial or follow-up task has its own `taskId` and append-only `agent_task` state records.

Archive hides terminal Agents without deleting history. An Agent with active descendants cannot be archived. Delete is a permanent subtree operation: descendants are stopped and deleted leaf-first, durable markers make crash recovery idempotent, and tombstones reserve names for the root session's lifetime. Project files and the assigned cwd are never deleted. Deleting the root session removes its canonical owned Agent directory; old data in removed layouts is ignored and left untouched.

## Mailbox delivery

Terminal task events are delivered only to the direct parent. `agent_mailbox_event` persists the bounded event before notification. `agent_mailbox_delivery` records `started` and `completed`; a started delivery without completion remains pending after recovery. Hot parents receive the event immediately, while cold parents receive it through their journal and recover it when reopened.

The desktop Agents sidebar reads the same canonical summaries and journals through App Server. It renders the ownership tree, task history, safe transcript pages, archive state, stop controls, and permanent subtree deletion without injecting child activity into the main conversation.
