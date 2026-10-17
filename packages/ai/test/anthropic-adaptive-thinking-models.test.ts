import { describe, expect, it } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { getFixtureModels, getFixtureProviders } from "./model-catalog-fixtures.ts";

const EXPECTED_ADAPTIVE_THINKING_FIXTURES = [
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5-1",
	"anthropic/claude-opus-4-6",
	"anthropic/claude-opus-4-7",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-4-6",
	"anthropic/claude-sonnet-5",
	"cloudflare-ai-gateway/claude-fable-5",
	"cloudflare-ai-gateway/claude-fable-5.1",
	"cloudflare-ai-gateway/claude-opus-4.6",
	"cloudflare-ai-gateway/claude-opus-4.7",
	"cloudflare-ai-gateway/claude-opus-4.8",
	"cloudflare-ai-gateway/claude-opus-5",
	"cloudflare-ai-gateway/claude-sonnet-4.6",
	"cloudflare-ai-gateway/claude-sonnet-5",
	"fireworks/accounts/fireworks/models/deepseek-v4-flash-0731",
	"fireworks/accounts/fireworks/models/deepseek-v4-flash-vision-exp",
	"fireworks/accounts/fireworks/models/deepseek-v4-pro-0813",
	"fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
	"fireworks/accounts/fireworks/models/gpt-oss-120b",
	"fireworks/accounts/fireworks/models/minimax-m3",
	"fireworks/accounts/fireworks/models/muse-glimmer-30b",
	"fireworks/accounts/fireworks/models/qwen3p7-plus",
	"fireworks/accounts/fireworks/models/qwen3p8-2p4t-a95b",
	"fireworks/accounts/fireworks/models/qwen3p8-max",
	"github-copilot/claude-fable-5",
	"github-copilot/claude-fable-5.1",
	"github-copilot/claude-opus-4.7",
	"github-copilot/claude-opus-4.8",
	"github-copilot/claude-opus-5",
	"github-copilot/claude-sonnet-4.6",
	"github-copilot/claude-sonnet-5",
	"kimi-coding/k3",
	"kimi-coding/k3-256k",
	"kimi-coding/kimi-for-coding",
	"kimi-coding/kimi-for-coding-highspeed",
	"opencode/claude-fable-5",
	"opencode/claude-fable-5-1",
	"opencode/claude-opus-4-6",
	"opencode/claude-opus-4-7",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5",
	"opencode/claude-sonnet-4-6",
	"opencode/claude-sonnet-5",
	"openrouter/anthropic/claude-fable-5",
	"openrouter/anthropic/claude-fable-5.1",
	"openrouter/anthropic/claude-opus-4.6",
	"openrouter/anthropic/claude-opus-4.7",
	"openrouter/anthropic/claude-opus-4.8",
	"openrouter/anthropic/claude-opus-5",
	"openrouter/anthropic/claude-sonnet-4.6",
	"openrouter/anthropic/claude-sonnet-5",
	"vercel-ai-gateway/anthropic/claude-fable-5",
	"vercel-ai-gateway/anthropic/claude-fable-5.1",
	"vercel-ai-gateway/anthropic/claude-opus-4.6",
	"vercel-ai-gateway/anthropic/claude-opus-4.7",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-4.8-fast",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-5-fast",
	"vercel-ai-gateway/anthropic/claude-sonnet-4.6",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

function getAllModels(): Model<Api>[] {
	return getFixtureProviders().flatMap((provider) => getFixtureModels(provider) as Model<Api>[]);
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks generated Anthropic Messages models that use adaptive thinking", () => {
		const flaggedModels = getAllModels()
			.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages")
			.filter((model) => model.compat?.forceAdaptiveThinking === true)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();

		expect(flaggedModels).toEqual(expect.arrayContaining([...EXPECTED_ADAPTIVE_THINKING_FIXTURES].sort()));
		expect(flaggedModels).toEqual(
			flaggedModels.filter((modelId) =>
				/(opus[-.]4[-.][678]|opus[-.]5|sonnet[-.]4[-.]6|sonnet[-.]5|fable[-.]5|deepseek-v4|gpt-oss|minimax-m3|muse-glimmer|qwen3p|kimi-for-coding|\/k3)/.test(
					modelId,
				),
			),
		);
	});
});
