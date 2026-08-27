# Session File Format

Sessions are stored as JSONL (JSON Lines) files. Each line is a JSON object with a `type` field. Session entries form a tree structure via `id`/`parentId` fields, enabling in-place branching without creating new files.

## File Location

```
~/.metis/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Where `<path>` is the working directory with `/` replaced by `-`.

## Deleting Sessions

Sessions can be removed from `/resume` by selecting a session and pressing `Ctrl+D`. Metis removes the JSONL file together with that session's image directory, tool-output directory, child-session directory, and Metis-owned managed workspace where applicable.

When available, Metis uses the `trash` CLI instead of permanently deleting eligible files. Deleting a JSONL file manually does not clean up its owned assets.

## Session Version

Sessions have a version field in the header:

- **Version 1**: Linear entry sequence (legacy, auto-migrated on load)
- **Version 2**: Tree structure with `id`/`parentId` linking
- **Version 3**: Renamed `hookMessage` role to `custom` (extensions unification)
- **Version 4**: Stores session images as content-addressed file references
- **Version 5**: Reserves durable runtime operation/queue/turn controls
- **Version 6**: Stores immutable mode/workspace ownership and permission controls
- **Version 7**: Reserved the original child-session control family
- **Version 8**: Adds Code-session additional-directory controls
- **Version 9**: Adds policy-owned unattended permission decisions
- **Version 10**: Adds hidden scheduled-session ownership markers
- **Version 11**: Reserved durable child mailbox delivery controls
- **Version 12**: Adds durable Plan collaboration controls
- **Version 13**: Adds canonical Agent headers, tasks, archive state, mailbox delivery, and Ultra selection

Existing sessions are automatically migrated to the current version (v13) when loaded. A journal containing a newer control family under an older header is rejected rather than guessed.

## Image Storage

Regular session JSONL files store images as references:

```typescript
interface ImageReference {
  type: "image_ref";
  hash: string;      // SHA-256 of the image bytes
  mimeType: string;
}
```

For default sessions, the image bytes are stored under `~/.metis/agent/images/<session-key>/<sha256>.<ext>`. Custom session files use an `images/<session-key>/` directory beside the JSONL file. The `session-key` is derived from the absolute session-file path. Repeated copies of the same image within one session share the same file. Metis verifies the hash and restores the normal `ImageContent` before sending the conversation to a model. `/export file.jsonl` is intentionally self-contained and keeps image data inline; `/import` moves it back into the session's content-addressed image store.

## Tool-output Storage

Durable full tool results are stored under `tool-results/<session-key>/`, using the same session-key derivation as image storage. The latest five eligible results keep their preview in model context; older eligible results may be projected as a short path reference after their total reaches 20,000 estimated tokens.

Closing the app, resuming a session, microcompaction, and full compaction do not remove these files. Fork and branch-copy operations copy proven session-owned references into the destination session directory and rewrite the destination paths. Explicit session deletion removes that session's tool-output directory. In-memory sessions use an isolated temporary directory that is removed when `AgentSession.dispose()` completes. Metis does not delete legacy paths outside a proven session-owned directory.

## Source Files

- `packages/coding-agent/src/core/session-manager.ts` - Session entry types and SessionManager
- `packages/coding-agent/src/core/messages.ts` - Extended message types
- `packages/ai/src/types.ts` - Base message types
- `packages/agent/src/types.ts` - AgentMessage union type

## Message Types

Session entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded at runtime and in portable exports
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

### Base Message Types (from metis-ai)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: any;      // Tool-specific metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

### Extended Message Types (from metis-coding-agent)

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: any;                 // Extension-specific metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## Entry Base

All entries (except `SessionHeader`) extend `SessionEntryBase`:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;           // 8-char hex ID
  parentId: string | null;  // Parent entry ID (null for first entry)
  timestamp: string;    // ISO timestamp
}
```

## Entry Types

### SessionHeader

First line of the file. Metadata only, not part of the tree (no `id`/`parentId`).

```json
{"type":"session","version":11,"id":"uuid","timestamp":"2026-07-17T14:00:00.000Z","cwd":"/path/to/project","mode":"code","cwdOrigin":"user-selected","permissionMode":"auto"}
```

`mode` is `"chat"` or `"code"`. `cwdOrigin` is `"managed"` only for a workspace that Metis owns and may copy/delete; otherwise it is `"user-selected"`. New records write `permissionMode` as `"ask"`, `"auto"`, or `"full"`; omitted values default to Auto. Auto remains Auto when reopened.

