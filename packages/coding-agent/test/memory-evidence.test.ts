import type { AgentMessage } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { describe, expect, it } from "vitest";
import { collectMemoryEvidenceBatch, serializeExtractEvidence } from "../src/core/memory/memory-evidence.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

function entry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-21T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

describe("serializeExtractEvidence", () => {
	it("keeps user and capped assistant text, names tools, and omits tool bodies", () => {
		const hugeBody = `HUGE_TOOL_BODY_MARKER_${"x".repeat(50_000)}`;
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Please remember I prefer Chinese replies" }],
				timestamp: 1,
			},
			fauxAssistantMessage(
				[
					{ type: "text", text: "I will check foo.ts for preferences." },
					fauxToolCall("read", { path: "foo.ts" }, { id: "tool-1" }),
				],
				{ stopReason: "toolUse" },
			),
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: hugeBody }],
				details: {},
				isError: false,
				timestamp: 3,
			},
			{
				role: "compactionSummary",
				summary: "should-not-appear-in-evidence",
				tokensBefore: 100,
				timestamp: 4,
			},
			{
				role: "branchSummary",
				summary: "branch-should-not-appear",
				fromId: "a",
				timestamp: 5,
			},
		];

		const evidence = serializeExtractEvidence(messages);

		expect(evidence).toContain("prefer Chinese");
		expect(evidence).toContain("check foo.ts");
		expect(evidence).toMatch(/tool:read\s+path=foo\.ts/);
		expect(evidence).not.toContain("HUGE_TOOL_BODY_MARKER_");
		expect(evidence).not.toContain("should-not-appear-in-evidence");
		expect(evidence).not.toContain("branch-should-not-appear");
		expect(evidence.length).toBeLessThanOrEqual(8000);
	});

	it("caps long assistant text around 2k characters", () => {
		const longAssistant = "A".repeat(5000);
		const messages: AgentMessage[] = [
			{ role: "user", content: "hi", timestamp: 1 },
			fauxAssistantMessage(longAssistant),
		];

		const evidence = serializeExtractEvidence(messages);

		expect(evidence).toContain("A".repeat(100));
		expect(evidence).not.toContain("A".repeat(3000));
		expect(evidence.length).toBeLessThanOrEqual(8000);
	});
});

describe("collectMemoryEvidenceBatch", () => {
	it("processes the oldest complete pending batch and exposes remaining work", () => {
		const batch = collectMemoryEvidenceBatch(
			[entry("old", `OLD_MARKER ${"a".repeat(5_000)}`), entry("new", `NEW_MARKER ${"b".repeat(5_000)}`)],
			null,
		);
		expect(batch.evidence).toContain("OLD_MARKER");
		expect(batch.evidence).not.toContain("NEW_MARKER");
		expect(batch.cursorEntryId).toBe("old");
		expect(batch.hasMore).toBe(true);
	});

	it("caps one oversized oldest entry and advances only through it", () => {
		const batch = collectMemoryEvidenceBatch([entry("huge", "x".repeat(10_000)), entry("later", "later")], null);
		expect(batch.evidence).toHaveLength(8_000);
		expect(batch.cursorEntryId).toBe("huge");
		expect(batch.hasMore).toBe(true);
	});

	it("resumes after a present cursor and replays when it is missing", () => {
		const branch = [entry("a", "first"), entry("b", "second")];
		expect(collectMemoryEvidenceBatch(branch, "a").evidence).toContain("second");
		expect(collectMemoryEvidenceBatch(branch, "missing").evidence).toContain("first");
	});
});
