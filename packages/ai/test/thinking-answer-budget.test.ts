import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

type BudgetModel = Model<"anthropic-messages"> | Model<"bedrock-converse-stream">;

interface BudgetPayload {
	max_tokens?: number;
	inferenceConfig?: { maxTokens?: number };
	thinking?: { type: string; budget_tokens?: number; display?: string };
	additionalModelRequestFields?: { thinking?: BudgetPayload["thinking"] };
}

const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };

async function capturePayload(model: BudgetModel, options: SimpleStreamOptions = {}) {
	let payload: BudgetPayload | undefined;
	const captureOptions: SimpleStreamOptions = {
		...options,
		apiKey: "fake-key",
		onPayload: (value) => {
			payload = value as BudgetPayload;
			throw new Error("payload captured before network request");
		},
	};
	const stream =
		model.api === "anthropic-messages"
			? streamAnthropic(model, context, captureOptions)
			: streamBedrock(model, context, captureOptions);
	await stream.result();
	if (!payload) throw new Error("Expected payload capture");
	return {
		maxTokens: payload.max_tokens ?? payload.inferenceConfig?.maxTokens,
		thinking: payload.thinking ?? payload.additionalModelRequestFields?.thinking,
	};
}

const models: BudgetModel[] = [
	{ ...getModel("anthropic", "claude-sonnet-4-5"), baseUrl: "http://127.0.0.1:9" },
	getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
];

describe.each(models)("$api simple thinking answer budget", (baseModel) => {
	// Preserve provider serialization: Anthropic's legacy `|| 1024` fallback
	// differs from Bedrock's nullish fallback when the calculated budget is zero.
	const zeroBudget = baseModel.api === "anthropic-messages" ? 1024 : 0;

	it.each([
		{ ceiling: 512, expectedBudget: 0 },
		{ ceiling: 1024, expectedBudget: 0 },
		{ ceiling: 1536, expectedBudget: 512 },
	])("preserves model cap $ceiling and its answer reservation", async ({ ceiling, expectedBudget }) => {
		const payload = await capturePayload({ ...baseModel, maxTokens: ceiling }, { reasoning: "medium" });
		expect(payload).toEqual({
			maxTokens: ceiling,
			thinking: { type: "enabled", budget_tokens: expectedBudget || zeroBudget, display: "summarized" },
		});
	});

	it.each([
		{ ceiling: 512, expectedBudget: 0 },
		{ ceiling: 1024, expectedBudget: 0 },
		{ ceiling: 1536, expectedBudget: 512 },
		{ ceiling: 5000, expectedBudget: 3976 },
	])("reserves answer room after context caps output at $ceiling", async ({ ceiling, expectedBudget }) => {
		const model = {
			...baseModel,
			maxTokens: 32768,
			contextWindow: estimateContextTokens(context).tokens + 4096 + ceiling,
		};
		const payload = await capturePayload(model, { maxTokens: 2048, reasoning: "medium" });
		expect(payload).toEqual({
			maxTokens: ceiling,
			thinking: { type: "enabled", budget_tokens: expectedBudget || zeroBudget, display: "summarized" },
		});
	});

	it.each([
		{ budget: 256, expectedMax: 2304 },
		{ budget: 0, expectedMax: 2048 },
	])("preserves custom budget $budget when answer room is available", async ({ budget, expectedMax }) => {
		const payload = await capturePayload(baseModel, {
			maxTokens: 2048,
			reasoning: "medium",
			thinkingBudgets: { medium: budget },
		});
		expect(payload).toEqual({
			maxTokens: expectedMax,
			thinking: { type: "enabled", budget_tokens: budget || zeroBudget, display: "summarized" },
		});
	});

	it.each(["xhigh", "max"] as const)("uses the high budget for %s before reserving answer room", async (reasoning) => {
		const payload = await capturePayload(
			{ ...baseModel, maxTokens: 32768, contextWindow: estimateContextTokens(context).tokens + 4096 + 4000 },
			{ reasoning, thinkingBudgets: { high: 7000, medium: 1234 } },
		);
		expect(payload).toEqual({
			maxTokens: 4000,
			thinking: { type: "enabled", budget_tokens: 2976, display: "summarized" },
		});
	});

	it("uses the model output cap when no caller cap is supplied", async () => {
		const payload = await capturePayload({ ...baseModel, maxTokens: 32768 }, { reasoning: "medium" });
		expect(payload).toEqual({
			maxTokens: 32768,
			thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
		});
	});
});
