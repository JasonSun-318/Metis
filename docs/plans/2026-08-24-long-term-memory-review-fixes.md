# Long-Term Memory Review Fixes Implementation Plan

> **For implementers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking; check each box as it's completed.

**Goal:** Close every accepted finding from the 2026-08-24 long-term-memory review without changing the exact-cwd, shared Chat/Code memory model.

**Architecture:** Keep SQLite and the existing memory engine as the authority. Fix mode behavior at the shared `AgentSession` seams, narrow the cross-package health API, remove obsolete retrieval parameters, separate the two specialized-model editors, and make packaged acceptance seed the real shared projection layout.

**Tech Stack:** TypeScript, React, Node SQLite, Vitest, Playwright, npm workspaces

**Spec:** `docs/specs/long-term-memory-hardening.md`

## Global Constraints

- Index mode must never call Embedding or Rerank.
- Settings refresh must immediately resume durable pending memory evidence in Index and Extract.
- Project memory is keyed only by canonical primary cwd; Chat and Code share it and mode deletion preserves it.
- SQLite remains the source of truth; App Server must not receive raw fact CRUD access.
- Do not add dependencies or modify the unrelated untracked `doc/` directory.

---

### Task 1: Enforce Index and refresh behavior

**Files:**
- Modify: `packages/coding-agent/src/core/agent-session.ts`
- Test: `packages/coding-agent/test/agent-session-memory-extract.test.ts`

**Interfaces:**
- Consumes: `SettingsManager.getMemoryEngine(): "index" | "extract"`
- Produces: Index extracts omit `embeddingKey/embedTexts`; refresh resumes commit extraction for both engines.

- [x] **Step 1: Add failing tests**

Add one test that configures an Embedding credential while the engine is Index, invokes memory extraction, and asserts the embedding adapter is not called. Add one test that simulates pending Index evidence across `prepareModelServiceSettingsRefresh()` and `applyModelServiceSettingsRefresh()` and asserts the extract runner is scheduled with trigger `settings-refresh`.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `npm test --workspace @metis/coding-agent -- agent-session-memory-extract.test.ts`

Expected: the Index Embedding and Index refresh tests fail against the reviewed implementation.

- [x] **Step 3: Apply the minimum shared fixes**

In `_maybeSchedulePendingMemoryExtract()`, remove only the `getMemoryEngine() !== "extract"` guard. In `_invokeMemoryExtract()`, attach the embedder only when `getMemoryEngine() === "extract"`:

```ts
if (this.settingsManager.getMemoryEngine() === "extract") {
	const embedder = await awaitWithAbort(this._createMemoryEmbedder(), options.signal);
	if (embedder) {
		extractArgs.embeddingKey = embedder.key;
		extractArgs.embedTexts = embedder.embed;
	}
}
```

- [x] **Step 4: Run the focused tests and verify pass**

Run: `npm test --workspace @metis/coding-agent -- agent-session-memory-extract.test.ts`

Expected: PASS.

### Task 2: Remove obsolete retrieval scope inputs

**Files:**
- Modify: `packages/coding-agent/src/core/memory/memory-search.ts`
- Modify: `packages/coding-agent/src/core/agent-session.ts`
- Test: `packages/coding-agent/test/memory-search.test.ts`

**Interfaces:**
- Produces: `SearchMemoriesOptions.projectKey: string`; no `mode` property.

- [x] **Step 1: Rename the option and remove mode**

Change:

```ts
cwdKey: string;
mode: string | null;
```

to:

```ts
projectKey: string;
```

Use `options.projectKey` in `searchRelevantFacts()` and update the `AgentSession` caller.

- [x] **Step 2: Update only search option fixtures**

Rename `cwdKey` to `projectKey` and delete `mode` in `memory-search.test.ts`. Do not change `MemoryFact.mode`, which remains a legacy storage column required by the spec.

- [x] **Step 3: Verify retrieval tests**

Run: `npm test --workspace @metis/coding-agent -- memory-search.test.ts`

Expected: PASS.

### Task 3: Narrow the cross-package health interface

**Files:**
- Create: `packages/coding-agent/src/core/memory/memory-health.ts`
- Modify: `packages/coding-agent/src/index.ts`
- Modify: `packages/app-server/src/memory-settings.ts`
- Modify: `packages/app-server/src/model-settings.ts`
- Test: `packages/app-server/test/memory-settings.test.ts`
- Test: `packages/app-server/test/model-settings.test.ts`

