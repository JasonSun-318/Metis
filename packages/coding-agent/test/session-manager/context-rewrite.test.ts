import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ToolResultMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import {
	applyContextRewrites,
	type ContextRewriteBatch,
	ContextViewError,
	getContextSourceDigest,
} from "../../src/core/context-view.ts";
import { SessionLease } from "../../src/core/session-lease.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const toolResult = (text: string, callId = "c1"): Message => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

const batchFor = (
	entryId: string,
	message: Message,
	expectedLeafId: string | null,
	overrides: Partial<ContextRewriteBatch> = {},
): ContextRewriteBatch => ({
	schemaVersion: 1,
	batchId: "batch-1",
	expectedLeafId,
	reason: "microcompaction",
	tokensBefore: 100,
	tokensAfter: 10,
	replacements: [
		{
			sourceEntryId: entryId,
			sourceDigest: getContextSourceDigest(message),
			artifactRelativePath: "output.txt",
			artifactDigest: "a".repeat(64),
			artifactBytes: 8,
			content: [{ type: "text", text: "saved: /session/output.txt\n" }],
		},
	],
	...overrides,
});

const expectViewError = (fn: () => unknown, code: string) => {
	try {
		fn();
		expect.unreachable("expected a ContextViewError");
	} catch (error) {
		expect(error).toBeInstanceOf(ContextViewError);
		expect((error as ContextViewError).code).toBe(code);
	}
};

describe("SessionManager context rewrites", () => {
	it("replays exact text and commits a batch only once", () => {
		const manager = SessionManager.inMemory();
		const message = toolResult("original");
		const entryId = manager.appendMessage(message);
		const batch = batchFor(entryId, message, entryId);
		const committed = manager.appendContextRewrite(batch);
		expect(manager.appendContextRewrite(batch)).toBe(committed);
		expect(manager.getContextRewrites()).toHaveLength(1);
		const replayed = applyContextRewrites([{ entryId, message }], manager.getContextRewrites());
		expect((replayed[0] as ToolResultMessage).content).toEqual(batch.replacements[0]!.content);
		expect(message.content).toEqual([{ type: "text", text: "original" }]);
		expectViewError(() => manager.appendContextRewrite({ ...batch, tokensAfter: 9 }), "batch-conflict");
		manager.close();
	});

	it("persists one batch record across close and reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-context-rewrite-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const message = toolResult("original");
			const entryId = manager.appendMessage(message);
			manager.appendContextRewrite(batchFor(entryId, message, entryId));
			const file = manager.getSessionFile()!;
			const lines = readFileSync(file, "utf8").trim().split("\n");
			expect(lines.filter((line) => line.includes("metis_context_rewrite_v1"))).toHaveLength(1);
			manager.close();
			manager = SessionManager.open(file);
			const batches = manager.getContextRewrites();
			expect(batches).toHaveLength(1);
			expect(batches[0]!.batchId).toBe("batch-1");
			// The source message entry itself is preserved.
			expect(manager.getEntry(entryId)).toMatchObject({ type: "message" });
		} finally {
			manager?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is readable from a read-only session without a writer lease", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-context-rewrite-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const message = toolResult("original");
			const entryId = manager.appendMessage(message);
			manager.appendContextRewrite(batchFor(entryId, message, entryId));
			const file = manager.getSessionFile()!;
			manager.close();
			manager = undefined;
			const readonly = SessionManager.openReadOnly(file);
			expect(readonly.getContextRewrites()).toHaveLength(1);
		} finally {
			manager?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not inherit batches committed after the branch point", () => {
		const manager = SessionManager.inMemory();
		const before = manager.appendMessage({ role: "user", content: "before", timestamp: 1 });
		const message = toolResult("original");
		const entryId = manager.appendMessage(message);
		manager.appendContextRewrite(batchFor(entryId, message, entryId));

		manager.branch(before);
		expect(manager.getContextRewrites()).toHaveLength(0);
		manager.close();
	});

	it("inherits batches on branches taken after the commit", () => {
		const manager = SessionManager.inMemory();
		const message = toolResult("original");
		const entryId = manager.appendMessage(message);
		manager.appendContextRewrite(batchFor(entryId, message, entryId));
		const after = manager.appendMessage({ role: "user", content: "after", timestamp: 2 });

		manager.branch(after);
		expect(manager.getContextRewrites()).toHaveLength(1);
		manager.close();
	});

	it("validates leaf, source role, reachability, and digest before writing", () => {
		const manager = SessionManager.inMemory();
		const message = toolResult("original");
		const entryId = manager.appendMessage(message);
		const leafId = manager.getLeafId()!;

		expectViewError(() => manager.appendContextRewrite(batchFor(entryId, message, "stale")), "stale-leaf");
		expectViewError(() => manager.appendContextRewrite(batchFor("missing", message, leafId)), "invalid-record");
		const userId = manager.appendMessage({ role: "user", content: "hi", timestamp: 2 });
		expectViewError(
			() => manager.appendContextRewrite(batchFor(userId, message, manager.getLeafId()!)),
			"invalid-record",
		);
		const edited = { ...message, content: [{ type: "text" as const, text: "edited" }] };
		expectViewError(
			() =>
				manager.appendContextRewrite({
					...batchFor(entryId, edited, manager.getLeafId()!),
					replacements: [{ ...batchFor(entryId, edited, null).replacements[0]!, sourceDigest: "b".repeat(64) }],
				}),
			"stale-source",
		);
		expect(manager.getContextRewrites()).toHaveLength(0);
		expect(manager.getLeafId()).toBe(manager.getBranch().at(-1)!.id);
		manager.close();
	});

	it("rejects malformed batches before touching the journal", () => {
		const manager = SessionManager.inMemory();
		expectViewError(
			() => manager.appendContextRewrite({ schemaVersion: 2 } as unknown as ContextRewriteBatch),
			"unsupported-version",
		);
		expectViewError(
			() => manager.appendContextRewrite({ schemaVersion: 1, batchId: "" } as unknown as ContextRewriteBatch),
			"invalid-record",
		);
		expect(manager.getEntries()).toHaveLength(0);
		manager.close();
	});

	it("reports unknown reserved-namespace entries as unsupported-version", () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry("metis_context_rewrite_v2", { batchId: "x" });
		expectViewError(() => manager.getContextRewrites(), "unsupported-version");
		manager.close();

		const other = SessionManager.inMemory();
		other.appendCustomEntry("metis_context_rewrite_v1", { schemaVersion: 9, batchId: "x" });
		expectViewError(() => other.getContextRewrites(), "unsupported-version");
		other.close();
	});

	it("does not advance the leaf when the writer lease is lost", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-context-rewrite-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(dir, dir);
			const message = toolResult("original");
			const entryId = manager.appendMessage(message);
			const file = manager.getSessionFile()!;
			const leafId = manager.getLeafId();
			SessionLease.forceUnlock(file);
			expect(() => manager!.appendContextRewrite(batchFor(entryId, message, entryId))).toThrow(
				"writer lease was lost",
			);
			expect(manager.getLeafId()).toBe(leafId);
		} finally {
			try {
				manager?.close();
			} catch {
				// close() asserts the already-lost lease; the directory is removed below.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
