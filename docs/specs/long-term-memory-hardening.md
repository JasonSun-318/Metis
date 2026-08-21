# Long-Term Memory Hardening Specification

**Status:** Approved for implementation planning

**Date:** 2026-08-21

## Problem

The current long-term-memory implementation has four coupled gaps:

1. Embedding and rerank are stored as chat-style `provider/model` strings, so endpoint construction guesses the wire protocol and produces invalid URLs such as `/v1/v1/embeddings` and `/v1/rerank`.
2. Project identity uses a lossy path encoding, and reconcile operations can read or mutate facts outside the current project.
3. Extraction reprocesses old context, duplicate and mixed-validity mutations are not atomic, projections retain stale files, and open sessions do not reload memory/model settings.
4. Retrieval materializes every active fact and silently hides several embedding, rerank, backfill, and timeout failures.

## Goals

- Let users configure one active Embedding service and one optional active Rerank service on the Model settings page.
- Support arbitrary suppliers, including OpenAI-compatible services and Alibaba Cloud Model Studio, without treating supplier names as protocols.
- Make global memory intentionally shared while making exact-cwd project memory collision-resistant, shared by Chat and Code, and unreadable from other projects by default model tools.
- Make fact mutation, extraction cursors, projections, settings refresh, cancellation, and error reporting form a closed loop.
- Keep the first version local and operationally light: SQLite remains the source of truth and no separately deployed vector database is required.

## Non-goals

- Multiple named Embedding or Rerank profiles.
- A remote vector database, HNSW index, worker process, or job queue.
- Multimodal reranking.
- Automatic parent/child directory memory inheritance.
- A full Desktop fact-management UI or public fact CRUD RPC.
- Purging shared exact-cwd long-term memory as a side effect of deleting one mode-specific Chat or Code project.
- Automatic reconstruction of ownership when two historical project paths already collided under the old lossy key; that information was never stored and cannot be recovered reliably.

## Global Constraints

- Use npm workspace commands; do not introduce pnpm commands.
- Add no production dependency and no new native binary.
- Store service credentials only in `auth.json` through `AuthStorage`; never return credentials through App Protocol or persist them in `settings.json`.
- Treat every model/tool payload as untrusted: bound fact counts, fact sizes, vector dimensions, endpoint lengths, and stored error text.
- Preserve existing chat-provider configuration and the Vision service behavior.
- Preserve unrelated worktree changes, especially the existing untracked `doc/` directory.
- Use Conventional Commits and keep every implementation task independently testable.
- Regenerate App Protocol artifacts whenever protocol schemas change.
- For local coding-agent build verification, set `METIS_NATIVE_TOOLS_TARGET=current` to avoid downloading all-platform native tools.

## Service Configuration Contract

Supplier identity is descriptive metadata and never selects an adapter. Embedding uses the established OpenAI-compatible request contract. Text Rerank v1 supports one shared JSON shape and stores the exact operation endpoint because providers use different paths for that same shape.

```ts
export type EmbeddingApi = "openai-compatible";

export const MEMORY_EMBEDDING_CREDENTIAL_ID = "memory:embedding:v1";
export const MEMORY_RERANK_CREDENTIAL_ID = "memory:rerank:v1";

export interface EmbeddingSettings {
	name: string;
	provider: string;
	baseUrl: string;
	api: EmbeddingApi;
	modelId: string;
	dimensions?: number;
}

export interface RerankSettings {
	name: string;
	provider: string;
	endpointUrl: string;
	modelId: string;
}
```

`provider` is user-visible metadata such as `OpenAI`, `Alibaba Cloud`, or `Custom`. It is never used as an AuthStorage key; the two namespaced credential ids above prevent collisions with arbitrary chat-provider names. `EmbeddingSettings.api` identifies the OpenAI-compatible Embedding contract. Rerank has no protocol selector until a second request/response shape is actually supported.

Embedding `baseUrl` is the API root immediately before the operation name. The adapter strips trailing slashes and appends exactly one `embeddings` segment:

| Service | Configured URL | App behavior | Final endpoint |
|---|---|---|---|
| OpenAI embedding | `baseUrl = https://api.openai.com/v1` | append `embeddings` | `https://api.openai.com/v1/embeddings` |
| Qwen-compatible embedding | `baseUrl = https://dashscope.aliyuncs.com/compatible-mode/v1` | append `embeddings` | `https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings` |
| Cohere rerank | `endpointUrl = https://api.cohere.com/v2/rerank` | use exactly as configured | same |
| Qwen3 rerank | `endpointUrl = https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1/reranks` | use exactly as configured | same |

