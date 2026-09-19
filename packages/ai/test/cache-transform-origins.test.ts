import { expect, it } from "vitest";
import { type MessageTransformTrace, transformMessages } from "../src/api/transform-messages.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Message, Model } from "../src/types.ts";

const model = {
	api: "faux",
	provider: "faux",
	id: "faux-1",
	name: "Faux Model",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1024,
} satisfies Model<string>;

function recordTrace(): { trace: MessageTransformTrace; map: (number | null)[] } {
	const map: (number | null)[] = [];
	return {
		trace: {
			onOutput: (outputIndex, sourceIndex) => {
				map[outputIndex] = sourceIndex;
			},
		},
		map,
	};
}

it("reports a null source for synthetic tool results, not the neighbouring user message", () => {
	const messages: Message[] = [
		fauxAssistantMessage([fauxToolCall("lookup", { value: "a" }, { id: "call_1" })], {
			stopReason: "toolUse",
		}),
		{ role: "user", content: "next", timestamp: 2 },
	];
	const { trace, map } = recordTrace();
	const transformed = transformMessages(messages, model, undefined, trace);
	expect(transformed).toHaveLength(3);
	expect(transformed[1].role).toBe("toolResult");
	expect(map).toEqual([0, null, 1]);
});

it("keeps same-model thinking signatures and reports their source index", () => {
	const messages: Message[] = [
		fauxAssistantMessage([
			{ type: "thinking", thinking: "chain", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		]),
	];
	const { trace, map } = recordTrace();
	const transformed = transformMessages(messages, model, undefined, trace);
	expect(transformed[0]).toMatchObject({
		content: [
			{ type: "thinking", thinking: "chain", thinkingSignature: "sig-1" },
			{ type: "text", text: "answer" },
		],
	});
	expect(map).toEqual([0]);
});

it("filters error assistant messages without emitting a trace entry", () => {
	const messages: Message[] = [
		fauxAssistantMessage("broken", { stopReason: "error", errorMessage: "boom" }),
		{ role: "user", content: "retry", timestamp: 2 },
	];
	const { trace, map } = recordTrace();
	const transformed = transformMessages(messages, model, undefined, trace);
	expect(transformed).toEqual([{ role: "user", content: "retry", timestamp: 2 }]);
	expect(map).toEqual([1]);
});
