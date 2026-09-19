import type { AgentMessage } from "@metis/agent-core";
import type { ToolResultMessage } from "@metis/ai";
import { describe, expect, it } from "vitest";
import {
	applyContextRewrites,
	assertContextRewriteBatch,
	type ContextReplacement,
	type ContextRewriteBatch,
	ContextViewError,
	getContextSourceDigest,
} from "../src/core/context-view.ts";

const toolResult = (text: string, callId = "c1"): AgentMessage => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

const batch = (overrides: Partial<ContextRewriteBatch> = {}): ContextRewriteBatch => ({
	schemaVersion: 1,
	batchId: "batch-1",
	expectedLeafId: null,
	reason: "microcompaction",
	replacements: [],
	tokensBefore: 100,
	tokensAfter: 10,
	...overrides,
});

const contentOf = (message: AgentMessage | undefined) => (message as ToolResultMessage).content;

const replacement = (message: AgentMessage, entryId: string, text = "saved: output.txt\n") => ({
	sourceEntryId: entryId,
	sourceDigest: getContextSourceDigest(message),
	artifactRelativePath: "output.txt",
	artifactDigest: "a".repeat(64),
	artifactBytes: 8,
	content: [{ type: "text" as const, text }],
});

describe("applyContextRewrites", () => {
	it("overlays replacement text without mutating the source", () => {
		const message = toolResult("original");
		const replayed = applyContextRewrites(
			[{ entryId: "e1", message }],
			[batch({ replacements: [replacement(message, "e1")] })],
		);
		expect(contentOf(replayed[0])).toEqual([{ type: "text", text: "saved: output.txt\n" }]);
		expect(contentOf(message)).toEqual([{ type: "text", text: "original" }]);
	});

	it("skips sources absent from the current view instead of expanding history", () => {
		const kept = toolResult("kept", "c2");
		const dropped = toolResult("dropped", "c1");
		const replayed = applyContextRewrites(
			[{ entryId: "e2", message: kept }],
			[
				batch({
					replacements: [replacement(dropped, "e1"), replacement(kept, "e2", "saved: kept.txt\n")],
				}),
			],
		);
		expect(replayed).toHaveLength(1);
		expect(contentOf(replayed[0])).toEqual([{ type: "text", text: "saved: kept.txt\n" }]);
	});

	it("applies only the addressed entry when two results share a call id", () => {
		const first = toolResult("first", "c1");
		const second = toolResult("second", "c1");
		const replayed = applyContextRewrites(
			[
				{ entryId: "e1", message: first },
				{ entryId: "e2", message: second },
			],
			[batch({ replacements: [replacement(first, "e1")] })],
		);
		expect(contentOf(replayed[0])).toEqual([{ type: "text", text: "saved: output.txt\n" }]);
		expect(contentOf(replayed[1])).toEqual([{ type: "text", text: "second" }]);
	});

	it("throws stale-source when the recorded digest no longer matches", () => {
		const message = toolResult("original");
		const changed = { ...message, content: [{ type: "text" as const, text: "edited" }] };
		expect(() =>
			applyContextRewrites(
				[{ entryId: "e1", message: changed }],
				[batch({ replacements: [replacement(message, "e1")] })],
			),
		).toThrowError(ContextViewError);
	});

	it("rejects rewriting non-toolResult sources", () => {
		const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
		expect(() =>
			applyContextRewrites([{ entryId: "e1", message: user }], [batch({ replacements: [replacement(user, "e1")] })]),
		).toThrowError(/toolResult/);
	});

	it("rejects a second microcompaction rewrite but allows repair", () => {
		const message = toolResult("original");
		const batches = [
			batch({ batchId: "b1", replacements: [replacement(message, "e1", "first\n")] }),
			batch({ batchId: "b2", replacements: [replacement(message, "e1", "second\n")] }),
		];
		expect(() => applyContextRewrites([{ entryId: "e1", message }], batches)).toThrowError(/twice/);
		const repaired = applyContextRewrites(
			[{ entryId: "e1", message }],
			[
				batches[0]!,
				batch({ batchId: "b3", reason: "artifact_repair", replacements: [replacement(message, "e1", "second\n")] }),
			],
		);
		expect(contentOf(repaired[0])).toEqual([{ type: "text", text: "second\n" }]);
	});
});

describe("assertContextRewriteBatch", () => {
	const good = () => batch({ replacements: [replacement(toolResult("x"), "e1")] });
	const expectCode = (record: unknown, code: string) => {
		try {
			assertContextRewriteBatch(record);
			expect.unreachable("expected a ContextViewError");
		} catch (error) {
			expect(error).toBeInstanceOf(ContextViewError);
			expect((error as ContextViewError).code).toBe(code);
		}
	};

	it("accepts a well-formed batch", () => {
		expect(() => assertContextRewriteBatch(good())).not.toThrow();
	});

	it("reports unsupported schema versions distinctly", () => {
		expectCode({ ...good(), schemaVersion: 2 }, "unsupported-version");
		expectCode({ ...good(), schemaVersion: "one" }, "unsupported-version");
	});

	it("rejects malformed records", () => {
		expectCode(null, "invalid-record");
		expectCode([], "invalid-record");
		expectCode({ ...good(), batchId: "" }, "invalid-record");
		expectCode({ ...good(), expectedLeafId: 3 }, "invalid-record");
		expectCode({ ...good(), reason: "other" }, "invalid-record");
		expectCode({ ...good(), tokensAfter: -1 }, "invalid-record");
		expectCode({ ...good(), tokensBefore: 1.5 }, "invalid-record");
	});

	it("rejects malformed replacements", () => {
		const r = replacement(toolResult("x"), "e1");
		expectCode(batch({ replacements: [{ ...r, sourceDigest: "bad" }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, artifactRelativePath: "../out" }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, artifactRelativePath: "/abs" }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, artifactRelativePath: "a/../b" }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, artifactDigest: "z".repeat(64) }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, artifactBytes: -1 }] }), "invalid-record");
		expectCode(batch({ replacements: [{ ...r, content: [] }] }), "invalid-record");
		expectCode(
			batch({ replacements: [{ ...r, content: [{ type: "image" }] } as unknown as ContextReplacement] }),
			"invalid-record",
		);
		expectCode(batch({ replacements: [r, { ...r, artifactRelativePath: "b.txt" }] }), "invalid-record");
	});
});

it("rechecks source integrity after an extension mutates the same object", () => {
	const message = {
		role: "toolResult" as const,
		toolCallId: "mutated",
		toolName: "read",
		isError: false,
		timestamp: 1,
		content: [{ type: "text" as const, text: "before" }],
	};
	const original = getContextSourceDigest(message);
	message.content[0]!.text = "after";
	expect(getContextSourceDigest(message)).not.toBe(original);
});
