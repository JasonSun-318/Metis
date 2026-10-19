import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
import { streamSimple as anthropicStreamSimple } from "../src/api/anthropic-messages.ts";
import { azureOpenAIResponsesApi } from "../src/api/azure-openai-responses.lazy.ts";
import { streamSimple as azureOpenAIResponsesStreamSimple } from "../src/api/azure-openai-responses.ts";
import { googleGenerativeAIApi } from "../src/api/google-generative-ai.lazy.ts";
import { streamSimple as googleGenerativeAIStreamSimple } from "../src/api/google-generative-ai.ts";
import { mistralConversationsApi } from "../src/api/mistral-conversations.lazy.ts";
import { streamSimple as mistralConversationsStreamSimple } from "../src/api/mistral-conversations.ts";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import { streamSimple as openAICodexResponsesStreamSimple } from "../src/api/openai-codex-responses.ts";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { streamSimple as openAICompletionsStreamSimple } from "../src/api/openai-completions.ts";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { streamSimple as openAIResponsesStreamSimple } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEvent, Context, Model, ProviderStreams } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createModel<TApi extends Api>(api: TApi, provider: string): Model<TApi> {
	return {
		id: `test-${api}`,
		name: "Test Model",
		api,
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

const anthropicModel = createModel("anthropic-messages", "anthropic");
const openAIResponsesModel = createModel("openai-responses", "openai");
const openAICompletionsModel = createModel("openai-completions", "openai");
const azureModel = createModel("azure-openai-responses", "azure-openai-responses");
const mistralModel = createModel("mistral-conversations", "mistral");
const googleModel = createModel("google-generative-ai", "google");
const codexModel = createModel("openai-codex-responses", "openai-codex");

const directCases: Array<{
	name: string;
	model: Model<Api>;
	start: () => AssistantMessageEventStream;
}> = [
	{ name: "anthropic-messages", model: anthropicModel, start: () => anthropicStreamSimple(anthropicModel, context) },
	{
		name: "openai-responses",
		model: openAIResponsesModel,
		start: () => openAIResponsesStreamSimple(openAIResponsesModel, context),
	},
	{
		name: "openai-completions",
		model: openAICompletionsModel,
		start: () => openAICompletionsStreamSimple(openAICompletionsModel, context),
	},
	{
		name: "azure-openai-responses",
		model: azureModel,
		start: () => azureOpenAIResponsesStreamSimple(azureModel, context),
	},
	{
		name: "mistral-conversations",
		model: mistralModel,
		start: () => mistralConversationsStreamSimple(mistralModel, context),
	},
	{
		name: "google-generative-ai",
		model: googleModel,
		start: () => googleGenerativeAIStreamSimple(googleModel, context),
	},
	{
		name: "openai-codex-responses",
		model: codexModel,
		start: () => openAICodexResponsesStreamSimple(codexModel, context),
	},
];

const lazyCases: Array<{ name: string; model: Model<Api>; api: ProviderStreams }> = [
	{ name: "anthropic-messages", model: anthropicModel, api: anthropicMessagesApi() },
	{ name: "openai-responses", model: openAIResponsesModel, api: openAIResponsesApi() },
	{ name: "openai-completions", model: openAICompletionsModel, api: openAICompletionsApi() },
	{ name: "azure-openai-responses", model: azureModel, api: azureOpenAIResponsesApi() },
	{ name: "mistral-conversations", model: mistralModel, api: mistralConversationsApi() },
	{ name: "google-generative-ai", model: googleModel, api: googleGenerativeAIApi() },
	{ name: "openai-codex-responses", model: codexModel, api: openAICodexResponsesApi() },
];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("direct streamSimple setup failures", () => {
	it.each(directCases)("$name reports missing credentials as a terminal error stream", async ({ model, start }) => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be called when configuration is missing");
		});
		vi.stubGlobal("fetch", fetchMock);

		let stream!: AssistantMessageEventStream;
		expect(() => {
			stream = start();
		}).not.toThrow();
		expect(stream).toBeInstanceOf(AssistantMessageEventStream);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`No API key for provider: ${model.provider}`);
		expect(result.api).toBe(model.api);
		expect(result.provider).toBe(model.provider);
		expect(result.model).toBe(model.id);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("lazy streamSimple setup failures", () => {
	it.each(lazyCases)("$name preserves terminal error streams through lazyApi", async ({ model, api }) => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be called when configuration is missing");
		});
		vi.stubGlobal("fetch", fetchMock);

		const stream = api.streamSimple(model, context);
		expect(stream).toBeInstanceOf(AssistantMessageEventStream);

		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.at(-1)?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(`No API key for provider: ${model.provider}`);
		expect(result.api).toBe(model.api);
		expect(result.provider).toBe(model.provider);
		expect(result.model).toBe(model.id);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("streamSimple setup compatibility", () => {
	it("keeps the successful setup path synchronous and unwrapped", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be called");
		});
		vi.stubGlobal("fetch", fetchMock);

		let stream!: AssistantMessageEventStream;
		expect(() => {
			stream = openAIResponsesStreamSimple(openAIResponsesModel, context, {
				apiKey: "test-key",
				onPayload: () => {
					throw new Error("payload hook reached");
				},
			});
		}).not.toThrow();

		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("payload hook reached");
		expect(result.errorMessage).not.toContain("No API key");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("settles a missing-credential stream with abort semantics when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const result = await openAIResponsesStreamSimple(openAIResponsesModel, context, {
			signal: controller.signal,
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toContain(`No API key for provider: ${openAIResponsesModel.provider}`);
		expect(result.api).toBe(openAIResponsesModel.api);
		expect(result.provider).toBe(openAIResponsesModel.provider);
		expect(result.model).toBe(openAIResponsesModel.id);
	});

	it("keeps header-based authentication on the successful setup path", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be called");
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await openAIResponsesStreamSimple(openAIResponsesModel, context, {
			headers: { authorization: "Bearer test-token" },
			onPayload: () => {
				throw new Error("payload hook reached");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("payload hook reached");
		expect(result.errorMessage).not.toContain("No API key");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