Embedding requests use `{ model, input, dimensions? }` and require exactly one row per input with a unique in-range integer `index`, a vector of 1–8,192 finite numbers with non-zero norm, one consistent vector length, and an exact `dimensions` match when configured. Conversion to `Float32Array` must remain finite, rejecting otherwise-finite numbers that overflow float32. Configured dimensions must be an integer from 1 through 8,192. Rerank requests use `{ model, query, documents, top_n }` and validate top-level `results[]` entries containing unique in-range `index` and finite `relevance_score` values. Cohere and Qwen3 share this request/response shape; `/rerank` versus `/reranks` is represented by the configured `endpointUrl`, not by separate adapters.

Configured service URLs must use HTTP or HTTPS and must not contain user-info, query strings, or fragments. Requests use `redirect: "error"`, so a provider cannot redirect the dedicated Authorization credential to another origin. API keys travel only in the Authorization header from `AuthStorage`.

The server trims and requires public setting strings. Name and Supplier are each at most 120 characters, Model ID at most 200, and either URL at most 2,048. A submitted API key is 1–16,384 characters, contains no ASCII control character, and is otherwise stored byte-for-byte. One Embedding call accepts 1–32 inputs of at most 8,000 characters each. One Rerank call accepts a query of at most 8,000 characters and 1–50 documents of at most 4,000 characters each. Adapter JSON responses are capped at 16 MiB before parsing; non-2xx errors expose status only, never the provider response body. Specialized model calls have a 30-second default timeout; a shorter caller timeout still wins.

DashScope-native Rerank and multimodal Rerank are out of scope. Add an explicit protocol discriminant only when one of those genuinely different request/response shapes is implemented.

The persisted embedding identity is a SHA-256 hash of `api`, normalized `baseUrl`, `modelId`, and `dimensions`. Display names and credentials are excluded. Changing that identity makes existing vectors eligible for backfill.

## Settings and UI Behavior

- The Model page has a Specialized models section containing Vision, Embedding, and Rerank cards.
- Embedding is required before Extract can be selected. Rerank is optional.
- The first version stores at most one active configuration per specialized service.
- The Embedding editor contains Name, Supplier, Base URL, the fixed OpenAI-compatible contract, Model ID, optional Dimensions, API key, Save, Remove, and Test connection.
- The Rerank editor contains Name, Supplier, full Endpoint URL, Model ID, API key, Save, Remove, and Test connection. It has no Cohere/Qwen protocol selector.
- Test connection validates the current unsaved editor draft. Its RPC accepts the draft settings plus either a one-shot API key or an instruction to use the stored credential; the one-shot key is never persisted. Embedding sends two short strings and validates two vectors. Rerank sends one query and two documents and validates returned indices and scores.
- The Memory page contains only enable/disable, engine selection, configured-state summaries, latest operation error, and a Configure in Models action. It contains no raw provider/model text input.
- The Model and Memory pages state that Extract sends the bounded current query and durable fact text to the configured Embedding service and may send up to 50 candidate fact texts to Rerank. This disclosure is visible before enabling Extract.
- Specialized setting mutations accept only these credential combinations: non-null settings plus `set` or `keep`, and null settings plus `remove`. `keep` requires an existing dedicated `api_key` credential, not merely any AuthStorage entry. Removing Embedding changes Extract to Index before deleting its credential. The server enforces this invariant; the UI is not the authority.
- For `set`, validate first, snapshot the prior dedicated credential, write the new credential, then flush settings; an ordinary flush failure restores the prior credential before the RPC fails. For removal, flush settings (and Extract-to-Index fallback) before deleting the credential, so interruption can leave only an unused orphan key. Cross-file crash-atomicity is not claimed; startup/runtime health exposes an unusable surviving pair and the Model page can replace it.
- On upgrade, obsolete `memoryEmbeddingModel` and `memoryRerankModel` strings are never guessed into structured endpoints and are removed. Any already-valid structured settings survive a mixed-version file. Extract falls back to Index only when no valid structured Embedding setting remains, and a bounded migration warning tells the user what must be reconfigured. Invalid structured service settings are removed under the same rule rather than reaching an adapter.
- Rerank absence or failure falls back to cosine-plus-keyword ranking.
- Any Model or Memory settings mutation uses a registry gate and a two-phase barrier across all open sessions: after the gate closes, new session open/run/close operations receive `BUSY`, already-created or in-flight runtime slots are included, and concurrent settings mutations wait for the gate. Prepare aborts and awaits Extract/Backfill in every runtime before persistence; apply reloads and restarts every surviving runtime before the gate reopens. If persistence fails, `SettingsManager.flushOrThrow()` first reloads the mutating manager from unchanged durable settings before returning the original error; the apply phase then reloads every surviving session manager. Direct SDK/CLI mutation applies the same barrier to its own session. Both App Server phases use `Promise.allSettled`; a runtime that cannot cross either phase is invalidated and closed so no stale open runtime remains.

