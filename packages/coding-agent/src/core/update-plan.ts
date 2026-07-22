import { Text } from "@arcmind/tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "./extensions/types.ts";
import { getTextOutput } from "./tools/render-utils.ts";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
	step: string;
	status: PlanStepStatus;
}

export interface UpdatePlanDetails {
	plan: PlanStep[];
}

export const UpdatePlanParams = Type.Object(
	{
		plan: Type.Array(
			Type.Object(
				{
					step: Type.String(),
					status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type UpdatePlanInput = Static<typeof UpdatePlanParams>;

function normalizePlan(input: UpdatePlanInput): UpdatePlanDetails {
	const plan = input.plan.map(({ step, status }) => ({ step: step.trim(), status }));
	if (plan.some(({ step }) => step.length === 0)) throw new TypeError("Plan steps cannot be empty");
	if (plan.filter(({ status }) => status === "in_progress").length > 1) {
		throw new TypeError("Only one plan step can be in progress");
	}
	return { plan };
}

function formatPlanResult({ plan }: UpdatePlanDetails): string {
	if (plan.length === 0) return '<latest_plan state="cleared" />';
	const state = plan.every(({ status }) => status === "completed") ? "completed" : "active";
	return [
		`<latest_plan state="${state}">`,
		...plan.map(({ step, status }, index) => `${index + 1}. [${status}] ${step}`),
		"</latest_plan>",
	].join("\n");
}

function formatPlanForTui(input: Partial<UpdatePlanInput> | undefined, theme: Theme): string {
	const plan = Array.isArray(input?.plan) ? input.plan : [];
	if (plan.length === 0) return theme.fg("toolTitle", theme.bold("Cleared Plan"));
	const completed = plan.filter(({ status }) => status === "completed").length;
	const lines = [theme.fg("toolTitle", theme.bold(`Plan · ${completed}/${plan.length}`))];
	for (const item of plan) {
		if (item.status === "completed") {
			lines.push(`${theme.fg("success", "[✓]")} ${theme.fg("muted", item.step.trim())}`);
		} else if (item.status === "in_progress") {
			lines.push(`${theme.fg("accent", "[→]")} ${theme.fg("text", item.step.trim())}`);
		} else {
			lines.push(`${theme.fg("muted", "[ ]")} ${theme.fg("muted", item.step.trim())}`);
		}
	}
	return lines.join("\n");
}

export function createUpdatePlanToolDefinition(): ToolDefinition<typeof UpdatePlanParams, UpdatePlanDetails> {
	return {
		name: "update_plan",
		label: "Plan",
		description:
			"Replace the complete plan for complex multi-step work. Do not use for simple tasks. Keep at most one step in_progress; an empty plan explicitly clears it.",
		promptSnippet: "Track meaningful progress for complex multi-step work",
		promptGuidelines: [
			"Use update_plan only for complex multi-step tasks where progress tracking helps the user; skip it for simple requests.",
			"Send the complete concise plan on every call, update it only when structure or progress meaningfully changes, and keep at most one step in_progress.",
		],
		parameters: UpdatePlanParams,
		executionMode: "sequential",
		renderShell: "self",
		async execute(_toolCallId, input) {
			const details = normalizePlan(input);
			return { content: [{ type: "text", text: formatPlanResult(details) }], details };
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 1);
			const plan = Array.isArray(args?.plan) ? args.plan : [];
			const background =
				plan.length > 0 && plan.every(({ status }) => status === "completed") ? "toolSuccessBg" : "toolPendingBg";
			text.setCustomBgFn(context.isError ? undefined : (line) => theme.bg(background, line));
			text.setText(context.isError ? "" : formatPlanForTui(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 1, 1);
			text.setCustomBgFn(context.isError ? (line) => theme.bg("toolErrorBg", line) : undefined);
			text.setText(context.isError ? theme.fg("error", getTextOutput(result, context.showImages)) : "");
			return text;
		},
	};
}
