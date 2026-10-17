import type { ModelsDevReasoningOption } from "../../scripts/models-dev-reasoning-options.ts";

// Fixed upstream inputs for protocol and generator regressions. Model retirement,
// pricing changes, or additions to the live catalog must not change these cases.
function sourceModels(ids: string[], npm = "@ai-sdk/openai-compatible") {
	return Object.fromEntries(
		ids.map((id) => [
			id,
			{
				id,
				name: id,
				tool_call: true,
				reasoning: id !== "gpt-4o-mini",
				modalities: { input: ["text", "image"], output: ["text"] },
				limit: { context: 128000, output: 8192 },
				cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
				provider: { npm },
				reasoning_options: [] as ModelsDevReasoningOption[],
			},
		]),
	);
}

const modelsDev = {
	"amazon-bedrock": {
		models: {
			...sourceModels(["global.anthropic.claude-fable-5"], "@ai-sdk/openai-compatible"),
		},
	},
	"ant-ling": {
		models: {
			...sourceModels(["Ling-2.6-flash", "Ring-2.6-1T"], "@ai-sdk/openai-compatible"),
		},
	},
	anthropic: {
		models: {
			...sourceModels(
				[
					"claude-fable-5",
					"claude-fable-5-1",
					"claude-haiku-4-5",
					"claude-opus-4-6",
					"claude-opus-4-7",
					"claude-opus-4-8",
					"claude-opus-5",
					"claude-sonnet-4-5",
					"claude-sonnet-4-6",
					"claude-sonnet-5",
				],
				"@ai-sdk/anthropic",
			),
		},
	},
	"cloudflare-ai-gateway": {
		models: {
			...sourceModels(
				[
					"anthropic/claude-fable-5",
					"anthropic/claude-fable-5.1",
					"anthropic/claude-opus-4.6",
					"anthropic/claude-opus-4.7",
					"anthropic/claude-opus-4.8",
					"anthropic/claude-opus-5",
					"anthropic/claude-sonnet-4.6",
					"anthropic/claude-sonnet-5",
				],
				"@ai-sdk/anthropic",
			),
		},
	},
	deepseek: {
		models: {
			...sourceModels(["deepseek-flash"], "@ai-sdk/openai-compatible"),
		},
	},
	"fireworks-ai": {
		models: {
			...sourceModels(
				[
					"accounts/fireworks/models/deepseek-v4-flash-0731",
					"accounts/fireworks/models/deepseek-v4-flash-vision-exp",
					"accounts/fireworks/models/deepseek-v4-pro-0813",
					"accounts/fireworks/models/deepseek-v4p1-flash",
					"accounts/fireworks/models/gpt-oss-120b",
					"accounts/fireworks/models/kimi-k2p6",
					"accounts/fireworks/models/minimax-m3",
					"accounts/fireworks/models/muse-glimmer-30b",
					"accounts/fireworks/models/qwen3p7-plus",
					"accounts/fireworks/models/qwen3p8-2p4t-a95b",
					"accounts/fireworks/models/qwen3p8-max",
				],
				"@ai-sdk/anthropic",
			),
			...sourceModels(
				["accounts/fireworks/models/glm-5p2", "accounts/fireworks/routers/glm-5p2-fast"],
				"@ai-sdk/openai-compatible",
			),
		},
	},
	"github-copilot": {
		models: {
			...sourceModels(
				[
					"claude-fable-5",
					"claude-fable-5.1",
					"claude-opus-4.7",
					"claude-opus-4.8",
					"claude-opus-5",
					"claude-sonnet-4.6",
					"claude-sonnet-5",
				],
				"@ai-sdk/anthropic",
			),
		},
	},
	groq: {
		models: {
			...sourceModels(["openai/gpt-oss-20b", "qwen/qwen3.6-27b"], "@ai-sdk/openai-compatible"),
		},
	},
	"kimi-code-plan-global": {
		models: {
			...sourceModels(["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"], "@ai-sdk/anthropic"),
		},
	},
	moonshotai: {
		models: {
			...sourceModels(["kimi-k2.7-code"], "@ai-sdk/openai-compatible"),
		},
	},
	"moonshotai-cn": {
		models: {
			...sourceModels(["kimi-k2.6", "kimi-k2.7-code"], "@ai-sdk/openai-compatible"),
		},
	},
	openai: {
		models: {
			...sourceModels(
				["gpt-4o-mini", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
				"@ai-sdk/openai",
			),
		},
	},
	opencode: {
		models: {
			...sourceModels(
				[
					"claude-fable-5",
					"claude-fable-5-1",
					"claude-opus-4-6",
					"claude-opus-4-7",
					"claude-opus-4-8",
					"claude-opus-5",
					"claude-sonnet-4-6",
					"claude-sonnet-5",
				],
				"@ai-sdk/anthropic",
			),
			...sourceModels(
				["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2.5", "kimi-k2.6", "minimax-m2.7"],
				"@ai-sdk/openai-compatible",
			),
			...sourceModels(["grok-build-0.1"], "@ai-sdk/openai"),
		},
	},
	"opencode-go": {
		models: {
			...sourceModels(["deepseek-v4-flash", "kimi-k2.6"], "@ai-sdk/openai-compatible"),
			...sourceModels(["fixture-gemini"], "@ai-sdk/google"),
			...sourceModels(["fixture-claude"], "@ai-sdk/anthropic"),
			...sourceModels(["fixture-responses"], "@ai-sdk/openai"),
		},
	},
	together: {
		models: {
			...sourceModels(
				["MiniMaxAI/MiniMax-M2.7", "deepseek-ai/DeepSeek-V4-Pro", "moonshotai/Kimi-K2.6", "openai/gpt-oss-120b"],
				"@ai-sdk/openai-compatible",
			),
		},
	},
	xiaomi: {
		models: {
			...sourceModels(["mimo-v2.5-pro", "mimo-v2.5-pro-ultraspeed"], "@ai-sdk/openai-compatible"),
		},
	},
	"xiaomi-token-plan-ams": {
		models: {
			...sourceModels(["mimo-v2.5-pro"], "@ai-sdk/openai-compatible"),
		},
	},
	"xiaomi-token-plan-cn": {
		models: {
			...sourceModels(["mimo-v2.5-pro"], "@ai-sdk/openai-compatible"),
		},
	},
	"xiaomi-token-plan-sgp": {
		models: {
			...sourceModels(["mimo-v2.5-pro"], "@ai-sdk/openai-compatible"),
		},
	},
	"zai-coding-plan": {
		models: {
			...sourceModels(["glm-4.7", "glm-5-turbo", "glm-5.2", "glm-5.3"], "@ai-sdk/openai-compatible"),
		},
	},
	"zhipuai-coding-plan": {
		models: {
			...sourceModels(["glm-5.2"], "@ai-sdk/openai-compatible"),
		},
	},
	"alibaba-token-plan": {
		models: sourceModels([
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
		]),
	},
};

Object.assign(modelsDev["fireworks-ai"].models["accounts/fireworks/models/kimi-k2p6"], {
	limit: { context: 262000, output: 262000 },
	cost: { input: 0.95, output: 4, cache_read: 0.16, cache_write: 0 },
});
Object.assign(modelsDev.together.models["moonshotai/Kimi-K2.6"], {
	limit: { context: 262144, output: 131000 },
	cost: { input: 1.2, output: 4.5, cache_read: 0.2, cache_write: 0 },
});

// Exercise cataloged effort controls as well as the generator's verified fallbacks.
modelsDev["fireworks-ai"].models["accounts/fireworks/models/deepseek-v4-flash-0731"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/deepseek-v4-flash-vision-exp"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/deepseek-v4-pro-0813"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/deepseek-v4p1-flash"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/gpt-oss-120b"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/minimax-m3"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/muse-glimmer-30b"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/qwen3p7-plus"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/qwen3p8-2p4t-a95b"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];
modelsDev["fireworks-ai"].models["accounts/fireworks/models/qwen3p8-max"].reasoning_options = [
	{ type: "effort", values: ["low", "high"] },
];

// Verified upstream effort values are inputs, not expected generated overrides.
for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
	modelsDev.openai.models[id].reasoning_options = [
		{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] },
	];
}
for (const provider of ["zai-coding-plan", "zhipuai-coding-plan"] as const) {
	modelsDev[provider].models["glm-5.2"].reasoning_options = [{ type: "effort", values: ["none", "high", "max"] }];
}
modelsDev["zai-coding-plan"].models["glm-5.3"].reasoning_options = [{ type: "effort", values: ["low", "high", "max"] }];
modelsDev.together.models["openai/gpt-oss-120b"].reasoning_options = [
	{ type: "effort", values: ["low", "medium", "high"] },
];