## Project Identity and Scope

`projectKey` is the lowercase, 64-character SHA-256 hex digest of the canonical absolute primary cwd. Filesystem projection directories and `facts.cwd_key` use this key. Chat and Code sessions using the same canonical cwd share one project memory.

Project identity is exact, not hierarchical. A session rooted at `/workspace/app/packages/api` does not inherit project memory from `/workspace/app`, and additional directory roots do not contribute memory. Sessions that should share project memory must use the same primary cwd. Metis does not walk parent directories because a broad ancestor may contain unrelated or sensitive memories.

Mode-project deletion removes that Chat or Code project's sessions and artifacts but preserves the exact-cwd long-term ledger and projection shared by both modes. Deleting one mode must not erase memory still used by the other, and silent last-mode purging would make long-term memory retention depend on session cleanup. An explicit project-memory purge can be added later on top of the same exact-context authorization.

SQLite adds a `memory_projects` table recording `project_key`, `canonical_cwd`, `legacy_key`, whether that legacy key was claimed, and creation time. A separate `memory_ingest_state` table marks the global unit or an exact project key handled even when no importable fact exists. On first access to a canonical cwd:

1. Insert or load its deterministic project row.
2. Claim and migrate matching legacy facts only when no other canonical cwd has claimed that legacy key.
3. If another cwd has already claimed the same legacy key, start the second project empty and record a migration warning rather than leaking the first project's facts.
4. If no SQLite project fact was recovered, acquire the memory root lock and ingest that one exact `projects/<projectKey>/project.md` projection at most once; never scan every project directory at startup.
5. Build the new hashed projection from SQLite. Historical lossy projection directories are not read or injected.

If an existing `project_key` row names a different canonical cwd (whether corruption or a theoretical digest collision), resolution fails closed and records migration health; it never reuses that project's facts.

Global facts have `cwd_key = NULL` and `mode = NULL` and remain visible to every project. Project facts have the exact `projectKey` and `mode = NULL`; the legacy `mode` column remains only for an in-place migration. A memory tool may read or mutate only global facts plus project facts matching its exact `projectKey`. Reconcile candidate queries use the same scope.

## Mutation Integrity

- Every fact has a normalized-text SHA-256 fingerprint. A partial unique SQLite index prevents two active facts with the same scope, project key, and fingerprint.
- Text normalization is NFKC, trim, collapse Unicode whitespace to one ASCII space, and lowercase with `toLocaleLowerCase("en-US")`.
- `commit_facts` requires every non-sensitive input to have a valid topic, then allocates topics and inserts under one `BEGIN IMMEDIATE` transaction. A context keeps at most 30 ordinary topics; once those slots are used, facts proposing another valid new topic are stored in generated `overflow.md` and counted as `remappedTopicLimit` rather than making extraction fail forever. It reports only rows actually inserted and treats exact duplicates as successful no-ops. Sensitive-looking inputs are intentionally omitted and counted without failing valid facts in the same call.
- `reconcile_facts` opens `BEGIN IMMEDIATE`, validates every referenced id, exact context, operation-appropriate status, survivor, recency rule, operation bound, topic filename, and simulated destination fingerprint inside that transaction before performing its first write, then applies the prevalidated plan in the same transaction. Merge/supersede/move require active facts; delete may retire a visible active or superseded fact. Merge/supersede participants must share one scope/context, destructive target ids may appear in only one operation, and `moveScope` rejects a destination active-fingerprint collision. This removes both ambiguous plans and the validation/write race between shared Chat and Code sessions.
- Because reconcile can also supersede/delete facts, any sensitive-looking addition rejects the whole reconcile plan; it is not partially omitted while destructive operations proceed.
- Recency order is deterministic: compare `created_at`, then `source_turn` with null as empty, then `id`, all ascending; the greatest fact is the only valid supersede target or merge survivor. An explicitly named older survivor rejects the plan.
- The reconcile prompt contains only global plus exact-project candidates, newest first: at most 100 active and 50 superseded summaries, with fact text Unicode-safely capped to 400 characters and the complete candidate JSON capped to 32,000 characters. Stop before a complete record would cross the total cap; never slice JSON. Older facts remain unchanged and cannot be referenced by that run.
- A request with one structurally invalid operation applies no operation and returns the first bounded public rejection reason.
- Embeddings for facts inserted by one tool call are requested in one batch and written after the fact transaction. Failure leaves vectors null for backfill and records health state.

