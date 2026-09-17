import type { AgentTool } from "@metis/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@metis/ai";
import { describe, expect, it } from "vitest";
import { createDreamPromptAgent, createDreamPromptFn, resolveDreamModel } from "../src/core/memory/dream/llm.ts";
import { PROPOSE_MEMORIES_TOOL } from "../src/core/memory/dream/phase1.ts";

const model = (id: string, input: number, provider = "test"): Model<never> =>
	({
		id,
		name: id,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	}) as unknown as Model<never>;

describe("dream llm", () => {
	it("resolveDreamModel picks the cheapest credentialed model", () => {
		const models = [model("expensive", 5), model("cheap", 0.5), model("mid", 2)];
		const registry = { getAll: () => models, getAvailable: () => models };
		expect(resolveDreamModel(registry)?.id).toBe("cheap");
		expect(resolveDreamModel(registry, { provider: "test", modelId: "mid" })?.id).toBe("mid");
		expect(resolveDreamModel(registry, { provider: "test", modelId: "missing" })).toBeUndefined();
		expect(resolveDreamModel({ getAll: () => [], getAvailable: () => [] })).toBeUndefined();
	});

	function captureStream(reply: () => AssistantMessage) {
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn = (_m: Model<never>, context: Context, options?: SimpleStreamOptions) => {
			calls.push({ context, options });
			const stream = createAssistantMessageEventStream();
			const message = reply();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message,
				} satisfies AssistantMessageEvent);
			});
			return stream;
		};
		return { calls, streamFn: streamFn as never };
	}

	it("phase 1 promptFn streams with cacheRetention none and captures tool args", async () => {
		const { calls, streamFn } = captureStream(() =>
			fauxAssistantMessage(
				[
					{
						type: "toolCall",
						id: "call-1",
						name: PROPOSE_MEMORIES_TOOL.name,
						arguments: { candidates: [{ text: "remember this" }] },
					},
				],
				{ stopReason: "toolUse" },
			),
		);
		const promptFn = createDreamPromptFn({ model: model("cheap", 0.1), streamFn });
		const captured = await promptFn({
			system: "sys",
			user: "transcript",
			tool: PROPOSE_MEMORIES_TOOL,
			toolChoice: "required",
		});
		expect(captured).toEqual({ candidates: [{ text: "remember this" }] });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options?.cacheRetention).toBe("none");
		expect(calls[0]!.options?.toolChoice).toBe("required");
	});

	it("phase 2 promptAgent streams with cacheRetention none and runs tools", async () => {
		const calls: unknown[][] = [];
		let round = 0;
		const { calls: streams, streamFn } = captureStream(() => {
			round += 1;
			if (round === 1) {
				return fauxAssistantMessage(
					[
						{
							type: "toolCall",
							id: "call-1",
							name: "memory_search",
							arguments: { query: "pnpm" },
						},
					],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([{ type: "toolCall", id: "call-2", name: "finish_dream", arguments: {} }], {
				stopReason: "toolUse",
			});
		});
		const promptAgent = createDreamPromptAgent({ model: model("cheap", 0.1), streamFn });
		const searchTool: AgentTool = {
			name: "memory_search",
			label: "Memory search",
			description: "search",
			parameters: { type: "object" } as never,
			async execute(_id, params) {
				calls.push(["memory_search", params]);
				return { content: [{ type: "text", text: "no hits" }], details: { ok: true } };
			},
		};
		const finishTool: AgentTool = {
			name: "finish_dream",
			label: "Finish",
			description: "finish",
			parameters: { type: "object" } as never,
			async execute() {
				calls.push(["finish_dream", {}]);
				return { content: [{ type: "text", text: "done" }], details: { ok: true }, terminate: true };
			},
		};
		await promptAgent({
			system: "sys",
			user: "payload",
			tools: [searchTool, finishTool],
			callTool: async () => ({ content: [], details: undefined }),
			signal: new AbortController().signal,
		});
		expect(calls.map((c) => c[0])).toEqual(["memory_search", "finish_dream"]);
		expect(streams.every((call) => call.options?.cacheRetention === "none")).toBe(true);
	});
});
