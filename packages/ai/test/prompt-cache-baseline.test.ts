import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Context, Tool } from "../src/types.ts";
import { captureWire, normalizeCachePayload, type PromptCacheWireApi } from "./prompt-cache-fixtures.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "prompt-cache");

const roundtripTool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({
		value: Type.String(),
		// A schema property literally named cache_control is real tool content and
		// must survive payload normalization; it is not a provider cache marker.
		cache_control: Type.Optional(Type.String()),
	}),
};

function roundtripContext(): Context {
	return {
		systemPrompt: "You are a deterministic test assistant.",
		tools: [roundtripTool],
		messages: [
			{ role: "user", content: "first user turn", timestamp: 1 },
			fauxAssistantMessage([{ type: "toolCall", id: "call_1", name: "lookup", arguments: { value: "a" } }], {
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "lookup",
				content: [{ type: "text", text: "tool result body\n" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "prompt_cache_breakpoint stays literal user text", timestamp: 3 },
			{ role: "user", content: "complete-plan", timestamp: 4 },
		],
	};
}

function readGolden(name: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Record<string, unknown>;
}

describe("prompt cache baseline wire payloads", () => {
	it("captures the full repeated plan after history", async () => {
		const { body } = await captureWire(
			"anthropic-messages",
			{
				messages: [
					{ role: "user", content: "history", timestamp: 1 },
					{ role: "user", content: "complete-plan", timestamp: 2 },
				],
			},
			{ cacheRetention: "none" },
		);
		expect(JSON.stringify(body.messages)).toContain("history");
		expect(JSON.stringify(body.messages)).toContain("complete-plan");
	});

	for (const api of ["anthropic-messages", "openai-responses"] as const satisfies PromptCacheWireApi[]) {
		it(`matches the stored ${api} golden payload after normalization`, async () => {
			const { body } = await captureWire(api, roundtripContext(), { cacheRetention: "none" });
			expect(normalizeCachePayload(api, body)).toEqual(readGolden(`${api}.json`));
		});
	}

	it("keeps cache-shaped literals inside content through normalization", async () => {
		const { body } = await captureWire("anthropic-messages", roundtripContext(), {
			cacheRetention: "short",
		});
		const normalized = normalizeCachePayload("anthropic-messages", body);
		const serialized = JSON.stringify(normalized);
		expect(serialized).toContain("prompt_cache_breakpoint stays literal user text");
		expect(JSON.stringify(normalized.tools)).toContain('"cache_control"');
	});
});