## Incremental Extraction

SQLite stores one successful commit-extract cursor per session id. The cursor is the stable `SessionEntry.id` of the last message entry actually included in evidence.

- Turn extraction reads message entries from the active session branch after the stored cursor, not `agent.state.messages`.
- If the cursor is not on the active branch, the branch is replayed; the active-fact fingerprint constraint prevents exact duplicate facts.
- Pending entries are batched oldest first. A batch contains complete serialized message entries up to 8,000 characters; when the oldest single entry exceeds the limit, its serialized tail is capped to 8,000 characters and that explicit per-entry cap is considered processed.
- The cursor advances only after a successful `commit_facts` tool result and successful projection, and only to that batch's last included entry.
- After every successful batch, the session re-reads its active branch even when the prior snapshot said `hasMore = false`; that flag can become stale while the model call is running. Entries appended during an in-flight extract are therefore drained rather than discarded by coalescing. A failed or timed-out batch stops the drain with its cursor unchanged. Preserve the existing `success | failed | skipped` run-status contract: the 60-second timeout records `failed` with a bounded timeout reason, while caller/disposal cancellation records `skipped` with a bounded cancellation reason.
- Reconcile extraction remains tied to compaction preparation, uses the same 8,000-character evidence ceiling, and does not advance the turn cursor.
- Evidence serialization still caps each assistant message at 2,000 characters and excludes tool result bodies and synthetic summaries.

## Authoritative Projections

SQLite is authoritative. Projection writes always replace the index, including with an empty file.

Before replacement, the writer parses only strict generated links from the previous generated index. Publish order is new/changed topic files, safe deletion of stale topics named only by the old index, then the new index last. If cleanup fails, the old index remains authoritative for the next deterministic retry instead of losing the ownership list and leaving a permanent orphan. It deletes only stable single-link regular topic files that were named by the previous generated index and are absent from the new set. Managed generated names include `overflow.md` and `legacy-overflow.md`; index names `memory.md` and `project.md` are never deletion candidates. It never scans and deletes arbitrary Markdown files.

The generated layout deliberately separates the globally readable projection from the database and sibling projects:

```text
memory/
├── memory.sqlite
├── global/
│   ├── MEMORY.md
│   └── <global-topic>.md
└── projects/
    └── <sha256-canonical-cwd>/
        ├── project.md
        └── <project-topic>.md
```

`MEMORY.md` and `project.md` are link-only indexes. Each line is `- [topic.md](topic.md) — <retrieval sentence up to 120 characters>`. Retrieval sentences collapse all Unicode whitespace to one ASCII space, so one fact cannot create extra index lines. Topic files contain the complete projected fact texts for that topic. Index mode reloads and injects the global `MEMORY.md` and current project's `project.md` before each new user turn; it does not inject every topic body or reread files between tool-loop continuations in that turn. A change projected by another Chat/Code session is therefore visible on this session's next prompt. The model reads a linked topic file only when the task needs its details. Each global/project context has at most 32 active topic filenames; even worst-case ASCII filenames and four-byte Unicode summaries fit inside the defensive 200-line/25-KiB load cap, so a normally generated index never silently hides later topics. Before Index or Extract memory enters the system prompt, escape `&`, `<`, and `>` and label the block as untrusted reference data that must not override system/developer/user instructions; projection files on disk remain ordinary unescaped Markdown.

Projection mutation is serialized by one existing `proper-lockfile` root lock. Facts are queried only after acquiring the lock through an ordered SQLite iterator selecting projection fields only; each topic is written incrementally to a sibling temporary file, synced, and atomically published instead of accumulating the entire ledger or topic in memory. The bounded index metadata stays in memory. Lock-release errors never hide the primary operation result. Startup rebuilds only the global projection. Resolving a session rebuilds only that exact project's projection; no startup scan rewrites every historical project.

