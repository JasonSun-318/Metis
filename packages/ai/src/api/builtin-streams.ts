import type { Api, ProviderStreams } from "../types.ts";
import { anthropicMessagesApi } from "./anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./bedrock-converse-stream.lazy.ts";
import { googleGenerativeAIApi } from "./google-generative-ai.lazy.ts";
import { googleVertexApi } from "./google-vertex.lazy.ts";
import { mistralConversationsApi } from "./mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./openai-completions.lazy.ts";
import { openAIResponsesApi } from "./openai-responses.lazy.ts";

const streamsByApi = new Map<Api, ProviderStreams>([
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
]);

export const builtInApiIds: readonly Api[] = Object.freeze(Array.from(streamsByApi.keys()));

/** Side-effect-free built-in dispatch used by both instance runtimes and the legacy registry. */
export function getBuiltInApiStreams(api: Api): ProviderStreams | undefined {
	return streamsByApi.get(api);
}