For sessions with a parent (created via `/fork`, `/clone`, or `newSession({ parentSession })`):

```json
{"type":"session","version":11,"id":"uuid","timestamp":"2026-07-17T14:00:00.000Z","cwd":"/path/to/project","mode":"chat","cwdOrigin":"user-selected","permissionMode":"ask","parentSession":"/path/to/original/session.jsonl"}
```

`parentSession` records lineage; forks and clones inherit the source session's mode.

### Session Permission Controls

Permission changes and decisions are append-only journal metadata:

```json
{"type":"session_permissions","id":"a1b2c3d4","parentId":"leaf1234","timestamp":"2026-07-17T14:01:00.000Z","permissionMode":"full"}
{"type":"session_permission_decision","id":"b2c3d4e5","parentId":"leaf1234","timestamp":"2026-07-17T14:01:01.000Z","actionId":"call-1","toolName":"bash","source":"user","decision":"allow","reason":"Approved once"}
```

These records are reduced in raw journal order. They do not advance the transcript leaf, appear in `getEntries()`/`getTree()`, or become model messages. New decision records contain only user `allow`/`deny` decisions and are audits, not reusable grants. Legacy reviewer sources and `ask` decisions remain readable but cannot be written through the current API.

### Code additional-directory controls (v8)

Code sessions append one strict non-tree control whenever an additional file-access root changes:

```json
{"type":"session_directory_added","id":"c3d4e5f6","parentId":"leaf1234","timestamp":"2026-07-26T14:01:00.000Z","path":"/canonical/path/to/shared"}
{"type":"session_directory_removed","id":"d4e5f6a7","parentId":"leaf1234","timestamp":"2026-07-26T14:02:00.000Z","path":"/canonical/path/to/shared"}
```

Each record permits only the base control fields and one normalized canonical absolute `path`. The records are reduced in raw journal order; they do not advance the transcript leaf, appear in `getEntries()`/`getTree()`, or become model messages. A directory need not still exist when the journal is reopened. Directory controls require a v8 header, and any Chat journal containing them is invalid.

Opening or resuming the same journal preserves these controls. `/tree` and compaction stay within that journal and preserve them. Clone, fork, `newSession()`, and import into a new destination exclude these authority-bearing controls.

### Agent headers and controls (v13)

A first-class child adds an immutable ownership marker to its normal session header:

```json
{"type":"session","version":13,"id":"child-id","timestamp":"2026-07-18T00:00:00.000Z","cwd":"/path/to/project","mode":"code","cwdOrigin":"user-selected","permissionMode":"ask","agent":{"agentId":"child-id","name":"researcher","agentType":"explorer","parentSessionId":"parent-id","rootSessionId":"parent-id","agentPath":["child-id"],"cwd":"/path/to/project","tools":["read","grep"],"writePolicy":"deny","permissionMode":"ask","model":{"provider":"openai","modelId":"gpt-test"},"thinkingLevel":"high","initialTask":"Inspect the boundary","forkTurns":0,"timeoutSeconds":1800,"mayDelegate":false}}
```

The immutable header records ownership and the runtime-resolved capability snapshot. Each initial or follow-up task has an immutable `taskId`; append-only `agent_task` records move it through queued, running, and terminal states. `agent_message` audits steering, and `agent_archived` records reversible terminal-history visibility.

Ultra selection is stored independently as `session_ultra_selection` and never controls Agent availability. Child permission requests go directly to the active owning UI and remain audited in the child session. Full child transcripts and configuration never enter the parent journal.

### Agent mailbox controls (v13)

`agent_mailbox_event` stores one bounded terminal task event in the direct parent's journal. `agent_mailbox_delivery` records `started` and `completed` for one `deliveryId` and the exact ordered event IDs included in a provider request. A started delivery without a matching completed record remains pending after recovery.

Agents live under `<agentDir>/agents/<rootSessionId>/`. Durable `.deleting` and `.deleted` markers make subtree deletion recoverable and keep names reserved. Removed child layouts are not read, migrated, indexed, or deleted. See [Agents](subagents.md).

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false}}
```

### ModelChangeEntry

Emitted when the user switches models mid-session.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Emitted when the user changes the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

Optional fields:
- `details`: Implementation-specific data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if metis-generated (legacy field name)

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: File tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom data for extensions
- `fromHook`: `true` if generated by an extension, `false`/`undefined` if metis-generated (legacy field name)

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload. Interactive mode can render custom entries via `metis.registerEntryRenderer(customType, renderer)`, but they still do not participate in LLM context.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on an entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

Set `label` to `undefined` to clear a label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `metis.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

