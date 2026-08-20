import type { AgentMessage } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { describe, expect, it } from "vitest";
import { serializeExtractEvidence } from "../src/core/memory/memory-evidence.ts";

describe("serializeExtractEvidence", () => {
	it("keeps user and capped assistant text, names tools, and omits tool bodies", () => {
		const hugeBody = "HUGE_TOOL_BODY_MARKER_" + "x".repeat(50_000);
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