**Interfaces:**
- Produces: `getLatestMemoryError(agentDir: string): string | null`
- Produces: `clearMemoryHealth(agentDir: string, ...operations: MemoryHealthOperation[]): void`
- Removes: public `openMemoryStore` export from `@metis/coding-agent`.

- [x] **Step 1: Add the narrow functions**

Both functions open `getMemorySqlitePath(agentDir)`, execute the one health operation, and close the store in `finally`. They propagate errors so existing App Server fail-soft `try/catch` behavior remains unchanged.

- [x] **Step 2: Replace App Server raw-store calls**

Use `getLatestMemoryError()` in `MemorySettingsService.view()` and `clearMemoryHealth()` in both settings services. Remove `openMemoryStore` and `getMemorySqlitePath` imports from App Server.

- [x] **Step 3: Remove the raw public export**

Export only the two health functions from `packages/coding-agent/src/index.ts`; internal coding-agent modules continue importing `openMemoryStore` directly.

- [x] **Step 4: Verify App Server settings tests**

Run: `npm test --workspace @metis/app-server -- memory-settings.test.ts model-settings.test.ts`

Expected: PASS.

### Task 4: Separate specialized-model editors

**Files:**
- Modify: `packages/desktop/src/renderer/components/ModelSettingsPanel.tsx`
- Test: `packages/desktop/test/settings-dialog.test.tsx`

**Interfaces:**
- Keeps the existing `MetisDesktopApi` requests and protocol payloads unchanged.
- Produces two local editors whose props are their matching draft type and shared save/test/remove callbacks.

- [x] **Step 1: Locate or add focused renderer coverage**

Cover opening Embedding and Rerank editors, their protocol-specific fields, and submitting each payload. Reuse the existing renderer test setup; do not add a new UI test framework.

- [x] **Step 2: Split the render seam without a factory**

Define `EmbeddingServiceFields` and `RerankServiceFields` local components, each accepting its exact discriminated draft and `onChange`. Keep common name, supplier, model ID, API key, and actions in the dialog. Use one early discriminant at the dialog boundary instead of repeated inline field switches.

- [x] **Step 3: Verify focused Desktop tests**

Run the exact existing model-settings renderer test file discovered in Step 1.

Expected: PASS.

### Task 5: Repair packaged shared-memory acceptance

**Files:**
- Modify: `packages/desktop/e2e/packaged-smoke.spec.ts`
- Test: `packages/coding-agent/test/mode-project-delete.test.ts`

**Interfaces:**
- Uses: `getAutoMemoryPaths(agentDir, projectDir).project`
- Preserves: `memory/global/MEMORY.md` and the one exact-cwd `project.md` after deleting either mode.

- [x] **Step 1: Replace stale fixture paths**

Create one `sharedMemory` path without a mode argument, write `shared project memory` once, and use `memory/global/MEMORY.md` for the global projection.

- [x] **Step 2: Replace contradictory assertions**

Remove `sharedMemory.directory` from deleted paths. Assert the shared project index and global index still exist with their seeded contents after deleting Chat.

- [x] **Step 3: Run the disk-contract unit test**

Run: `npm test --workspace @metis/coding-agent -- mode-project-delete.test.ts`

Expected: PASS.

- [x] **Step 4: Run packaged E2E when a current package is available**

Run: `npx playwright test e2e/packaged-smoke.spec.ts -g "packaged mode project actions preserve"` from `packages/desktop` after packaging the current source. If unrelated UI assertions fail before disk verification, report them separately and retain the corrected disk contract.

### Task 6: Final validation and independent review

**Files:**
- Verify all modified files and generated artifacts.

- [x] **Step 1: Run formatting and generated checks**

Run `git diff --check` and the repository's existing generated/protocol checks. No generated protocol change is expected.

- [x] **Step 2: Run affected package suites serially**

Run the complete coding-agent, app-server, and Desktop test suites serially to avoid the previously observed parallel timeout behavior.

- [x] **Step 3: Package and verify arm64 Desktop**

Run `npm run package --workspace @metis/desktop` followed by `npm run verify:package --workspace @metis/desktop`.

- [ ] **Step 4: Run independent Standards and Spec reviews**

Review the final diff against this plan and `docs/specs/long-term-memory-hardening.md`. Resolve every supported P0-P2 finding and document any rejected false positive with source evidence.

- [ ] **Step 5: Confirm worktree scope**

Use `git status --short`, `git diff --stat`, and `git diff --check`; confirm the unrelated `doc/` directory is untouched.
