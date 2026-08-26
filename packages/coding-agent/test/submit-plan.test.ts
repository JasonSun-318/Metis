import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { MAX_PLAN_MARKDOWN_UTF8_BYTES } from "../src/core/plan-state.ts";
import { createSubmitPlanToolDefinition } from "../src/core/submit-plan.ts";

describe("submit_plan tool", () => {
	it("rejects multibyte markdown above the UTF-8 byte limit", async () => {
		const tool = createSubmitPlanToolDefinition(() => ({
			entryId: "p1",
			parentId: null,
			planId: "plan-a",
			revision: 1,
			title: "Plan",
			markdown: "# Plan",
			status: "proposed",
			createdAt: "2026-08-25T00:00:00.000Z",
		}));
		const markdown = "😀".repeat(MAX_PLAN_MARKDOWN_UTF8_BYTES);
		await expect(
			tool.execute("call-1", { title: "Plan", markdown }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow(/65536 UTF-8 bytes/iu);
	});

	it("trims title and markdown before submission", async () => {
		let captured: { title: string; markdown: string } | undefined;
		const tool = createSubmitPlanToolDefinition((input) => {
			captured = input;
			return {
				entryId: "p1",
				parentId: null,
				planId: "plan-a",
				revision: 1,
				title: input.title,
				markdown: input.markdown,
				status: "proposed",
				createdAt: "2026-08-25T00:00:00.000Z",
			};
		});
		const result = await tool.execute(
			"call-1",
			{ title: "  Plan title  ", markdown: "  # Body  " },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(captured).toEqual({ title: "Plan title", markdown: "# Body" });
		expect(result.terminate).toBe(true);
	});
});
