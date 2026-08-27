import type { AgentMessage } from "@metis/agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	estimateContextUsageBreakdown,
	reconcileContextUsageBreakdown,
	reconcileContextUsageBreakdownWithFixed,
} from "../src/core/context-usage-breakdown.ts";
import { formatProjectContext } from "../src/core/system-prompt.ts";

describe("context usage breakdown", () => {
	it("classifies prompt sections, summaries, explicit skills, tools, and conversation", () => {
		const rules = formatProjectContext([{ path: "AGENTS.md", content: "RULES" }]);
		const agentPrompt = "<agent_coordination>COORDINATE</agent_coordination>";
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: 1 },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: '<skill name="pdf" location="/skills/pdf/SKILL.md">\nINSTRUCTIONS\n</skill>\n\nReview this',
					},
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				timestamp: 2,
			},
			{ role: "user", content: "ordinary question", timestamp: 3 },
		];
		const result = estimateContextUsageBreakdown({
			systemPromptParts: [
				{ category: "system_prompt", content: "BASE" },
				{ category: "rules", content: rules },
				{ category: "skills", content: "SKILL INDEX" },
				{ category: "agent_definitions", content: `\n\n${agentPrompt}` },
			],
			messages,
			tools: [
				{ name: "read", description: "Read", parameters: Type.Object({}) },
				{ name: "tool_search", description: "Search", parameters: Type.Object({}) },
				{ name: "spawn_agent", description: "Spawn", parameters: Type.Object({}) },
			],
			toolCategories: new Map([
				["read", "tool_definitions" as const],
				["tool_search", "mcp_dynamic_tools" as const],
				["spawn_agent", "agent_definitions" as const],
			]),
		});

		const categories = new Map(result.map((item) => [item.category, item.tokens]));
		for (const category of [
			"system_prompt",
			"rules",
			"skills",
			"tool_definitions",
			"mcp_dynamic_tools",
			"agent_definitions",
			"summarized_conversation",
			"conversation",
		] as const) {
			expect(categories.get(category)).toBeGreaterThan(0);
		}
	});

	it("does not count errored or aborted assistants as replayed conversation", () => {
		const common = {
			systemPromptParts: [{ category: "system_prompt" as const, content: "SYSTEM" }],
			tools: [],
			toolCategories: new Map(),
		};
		const baseline = estimateContextUsageBreakdown({ ...common, messages: [] });
		const result = estimateContextUsageBreakdown({
			...common,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "error" }],
					api: "anthropic-messages",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "aborted" }],
					api: "anthropic-messages",
					provider: "test",
					model: "test",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "aborted",
					timestamp: 2,
				},
			],
		});
		expect(result).toEqual(baseline);
	});

	it("scales under-estimates deterministically and preserves the exact total", () => {
		expect(
			reconcileContextUsageBreakdown(
				[
					{ category: "system_prompt", tokens: 3 },
					{ category: "conversation", tokens: 1 },
				],
				10,
			),
		).toEqual([
			{ category: "system_prompt", tokens: 8 },
			{ category: "conversation", tokens: 2 },
		]);
	});

	it("does not invent a category when no local breakdown exists", () => {
		expect(reconcileContextUsageBreakdown([], 10)).toEqual([]);
	});

	it("scales over-estimates deterministically and preserves the exact total", () => {
		const result = reconcileContextUsageBreakdown(
			[
				{ category: "system_prompt", tokens: 3 },
				{ category: "conversation", tokens: 1 },
			],
			3,
		);
		expect(result).toEqual([
			{ category: "system_prompt", tokens: 2 },
			{ category: "conversation", tokens: 1 },
		]);
		expect(result.reduce((sum, item) => sum + item.tokens, 0)).toBe(3);
	});

	it("keeps calibrated fixed modules unchanged and assigns the remaining total to conversation", () => {
		expect(
			reconcileContextUsageBreakdownWithFixed(
				[
					{ category: "system_prompt", tokens: 999 },
					{ category: "rules", tokens: 999 },
					{ category: "conversation", tokens: 20 },
				],
				140,
				[
					{ category: "system_prompt", tokens: 40 },
					{ category: "rules", tokens: 20 },
				],
			),
		).toEqual([
			{ category: "system_prompt", tokens: 40 },
			{ category: "rules", tokens: 20 },
			{ category: "conversation", tokens: 80 },
		]);
	});

	it("withholds a breakdown when calibrated fixed modules exceed the reported total", () => {
		expect(
			reconcileContextUsageBreakdownWithFixed([{ category: "conversation", tokens: 1 }], 50, [
				{ category: "system_prompt", tokens: 60 },
			]),
		).toEqual([]);
	});
});
