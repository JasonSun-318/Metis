import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { LARGE_TOOL_OUTPUT_MAX_CHARS } from "../../src/core/large-tool-output.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { noEffectTestPermission } from "../helpers/tool-definition.ts";
import { createHarness, getMessageText } from "./harness.ts";

describe("large tool output", () => {
	it("externalizes built-in web_fetch output before the next model call", async () => {
		const fullText = "w".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const harness = await createHarness();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(
			async () => new Response(fullText, { headers: { "content-type": "text/plain" } }),
		) as typeof fetch;
		let outputDir: string | undefined;
		try {
			let providerText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/large" }), {
					stopReason: "toolUse",
				}),
				(context) => {
					providerText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("fetch a large page");

			const entry = harness.sessionManager
				.getEntries()
				.find((item): item is SessionMessageEntry => item.type === "message" && item.message.role === "toolResult");
			expect(entry?.toolOutput).toMatchObject({
				truncated: true,
				originalBytes: LARGE_TOOL_OUTPUT_MAX_CHARS + 1,
				previewBytes: 2_048,
			});
			if (!entry?.toolOutput) throw new Error("missing stored web_fetch output");
			outputDir = dirname(entry.toolOutput.fullOutputPath);
			expect(providerText).toContain("Tool output truncated: preview only");
			expect(providerText).toContain(`Full output: ${entry.toolOutput.fullOutputPath}`);
			expect(providerText).not.toContain(fullText);
			expect(readFileSync(entry.toolOutput.fullOutputPath, "utf8")).toBe(fullText);
		} finally {
			globalThis.fetch = originalFetch;
			if (outputDir) rmSync(outputDir, { recursive: true, force: true });
			await harness.cleanup();
		}
	});

	it("externalizes built-in web_search output before the next model call", async () => {
		const fullSnippet = "s".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const harness = await createHarness({ settings: { webSearch: { enabled: true, provider: "tavily" } } });
		harness.authStorage.set("web-search:tavily", { type: "api_key", key: "secret" });
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () =>
			Response.json({ results: [{ title: "Large", url: "https://example.com", content: fullSnippet }] }),
		) as typeof fetch;
		let outputDir: string | undefined;
		try {
			let providerText = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", { query: "large" }), { stopReason: "toolUse" }),
				(context) => {
					providerText = getMessageText(context.messages.find((message) => message.role === "toolResult"));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("search");
			const entry = harness.sessionManager
				.getEntries()
				.find((item): item is SessionMessageEntry => item.type === "message" && item.message.role === "toolResult");
			expect(entry?.toolOutput).toMatchObject({ truncated: true, previewBytes: 2_048 });
			if (!entry?.toolOutput) throw new Error("missing stored web_search output");
			outputDir = dirname(entry.toolOutput.fullOutputPath);
			expect(providerText).toContain("Tool output truncated: preview only");
			expect(providerText).toContain(entry.toolOutput.fullOutputPath);
			expect(providerText).not.toContain(fullSnippet);
			expect(readFileSync(entry.toolOutput.fullOutputPath, "utf8")).toContain(fullSnippet);
		} finally {
			globalThis.fetch = originalFetch;
			if (outputDir) rmSync(outputDir, { recursive: true, force: true });
			await harness.cleanup();
		}
	});

	it("externalizes the final message_end replacement before persistence and the next model call", async () => {
		const fullText = "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const extensionFactories: ExtensionFactory[] = [
			(metis) => {
				metis.registerTool({
					name: "external_search",
					label: "External Search",
					description: "Return external search output",
					parameters: Type.Object({}),
					permission: noEffectTestPermission(),
					execute: async () => ({
						content: [{ type: "text", text: "small before message_end" }],
						details: { preserved: true },
					}),
				});
				metis.on("message_end", (event) => {
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

	it("treats SDK base-tool overrides as external tool results", async () => {
		const fullText = "b".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const builtinTool: AgentTool = {
			name: "builtin_test",
			label: "Builtin Test",
			description: "Return builtin output",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: fullText }], details: {} }),
		};
		const harness = await createHarness({ tools: [builtinTool] });
		let outputDir: string | undefined;
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
			expect(entry?.toolOutput).toMatchObject({ truncated: true, originalBytes: fullText.length });
			if (!entry?.toolOutput) throw new Error("missing stored SDK tool output");
			outputDir = dirname(entry.toolOutput.fullOutputPath);
			expect(entry?.message.role === "toolResult" ? getMessageText(entry.message) : "").toContain(
				"Tool output truncated: preview only",
			);
			expect(providerText).toContain("Tool output truncated: preview only");
			expect(readFileSync(entry.toolOutput.fullOutputPath, "utf8")).toBe(fullText);
		} finally {
			if (outputDir) rmSync(outputDir, { recursive: true, force: true });
			await harness.cleanup();
		}
	});

	it("keeps a bounded external result when persistence fails", async () => {
		const fullText = "f".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const extensionFactories: ExtensionFactory[] = [
			(metis) => {
				metis.registerTool({
					name: "external_failure",
					label: "External Failure",
					description: "Return output that cannot be persisted",
					parameters: Type.Object({}),
					permission: noEffectTestPermission(),
					execute: async () => ({ content: [{ type: "text", text: fullText }], details: {} }),
				});
			},
		];
		const harness = await createHarness({ extensionFactories });
		const blockedOutputDir = join(tmpdir(), "metis-tool-results", harness.sessionManager.getSessionId());
		try {
			mkdirSync(dirname(blockedOutputDir), { recursive: true });
			writeFileSync(blockedOutputDir, "blocked output directory");
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
			const persistedText = entry?.message.role === "toolResult" ? getMessageText(entry.message) : "";
			expect(persistedText).toContain("Full output could not be saved");
			expect(persistedText.length).toBeLessThan(fullText.length);
			expect(providerText).toBe(persistedText);
		} finally {
			rmSync(blockedOutputDir, { recursive: true, force: true });
			await harness.cleanup();
		}
	});
});
