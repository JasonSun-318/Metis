import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identifySubmitPromptRequest } from "../src/core/runtime-recovery.ts";
import { materializeRuntimeRecovery } from "../src/core/runtime-recovery-materializer.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("runtime recovery materialization", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("surfaces a restarted queue draft again after its cancellation was already durable", () => {
		tempDir = join(tmpdir(), `metis-runtime-materializer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const input = { text: "draft", streamingBehavior: "steer" } as const;
		const identity = identifySubmitPromptRequest("request-draft", input);
		manager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: identity.operationId,
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			kind: "steer",
			state: "accepted",
			input,
		});
		manager.appendRuntimeControl({
			type: "runtime_queue",
			operationId: identity.operationId,
			queueItemId: identity.queueItemId,
			queue: "steer",
			state: "enqueued",
			input,
		});

		const first = materializeRuntimeRecovery(manager);
		expect(first.state.decisions).toEqual([]);
		expect(first.drafts).toEqual([{ queueItemId: identity.queueItemId, input }]);
		const sessionFile = manager.getSessionFile()!;
		manager.close();

		const reopened = SessionManager.open(sessionFile);
		try {
			const snapshot = vi.spyOn(reopened, "getDurableJournalSnapshot");
			const second = materializeRuntimeRecovery(reopened);
			expect(second.state.decisions).toEqual([]);
			expect(second.drafts).toEqual([{ queueItemId: identity.queueItemId, input }]);
			expect(snapshot).toHaveBeenCalledTimes(1);
		} finally {
			reopened.close();
		}
	});
});
