import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@arcmind/agent-core";
import { fauxAssistantMessage } from "@arcmind/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { MICROCOMPACTION_KEEP_RECENT } from "../../src/core/tool-result-microcompaction.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("AgentSession tool-result microcompaction", () => {
	it("projects old builtin results only at the provider seam and removes ephemeral files on dispose", async () => {
		const harness = await createHarness();
		const outputDir = join(tmpdir(), "arcmind-tool-results", harness.sessionManager.getSessionId());
		const original = "x".repeat(80_000);
		try {
			for (let index = 0; index < MICROCOMPACTION_KEEP_RECENT + 1; index++) {
				const message = {
					role: "toolResult" as const,
					toolCallId: `read-${index}`,
					toolName: "read",
					content: [{ type: "text" as const, text: index === 0 ? original : `recent-${index}` }],
					details: {},
					isError: false,
					timestamp: index,
				};
				harness.session.agent.state.messages.push(message);
				harness.sessionManager.appendMessage(message);
			}

			let providerToolText = "";
			harness.setResponses([
				(context) => {
					providerToolText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("continue");

			expect(providerToolText).toContain("tool-result-cleared");
			expect(getMessageText(harness.session.messages.find((message) => message.role === "toolResult"))).toBe(
				original,
			);
			const stored = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
			expect(stored?.type === "message" ? getMessageText(stored.message) : "").toBe(original);
			expect(readdirSync(outputDir)).toHaveLength(1);
			expect(readFileSync(join(outputDir, readdirSync(outputDir)[0]!), "utf8")).toBe(original);
		} finally {
			await harness.cleanup();
		}
		expect(existsSync(outputDir)).toBe(false);
	});

	it("does not compact an SDK base-tool override that shadows a builtin name", async () => {
		const readOverride: AgentTool = {
			name: "read",
			label: "SDK read",
			description: "SDK override",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
		};
		const harness = await createHarness({ tools: [readOverride] });
		const outputDir = join(tmpdir(), "arcmind-tool-results", harness.sessionManager.getSessionId());
		try {
			for (let index = 0; index < MICROCOMPACTION_KEEP_RECENT + 1; index++) {
				harness.session.agent.state.messages.push({
					role: "toolResult",
					toolCallId: `read-${index}`,
					toolName: "read",
					content: [{ type: "text", text: index === 0 ? "x".repeat(80_000) : "recent" }],
					details: {},
					isError: false,
					timestamp: index,
				});
			}

			let providerToolText = "";
			harness.setResponses([
				(context) => {
					providerToolText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("continue");

			expect(providerToolText).not.toContain("tool-result-cleared");
			expect(providerToolText).toHaveLength(80_000);
			expect(existsSync(outputDir)).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
