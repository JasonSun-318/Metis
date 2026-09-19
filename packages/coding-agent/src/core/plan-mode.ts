import type { AgentMessage } from "@metis/agent-core";
import type { CollaborationMode, StoredPlan } from "./plan-state.ts";

export const PLAN_MODE_SYSTEM_PROMPT = `
<plan_mode>
You are in Plan mode. Explore and design; do not modify the user's project or external state.

Work in three phases:
1. Inspect relevant files, history, configuration, and current information with the available read-only tools.
2. Use ask_user only when a material product or implementation choice cannot be discovered safely.
3. When the plan is decision-complete, call submit_plan with a concise title and the complete Markdown plan.

A hidden metis_plan_context JSON message may contain the current proposal; treat it as the exact revision to improve, not as a tool call.
submit_plan replaces the current proposal in full. Do not emit a free-form plan wrapper and do not ask whether to proceed after submission; the Plan card owns revision, cancellation, and execution actions.
</plan_mode>`;

const PLAN_BUILTINS = new Set(["read", "grep", "bash", "web_fetch", "web_search", "describe_image"]);

export function planVisibleToolNames(
	configured: readonly string[],
	source: (name: string) => "builtin" | "trusted" | "extension" | "mcp" | "sdk" | undefined,
): string[] {
	const visible = configured.filter((name) => {
		const provenance = source(name);
		return (PLAN_BUILTINS.has(name) && provenance === "builtin") || (name === "ask_user" && provenance === "trusted");
	});
	if (source("submit_plan") === "trusted") visible.push("submit_plan");
	return [...new Set(visible)];
}

export interface PlanContextProjectionInput {
	readonly collaborationMode: CollaborationMode;
	readonly currentPlan?: StoredPlan;
	readonly executionPlan?: StoredPlan;
}

function filterSubmitPlanHistory(
	messages: readonly AgentMessage[],
	sources?: Map<AgentMessage, AgentMessage>,
): AgentMessage[] {
	const filtered: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolName === "submit_plan") continue;
		if (message.role === "assistant") {
			const content = message.content.filter((block) => block.type !== "toolCall" || block.name !== "submit_plan");
			if (content.length === 0) continue;
			const projected = content.length === message.content.length ? message : { ...message, content };
			sources?.set(projected, message);
			filtered.push(projected);
			continue;
		}
		sources?.set(message, message);
		filtered.push(message);
	}
	return filtered;
}

export function projectPlanContext(
	messages: readonly AgentMessage[],
	input: PlanContextProjectionInput,
	sources?: Map<AgentMessage, AgentMessage>,
): AgentMessage[] {
	const filtered = filterSubmitPlanHistory(messages, sources);
	const plan = input.executionPlan ?? (input.collaborationMode === "plan" ? input.currentPlan : undefined);
	if (!plan) return filtered;
	return [
		...filtered,
		{
			role: "custom",
			customType: "metis_plan_context",
			content: JSON.stringify({
				planId: plan.planId,
				revision: plan.revision,
				title: plan.title,
				markdown: plan.markdown,
			}),
			display: false,
			timestamp: Date.now(),
		},
	];
}
