import type { AgentMessage } from "@metis/agent-core";
import { type AssistantMessage, getModel } from "@metis/ai/compat";
import { expect, it } from "vitest";
import { AgentSessionContextUsage } from "../src/core/agent-session-context-usage.ts";
import { convertToLlm } from "../src/core/messages.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
function harness() {
	const messages: AgentMessage[] = [{ role: "user", content: "question", timestamp: 1 }];
	const tracker = new AgentSessionContextUsage({
		getMcpToolNames: () => new Set(),
		getBaseSystemPromptParts: () => [{ category: "system_prompt", content: "SYSTEM" }],
		getMessages: () => messages,
		getModel: () => model,
		getSystemPrompt: () => "SYSTEM",
		getTools: () => [],
	});
	const respond = (input: number, output: number) => {
		tracker.capturePrepared({
			model,
			agentMessages: [...messages],
			llmContext: { systemPrompt: "SYSTEM", messages: convertToLlm(messages), tools: [] },
		});
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input,
				output,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		messages.push(response);
		tracker.captureReported(response);
		return tracker.getUsage()!;
	};
	return { tracker, messages, respond };
}

it("does not attribute generated output tokens to the system prompt", () => {
	const short = harness().respond(1000, 10);
	const long = harness().respond(1000, 9000);
	expect(long.breakdown?.find((item) => item.category === "system_prompt")?.tokens).toBe(
		short.breakdown?.find((item) => item.category === "system_prompt")?.tokens,
	);
	expect(long.tokens).toBe(10_000);
});

it("includes skills loaded after the first response in the next reported breakdown", () => {
	const h = harness();
	h.respond(20, 1);
	h.messages.push({
		role: "user",
		content:
			'<skill name="pdf" location="/skills/pdf/SKILL.md">\n' +
			"instructions ".repeat(300) +
			"\n</skill>\n\nReview this",
		timestamp: 3,
	});
	const usage = h.respond(1100, 1);
	expect(usage.breakdown?.find((item) => item.category === "skills")?.tokens ?? 0).toBeGreaterThan(0);
	expect(usage.breakdown?.reduce((sum, item) => sum + item.tokens, 0)).toBe(1101);
});

it("invalidates a reported total when compaction replaces the prefix but retains the last response", () => {
	const h = harness();
	h.respond(10000, 100);
	h.messages.splice(0, 1, {
		role: "compactionSummary",
		summary: "compressed history",
		tokensBefore: 10000,
		timestamp: 3,
	});
	const usage = h.tracker.getUsage()!;
	expect(usage.basis).toBe("estimated_total");
	expect(usage.tokens).not.toBe(10100);
	expect(usage.breakdown?.some((item) => item.category === "summarized_conversation")).toBe(true);
});

it("preserves a reported prefix when only new messages are appended", () => {
	const h = harness();
	h.respond(1000, 100);
	h.messages.push({ role: "user", content: "new question", timestamp: 4 });
	const usage = h.tracker.getUsage()!;
	expect(usage.basis).toBe("reported_total");
	expect(usage.tokens).toBeGreaterThan(1100);
	expect(usage.breakdown?.reduce((sum, item) => sum + item.tokens, 0)).toBe(usage.tokens);
});

it("invalidates old reported totals after replacing a model context view", () => {
	const h = harness();
	h.respond(10_000, 100);
	h.tracker.invalidateReportedContext();
	expect(h.tracker.getUsage()!.basis).toBe("estimated_total");
});

it("estimates a prepared view without consuming the pending prepared snapshot", () => {
	const h = harness();
	h.respond(10_000, 100);
	const alternative: AgentMessage[] = [
		{ role: "user", content: "much longer alternative question ".repeat(200), timestamp: 5 },
	];
	const estimated = h.tracker.estimatePreparedTokens({
		model,
		agentMessages: alternative,
		llmContext: { systemPrompt: "SYSTEM", messages: [], tools: [] },
	});
	const baseline = h.tracker.estimatePreparedTokens({
		model,
		agentMessages: [],
		llmContext: { systemPrompt: "SYSTEM", messages: [], tools: [] },
	});
	expect(estimated).toBeGreaterThan(baseline);
	// The reported anchor is untouched and the next response still calibrates.
	const usage = h.respond(2000, 50);
	expect(usage.basis).toBe("reported_total");
	expect(usage.tokens).toBe(2050);
});