Topic files are flat lowercase basenames matching `^(?!.*\.\.)[a-z0-9][a-z0-9._-]{0,119}\.md$`. `memory.md`, `project.md`, `overflow.md`, and `legacy-overflow.md` are reserved and invalid as caller-selected topics. Schema migration deterministically lowercases valid historical names and maps invalid or reserved historical names to `legacy-<digest-prefix>.md`: start with 12 SHA-256 hex characters and extend the prefix deterministically when that filename is already owned by a different source topic name. If a historical context has more than 30 canonical ordinary topics, keep the 30 most recently updated topics (tie by filename) and remap all remaining facts to generated `legacy-overflow.md`, preserving content and discoverability. Runtime overflow uses the separate generated `overflow.md`; the two reserved files plus 30 ordinary topics keep every context at or below 32 active topic filenames. A mutation accepts at most 32 new facts, each with 1–4,000 trimmed characters. Reconcile accepts at most 200 total operations.

Markdown recovery is also bounded: startup prefers the new global index and otherwise reads the legacy global index, while exact-project recovery is lazy and reads only the current hashed project directory. Recovery accepts only stable single-link regular files and never follows a topic/index symlink. For either recovery unit, read at most 25 KiB/200 complete index lines, at most 1 MiB per linked topic, and at most 16 MiB of topic text in aggregate; limits are enforced while reading, not after an unbounded `readFile`. Split imported text into facts of at most 4,000 Unicode characters. If a source exceeds a limit, leave the historical files untouched, ingest the bounded complete UTF-8/line prefix, mark that recovery unit handled, and record a migration warning rather than allocating unbounded memory, rescanning forever, or silently claiming complete recovery.

## Retrieval, Cancellation, and Performance

- Retrieval uses one store method for global plus current-project candidates; duplicate cosine implementations are removed.
- Before retrieval, the current user text is Unicode-safely capped to its last 8,000 characters, keeping the most recent instruction and ensuring the same bounded query is used for keyword, Embedding, and Rerank stages.
- SQLite rows are consumed with statement iteration and only the best 50 fused candidates are retained, avoiding an in-memory array of all fact vectors. Retrieval returns at most 8 facts and 2,048 fact-text characters. If the first relevant fact alone exceeds the remaining budget, it is Unicode-safely truncated with an ellipsis; no oversized first row bypasses the cap.
- Keyword scoring is the fraction of distinct normalized query tokens (word tokens plus overlapping CJK bigrams) present in the fact, producing `0..1`. Keyword-only fallback admits only positive-overlap candidates. With a query vector, a candidate is admitted only when keyword overlap is positive or cosine similarity is at least `0.25`; negative cosine is clamped to zero for fusion, so a literal match is not punished below the keyword-only score. Zero-score and unrelated rows are not returned merely to fill Top-K.
- A malformed, non-finite, zero-norm, or query-dimension-mismatched stored vector is excluded from cosine scoring but its fact remains eligible by keyword. One search conditionally clears at most the first 100 invalid vectors only if their stored key/BLOB is unchanged since the scan, returns those row ids as diagnostics, and records a bounded Embedding health error. This bounds repair memory, avoids erasing a concurrent repair, and leaves remaining rows for later searches/backfill instead of silently skipping corruption forever.
- The initial ranking remains a streamed linear scan. No vector-store dependency is added until either one global-plus-exact-project retrieval scope reaches 50,000 active facts or measured p95 local ranking exceeds 250 ms on supported hardware.
- A checked benchmark records 1,000, 10,000, and 30,000 fact median/p95 timings and peak RSS delta after two warmups and twenty measured searches. RSS baseline is sampled after seeding and warmup, and peak is the largest sample during the measured searches, so database construction is not mislabeled as query working memory. The 30,000 × 64-float p95 must complete within 250 ms and add less than 64 MiB RSS on the reference development machine; CI runs the correctness test, not the machine-specific timing assertion.
- The retrieval timeout signal is combined with the caller signal and passed into Embedding and Rerank `fetch` calls. Caller abort propagates as `AbortError`; an internal timeout records an error and falls back to keyword-only ranking.
- Embedding HTTP or response-validation failure records an error and falls back to keyword-only ranking. Rerank failure records an error and preserves fused ordering.
- Backfill runs only while Auto Memory is enabled, the engine is Extract, and Embedding settings plus their dedicated credential are present. It processes sequential batches of 32 until no active fact needs the current embedding configuration. A SQLite single-owner lease permits only one backfill across the open runtimes sharing that database and allows recovery after a crashed owner. The 90-second lease is longer than the 30-second provider timeout, is renewed by each committed batch, and may be taken over after expiry. Each batch transaction rechecks lease owner/configuration before writing, so a stale former owner cannot overwrite newer vectors. Backfill yields between batches, stops on abort/error, and never starts a new configuration in one app runtime until the previous run has been aborted and awaited. Concurrent Metis processes mutating the same settings directory remain unsupported.

