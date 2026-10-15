import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { TurnInputSchema, TurnSteerParamsSchema } from "../src/methods.ts";
import { ItemViewSchema } from "../src/views.ts";

const quote = { sourceItemId: "answer-1", sourceRole: "assistant", selectedText: "Selected words" };
describe("conversation quote protocol", () => {
	it("accepts quotes in turn input and steering but rejects unsupported source roles and fields", () => {
		const input = {
			sessionId: "11111111-1111-4111-8111-111111111111",
			requestId: "22222222-2222-4222-8222-222222222222",
			text: "Explain",
			conversationQuotes: [quote],
		};
		for (const [schema, value] of [
			[TurnInputSchema, input],
			[TurnSteerParamsSchema, { ...input, delivery: "steer" }],
		] as const) {
			const check = Compile(schema);
			expect(check.Check(value)).toBe(true);
			expect(check.Check({ ...value, conversationQuotes: Array(9).fill(quote) })).toBe(false);
			expect(check.Check({ ...value, conversationQuotes: [{ ...quote, sourceRole: "system" }] })).toBe(false);
			expect(check.Check({ ...value, conversationQuotes: [{ ...quote, path: "/private" }] })).toBe(false);
			expect(check.Check({ ...value, conversationQuotes: [{ ...quote, sourceLiveItemId: "live:alias" }] })).toBe(
				false,
			);
		}
	});
	it("projects bounded quote previews while keeping the field optional", () => {
		const check = Compile(ItemViewSchema);
		const item = {
			itemId: "user-1",
			sessionId: "11111111-1111-4111-8111-111111111111",
			role: "user",
			state: "completed",
			content: [],
			createdAt: "2026-10-15T00:00:00Z",
		};
		expect(check.Check(item)).toBe(true);
		expect(check.Check({ ...item, conversationQuotes: [quote] })).toBe(true);
		expect(check.Check({ ...item, conversationQuotes: [{ ...quote, sourceLiveItemId: "live:alias" }] })).toBe(true);
		expect(check.Check({ ...item, conversationQuotes: [{ ...quote, selectedText: "中".repeat(2048) }] })).toBe(false);
	});
});