const openRouterIds = [
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5.1",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-opus-5",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-5",
	"deepseek/deepseek-r1",
	"deepseek/deepseek-v4-flash",
	"deepseek/deepseek-v4-pro",
	"moonshotai/kimi-k2.6",
	"openai/gpt-5.2-codex",
	"openai/gpt-5.5",
	"openai/gpt-5.5-pro",
];

const gatewayIds = [
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5.1",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.8",
	"anthropic/claude-opus-4.8-fast",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-5-fast",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-5",
];

export const modelCatalogSourceFixture = {
	"https://models.dev/api.json": modelsDev,
	"https://openrouter.ai/api/v1/models": {
		data: openRouterIds.map((id) => ({
			id,
			name: id,
			supported_parameters: ["tools", "reasoning"],
			architecture: { modality: "text+image->text" },
			pricing: { prompt: "0", completion: "0" },
			context_length: 128000,
			top_provider: { max_completion_tokens: 8192 },
		})),
	},
	"https://ai-gateway.vercel.sh/v1/models": {
		data: gatewayIds.map((id) => ({
			id,
			name: id,
			tags: ["tool-use", "vision", "reasoning"],
			context_window: 128000,
			max_tokens: 8192,
		})),
	},
	"https://integrate.api.nvidia.com/v1/models": { data: [] },
};