## Health and Busy State

SQLite maintains the last health event per operation: `extract`, `embedding`, `rerank`, `backfill`, `projection`, and `migration`. Each row contains status (`running`, `ok`, or `error`), update time, and a bounded redacted reason for errors. This is not an aggregate busy counter across concurrent sessions: `/memory` overlays its current session's local Extract state, while the Desktop may call Backfill globally running only when the singleton lease is held. A durable Embedding mutation clears `embedding` and `backfill`; a Rerank mutation clears `rerank`; and an Auto Memory enable/engine mutation clears `extract` and `backfill` before refreshed runtimes start work. Multi-scope projection rebuild records one surrounding result, so a later successful scope cannot hide an earlier failure in the same rebuild.

Once per application startup, before any memory operation begins, every persisted `running` row is changed to bounded `error: Interrupted before completion`. App Server startup and direct SDK session creation share one process-local initialization promise keyed by canonical `agentDir`, so concurrent callers join the same work and later sessions cannot repeat recovery. A rejected initialization is evicted so an explicit retry can run; a successful one remains memoized for the process lifetime. Opening an additional session must not perform recovery and overwrite live operations.

The Memory page and `/memory` display the latest current error. A later success for the same operation clears that operation's error state. A cancelled Extract records a bounded retryable error and preserves its cursor; settings refresh immediately reschedules pending evidence on surviving runtimes.

Memory Extract has its own observable state and is not reported as Compact. It runs with thinking disabled and a fixed 60-second total timeout. The runner races awaited model work against that signal instead of assuming a provider honors cancellation; a late provider result is ignored and cannot execute a memory tool, project, or advance the cursor. It does not block ordinary prompts, Bash, or extension commands; SQLite transactions, projection locking, and settings-refresh cancellation provide the real concurrency boundaries. Manual compaction may wait for an active commit extract, but the same timeout guarantees that wait is bounded.

## Bash Security Boundary

- Built-in Write/Edit continue to reject paths under the memory root.
- Built-in Read/Grep/Find/Ls reject paths under the memory root unless the canonical target lies under `memory/global/` or the current exact project's directory. This check follows symlinks and cannot be overridden by ordinary outside-read permission.
- Default model-initiated Bash uses the existing OS sandbox's root read-deny and supplies only `memory/global/` and the current exact project directory as additional read-only roots. Before sandbox startup, both the host and broker validate the final allow set: reject any workspace/write root that overlaps the memory root; reject an explicit read-only root equal to or above it while permitting intentional child carve-outs; and reject any overlap with implicit runtime paths or the shell binary. This fail-closed check is required because the sandbox runtime gives `allowRead` precedence over `denyRead`: a broad ancestor workspace cannot safely be combined with a nested memory deny. In the normal non-overlapping layout, `memory.sqlite` and sibling project directories remain outside every allow root; in an overlapping layout, default sandbox Bash is unavailable until the user explicitly chooses approved host Bash or Full mode.
- Approved host Bash and Full mode run with the current user's host authority and therefore can access the memory root. The existing approval UI already identifies host execution; documentation must say explicitly that memory isolation does not apply there.
- Remove command-string path scanning as a claimed security control. It is not a shell parser and cannot close indirect-path, variable, symlink, or subprocess bypasses.

## Delivery Slices

Implement as one initiative with six vertical Conventional Commits. Every commit must pass its focused tests and the builds of every package whose public types changed:

1. Exact-project identity, separated projection layout, migration, and read isolation.
2. Bounded atomic mutations, canonical topics, and locked authoritative projections.
3. Oldest-first incremental extraction, coalesced drain, and bounded lifecycle.
4. Structured Embedding/Rerank settings, adapters, safe legacy fallback, runtime refresh, and Desktop configuration as one compile-safe vertical slice.
5. Streamed relevant retrieval, complete cancellable backfill, durable health, and benchmark.
6. Documentation, generated artifacts, full package regression, and versioned plan/spec artifacts.

Optional fact CRUD, multiple service profiles, a vector database, and a worker process require separate evidence and plans after this initiative.
