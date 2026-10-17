import { describe, expect, it } from "vitest";
import { projectCodeChanges } from "../src/code-change-projection.ts";
import { projectLiveMessage, projectMessageEntry } from "../src/item-projection.ts";

const codeChanges = {
	version: 1,
	sequence: 2,
	files: [{ path: "app.ts", kind: "modified", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-old\n+new\n" }],
	partial: false,
	turn: { additions: 0, deletions: 0, partial: false },
};

describe("Code change projection", () => {
	it("preserves the same historical diff and turn net counts in live and journal items, including errors", () => {
		const timestamp = "2026-10-16T12:00:00.000Z";
		const message = {
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: true,
			content: [{ type: "text", text: "failed after edit" }],
			details: { codeChanges },
			timestamp: Date.parse(timestamp),
		};
		const live = projectLiveMessage({
			itemId: "item-1",
			sessionId: "session-1",
			turnId: "turn-1",
			state: "completed",
			message,
			fallbackTimestamp: timestamp,
		});
		const journal = projectMessageEntry({
			entry: { type: "message", id: "item-1", turnId: "turn-1", timestamp, message },
			sessionId: "session-1",
			turnStates: new Map(),
			toolStates: new Map(),
			fallbackTimestamp: timestamp,
		});
		expect(live?.content).toEqual(journal?.content);
		expect(live?.content[0]).toMatchObject({ codeChanges, isError: true });
	});

	it("omits legacy, malformed, unsupported and oversized metadata without dropping the result", () => {
		for (const details of [
			undefined,
			{ diff: "old diff" },
			{ codeChanges: { ...codeChanges, version: 2 } },
			{ codeChanges: { ...codeChanges, sequence: -1 } },
			{ codeChanges: { ...codeChanges, files: [{ ...codeChanges.files[0], diff: "x".repeat(17 * 1024) }] } },
		]) {
			expect(projectCodeChanges(details)).toBeUndefined();
		}
	});

	it("does not expose arbitrary private tool details", () => {
		expect(projectCodeChanges({ before: "private snapshot", codeChanges })).toEqual(codeChanges);
		expect(projectCodeChanges({ codeChanges: { ...codeChanges, before: "private snapshot" } })).toBeUndefined();
	});
});