## Tree Structure

Entries form a tree:
- First entry has `parentId: null`
- Each subsequent entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

`buildContextEntries()` walks from the current leaf to the root, producing the active entry list while honoring compaction:

1. Collects all entries on the path
2. If a `CompactionEntry` is on the path:
   - Includes the compaction entry first
   - Then entries from `firstKeptEntryId` to compaction
   - Then entries after compaction
3. Preserves non-message entries in the selected range so interactive mode can render them

`buildSessionContext()` builds on that entry list to produce the message list for the LLM:

1. Extracts current model and thinking level settings from the full path
2. Converts selected entries to messages:
   - `message` -> stored `AgentMessage`
   - `compaction` -> `compactionSummary`
   - `branch_summary` -> `branchSummary`
   - `custom_message` -> `CustomMessage`
   - `custom` -> no context message

## Parsing Example

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version ?? 1}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.id}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.id}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.id}] Extension message (${entry.customType}): ${entry.content}`);
      break;
    case "label":
      console.log(`[${entry.id}] Label "${entry.label}" on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.id}] Thinking: ${entry.thinkingLevel}`);
      break;
  }
}
```

## SessionManager API

Key methods for working with sessions programmatically.

### Static Creation Methods
- `SessionManager.create(cwd, sessionDir?, { id?, mode?, cwdOrigin?, permissionMode? })` - Create a session; omitted permission mode defaults to Auto
- `SessionManager.open(path, sessionDir?)` - Open existing session file
- `SessionManager.continueRecent(cwd, sessionDir?, { mode? })` - Open the latest session; use the option only when no session exists
- `SessionManager.inMemory(cwd?, options?)` - No file persistence
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - Fork a session and inherit its mode

### Static Listing Methods
- `SessionManager.list(cwd, sessionDir?, onProgress?)` - List sessions for a directory
- `SessionManager.listAll(onProgress?)` - List all sessions across all projects

### Instance Methods - Session Management
- `newSession({ mode?, parentSession? })` - Start a peer session; omitted mode inherits the current manager mode
- `setSessionFile(path)` - Switch to a different session file
- `createBranchedSession(leafId)` - Extract branch to new session file
- `createBranchedSessionManager(leafId)` - Create a branch manager that inherits the source mode
- `getMode()` - Return the effective mode, including the legacy `code` fallback
- `getCwdOrigin()` - Return `managed` or `user-selected`
- `getAdditionalDirectories()` - Return the current Code-only additional roots
- `getWorkspaceRoots()` - Return the immutable primary root followed by current additional roots
- `addWorkspaceDirectory(path)` - Append one existing canonical Code root without changing cwd
- `removeWorkspaceDirectory(path)` - Revoke one added Code root, including a temporarily missing root
- `getPermissionSettings()` - Return the effective Ask/Auto/Full permission mode
- `setPermissionSettings(settings)` - Append non-tree permission metadata

### Instance Methods - Appending (all return entry ID)
- `appendMessage(message)` - Add message
- `appendThinkingLevelChange(level)` - Record thinking change
- `appendModelChange(provider, modelId)` - Record model change
- `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` - Add compaction
- `appendCustomEntry(customType, data?)` - Extension state (not in context)
- `appendSessionInfo(name)` - Set session display name
- `appendCustomMessageEntry(customType, content, display, details?)` - Extension message (in context)
- `appendLabelChange(targetId, label)` - Set/clear label

### Instance Methods - Tree Navigation
- `getLeafId()` - Current position
- `getLeafEntry()` - Get current leaf entry
- `getEntry(id)` - Get entry by ID
- `getBranch(fromId?)` - Walk from entry to root
- `getTree()` - Get full tree structure
- `getChildren(parentId)` - Get direct children
- `getLabel(id)` - Get label for entry
- `branch(entryId)` - Move leaf to earlier entry
- `resetLeaf()` - Reset leaf to null (before any entries)
- `branchWithSummary(entryId, summary, details?, fromHook?)` - Branch with context summary

### Instance Methods - Context & Info
- `buildContextEntries()` - Get active branch entries with compaction applied
- `buildSessionContext()` - Get messages, thinkingLevel, and model for LLM
- `getEntries()` - All entries (excluding header)
- `getHeader()` - Session header metadata
- `getSessionName()` - Get display name from latest session_info entry
- `getCwd()` - Working directory
- `getSessionDir()` - Session storage directory
- `getSessionId()` - Session UUID
- `getSessionFile()` - Session file path (undefined for in-memory)
- `isPersisted()` - Whether session is saved to disk
