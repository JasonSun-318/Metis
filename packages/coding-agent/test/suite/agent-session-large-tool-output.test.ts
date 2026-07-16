import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@arcmind/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@arcmind/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { LARGE_TOOL_OUTPUT_MAX_CHARS } from "../../src/core/large-tool-output.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("large external tool output", () => {
	it("externalizes the final message_end replacement before persistence and the next model call", async () => {
		const fullText = "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const extensionFactories: ExtensionFactory[] = [
			(arcmind) => {
				arcmind.registerTool({
					name: "external_search",
					label: "External Search",
					description: "Return external search output",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "small before message_end" }],
						details: { preserved: true },
					}),
				});
				arcmind.on("message_end", (event) => {
					if (event.message.role !== "toolResult" || event.message.toolName !== "external_search") return;
					return {
						message: {
							...event.message,
							content: [{ type: "text", text: fullText }],
						},
					};
				});
			},
		];
		const harness = await createHarness({ extensionFactories });
		let outputDir: string | undefined;
		try {
			let providerText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("external_search", {}), { stopReason: "toolUse" }),
				(context) => {
					const result = context.messages.find((message) => message.role === "toolResult");
					providerText = getMessageText(result);
					expect(result).not.toHaveProperty("toolOutput");
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("search");

			const entry = harness.sessionManager
				.getEntries()
				.find((item): item is SessionMessageEntry => item.type === "message" && item.message.role === "toolResult");
			expect(entry?.toolOutput).toMatchObject({
				truncated: true,
				originalBytes: LARGE_TOOL_OUTPUT_MAX_CHARS + 1,
				previewBytes: 2_048,
			});
			expect(entry?.message.role).toBe("toolResult");
			if (entry?.message.role !== "toolResult" || !entry.toolOutput) throw new Error("missing stored tool output");
			outputDir = dirname(entry.toolOutput.fullOutputPath);
			expect(entry.message.details).toEqual({ preserved: true });
			expect(providerText).toContain("Tool output truncated: preview only");
			expect(providerText).toContain(`Full output: ${entry.toolOutput.fullOutputPath}`);
			expect(providerText).not.toContain(fullText);
			expect(readFileSync(entry.toolOutput.fullOutputPath, "utf8")).toBe(fullText);
		} finally {
			if (outputDir) rmSync(outputDir, { recursive: true, force: true });
			await harness.cleanup();
		}
	});

	it("leaves builtin tool results on their existing path", async () => {
		const fullText = "b".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const builtinTool: AgentTool = {
			name: "builtin_test",
			label: "Builtin Test",
			description: "Return builtin output",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: fullText }], details: {} }),
		};
		const harness = await createHarness({ tools: [builtinTool] });
		try {
			let providerText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("builtin_test", {}), { stopReason: "toolUse" }),
				(context) => {
					providerText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("run builtin");

			const entry = harness.sessionManager
				.getEntries()
				.find((item): item is SessionMessageEntry => item.type === "message" && item.message.role === "toolResult");
			expect(entry?.toolOutput).toBeUndefined();
			expect(entry?.message.role === "toolResult" ? getMessageText(entry.message) : "").toBe(fullText);
			expect(providerText).toBe(fullText);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps the original external result when persistence fails", async () => {
		const fullText = "f".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const extensionFactories: ExtensionFactory[] = [
			(arcmind) => {
				arcmind.registerTool({
					name: "external_failure",
					label: "External Failure",
					description: "Return output that cannot be persisted",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: fullText }], details: {} }),
				});
			},
		];
		const harness = await createHarness({ extensionFactories });
		const getToolOutputDir = harness.sessionManager.getToolOutputDir.bind(harness.sessionManager);
		try {
			harness.sessionManager.getToolOutputDir = () => {
				throw new Error("blocked output directory");
			};
			let providerText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("external_failure", {}), { stopReason: "toolUse" }),
				(context) => {
					providerText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("run external tool");

			const entry = harness.sessionManager
				.getEntries()
				.find((item): item is SessionMessageEntry => item.type === "message" && item.message.role === "toolResult");
			expect(entry?.toolOutput).toBeUndefined();
			expect(entry?.message.role === "toolResult" ? getMessageText(entry.message) : "").toBe(fullText);
			expect(providerText).toBe(fullText);
		} finally {
			harness.sessionManager.getToolOutputDir = getToolOutputDir;
			await harness.cleanup();
		}
	});
});
