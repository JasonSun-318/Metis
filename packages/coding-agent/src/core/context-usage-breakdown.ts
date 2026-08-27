import type { AgentMessage } from "@metis/agent-core";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens, type Tool } from "@metis/ai";
import type { ContextUsageBreakdownItem, ContextUsageCategory } from "./extensions/types.ts";
import { convertToLlm } from "./messages.ts";
import { parseSkillBlock } from "./skills.ts";
import type { SystemPromptPart } from "./system-prompt.ts";

export const CONTEXT_USAGE_CATEGORY_ORDER: readonly ContextUsageCategory[] = [
	"system_prompt",
	"tool_definitions",
	"rules",
	"skills",
	"mcp_dynamic_tools",
	"agent_definitions",
	"summarized_conversation",
	"conversation",
];

export const FIXED_CONTEXT_USAGE_CATEGORIES: ReadonlySet<ContextUsageCategory> = new Set([
	"system_prompt",
	"tool_definitions",
	"rules",
	"skills",
	"mcp_dynamic_tools",
	"agent_definitions",
]);

type ToolCategory = "tool_definitions" | "mcp_dynamic_tools" | "agent_definitions";

export interface EstimateContextUsageBreakdownInput {
	readonly systemPromptParts: readonly SystemPromptPart[];
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly Tool[];
	readonly toolCategories: ReadonlyMap<string, ToolCategory>;
}

function textContent(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is Extract<(typeof message.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

export function mergeContextUsageBreakdown(
	...groups: (readonly ContextUsageBreakdownItem[])[]
): ContextUsageBreakdownItem[] {
	const totals = new Map<ContextUsageCategory, number>();
	for (const group of groups) {
		for (const item of group) {
			const tokens = Math.max(0, Math.trunc(item.tokens));
			if (tokens > 0) totals.set(item.category, (totals.get(item.category) ?? 0) + tokens);
		}
	}
	return CONTEXT_USAGE_CATEGORY_ORDER.flatMap((category) => {
		const tokens = totals.get(category) ?? 0;
		return tokens > 0 ? [{ category, tokens }] : [];
	});
}

export function estimateContextUsageBreakdown(input: EstimateContextUsageBreakdownInput): ContextUsageBreakdownItem[] {
	const totals = new Map<ContextUsageCategory, number>();
	const add = (category: ContextUsageCategory, tokens: number): void => {
		const normalized = Math.max(0, Math.trunc(tokens));
		if (normalized > 0) totals.set(category, (totals.get(category) ?? 0) + normalized);
	};

	for (const part of input.systemPromptParts) add(part.category, estimateTextTokens(part.content));

	for (const tool of input.tools) {
		add(
			input.toolCategories.get(tool.name) ?? "tool_definitions",
			estimateContextTokens({ messages: [], tools: [tool] }).tokens,
		);
	}

	for (const message of input.messages) {
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			continue;
		}
		const converted = convertToLlm([message]);
		const messageTokens = converted.reduce((sum, item) => sum + estimateMessageTokens(item), 0);
		if (messageTokens === 0) continue;
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			add("summarized_conversation", messageTokens);
			continue;
		}
		const parsedSkill = textContent(message);
		const skill = parsedSkill ? parseSkillBlock(parsedSkill) : null;
		if (skill) {
			const skillTokens = Math.min(messageTokens, estimateTextTokens(skill.skillText));
			add("skills", skillTokens);
			add("conversation", messageTokens - skillTokens);
			continue;
		}
		add("conversation", messageTokens);
	}

	return mergeContextUsageBreakdown(
		CONTEXT_USAGE_CATEGORY_ORDER.flatMap((category) => {
			const tokens = totals.get(category) ?? 0;
			return tokens > 0 ? [{ category, tokens }] : [];
		}),
	);
}

export function reconcileContextUsageBreakdown(
	raw: readonly ContextUsageBreakdownItem[],
	total: number,
): ContextUsageBreakdownItem[] {
	const normalizedTotal = Math.max(0, Math.trunc(total));
	if (normalizedTotal === 0) return [];
	const merged = mergeContextUsageBreakdown(raw);
	const rawTotal = merged.reduce((sum, item) => sum + item.tokens, 0);
	if (rawTotal === 0) return [];
	if (rawTotal === normalizedTotal) return merged;

	const scaled = merged.map((item, index) => {
		const exact = (item.tokens * normalizedTotal) / rawTotal;
		return { item, index, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	let remaining = normalizedTotal - scaled.reduce((sum, item) => sum + item.tokens, 0);
	for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
		if (remaining === 0) break;
		item.tokens += 1;
		remaining -= 1;
	}
	return scaled.filter((item) => item.tokens > 0).map(({ item, tokens }) => ({ category: item.category, tokens }));
}

export function reconcileContextUsageBreakdownWithFixed(
	raw: readonly ContextUsageBreakdownItem[],
	total: number,
	fixed: readonly ContextUsageBreakdownItem[],
): ContextUsageBreakdownItem[] {
	const normalizedTotal = Math.max(0, Math.trunc(total));
	const fixedBreakdown = mergeContextUsageBreakdown(
		fixed.filter((item) => FIXED_CONTEXT_USAGE_CATEGORIES.has(item.category)),
	);
	const fixedTotal = fixedBreakdown.reduce((sum, item) => sum + item.tokens, 0);
	if (fixedTotal > normalizedTotal) return [];

	const dynamicTotal = normalizedTotal - fixedTotal;
	if (dynamicTotal === 0) return fixedBreakdown;
	const dynamicBreakdown = reconcileContextUsageBreakdown(
		raw.filter((item) => !FIXED_CONTEXT_USAGE_CATEGORIES.has(item.category)),
		dynamicTotal,
	);
	return dynamicBreakdown.length > 0 ? mergeContextUsageBreakdown(fixedBreakdown, dynamicBreakdown) : [];
}
