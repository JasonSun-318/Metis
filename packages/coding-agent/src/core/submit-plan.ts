import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "./extensions/types.ts";
import { MAX_PLAN_MARKDOWN_UTF8_BYTES, type StoredPlan } from "./plan-state.ts";

export const SubmitPlanParams = Type.Object(
	{
		title: Type.String({ minLength: 1, maxLength: 256 }),
		markdown: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type SubmitPlanInput = Static<typeof SubmitPlanParams>;

export function createSubmitPlanToolDefinition(
	submit: (input: SubmitPlanInput) => StoredPlan,
): ToolDefinition<typeof SubmitPlanParams, StoredPlan> {
	return {
		name: "submit_plan",
		label: "Submit plan",
		description:
			"Submit the complete current implementation plan. This replaces the previous proposal in full and is available only in Plan mode.",
		parameters: SubmitPlanParams,
		executionMode: "sequential",
		execute: async (_toolCallId, raw) => {
			if (!Value.Check(SubmitPlanParams, raw)) throw new TypeError("Invalid submit_plan arguments");
			const input = { title: raw.title.trim(), markdown: raw.markdown.trim() };
			if (!input.title || !input.markdown) throw new TypeError("Plan title and Markdown cannot be blank");
			if (Buffer.byteLength(input.markdown, "utf8") > MAX_PLAN_MARKDOWN_UTF8_BYTES) {
				throw new TypeError("Plan Markdown exceeds 65536 UTF-8 bytes");
			}
			const plan = submit(input);
			return {
				content: [{ type: "text", text: `Plan submitted: ${plan.planId} revision ${plan.revision}` }],
				details: plan,
				terminate: true,
			};
		},
	};
}
