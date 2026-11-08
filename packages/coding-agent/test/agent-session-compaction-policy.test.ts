import type { AssistantMessage, Model } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import { isAssistantBeforeCompaction, isSameModel } from "../src/core/agent-session-compaction-policy.ts";

function message(provider: string, model: string): AssistantMessage {
	return { provider, model } as unknown as AssistantMessage;
}

function model(provider: string, id: string): Model<any> {
	return { provider, id } as unknown as Model<any>;
}

describe("agent session compaction policy", () => {
	it("only treats overflow from the same model as compaction-relevant", () => {
		expect(isSameModel(message("anthropic", "claude"), model("anthropic", "claude"))).toBe(true);
		expect(isSameModel(message("anthropic", "claude"), model("openai", "gpt"))).toBe(false);
		expect(isSameModel(message("anthropic", "claude"), model("anthropic", "other"))).toBe(false);
		expect(isSameModel(message("anthropic", "claude"), undefined)).toBe(false);
	});

	it("ignores assistant messages at or before the last compaction boundary", () => {
		expect(isAssistantBeforeCompaction(10, undefined)).toBe(false);
		expect(isAssistantBeforeCompaction(10, 10)).toBe(true);
		expect(isAssistantBeforeCompaction(9, 10)).toBe(true);
		expect(isAssistantBeforeCompaction(11, 10)).toBe(false);
	});
});
