import OpenAI from "openai";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";

/**
 * Official OpenAI Images API (`POST /images/generations`). Works with
 * gpt-image-* models and any endpoint implementing the same protocol.
 * Text-only input; image input (image-to-image) is not part of this API.
 */
export const generateImages: ImagesFunction<"openai-images", ImagesOptions> = async (
	model: ImagesModel<"openai-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}

		const images = context.input.filter((item): item is ImageContent => item.type === "image");
		if (images.length > 0) {
			throw new Error("The openai-images API does not accept image input; use a text prompt only");
		}
		const prompt = context.input
			.filter((item): item is TextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (!prompt) {
			throw new Error("A text prompt is required");
		}

		const client = new OpenAI({
			apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: providerHeadersToRecord({
				...model.headers,
				...(options?.headers as ProviderHeaders | undefined),
			}),
		});
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: options?.maxRetries ?? 0,
		};

		const response = await client.images.generate(
			{
				model: model.id,
				prompt,
				n: 1,
			},
			requestOptions,
		);

		for (const item of response.data ?? []) {
			if (item.revised_prompt) {
				output.output.push({ type: "text", text: item.revised_prompt } satisfies TextContent);
			}
			if (item.b64_json) {
				output.output.push({
					type: "image",
					mimeType: "image/png",
					data: item.b64_json,
				} satisfies ImageContent);
				continue;
			}
			// Legacy dall-e models return a temporary URL instead of b64.
			if (item.url) {
				const fetched = await fetch(item.url, {
					signal: options?.signal,
					...(options?.timeoutMs !== undefined ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
				});
				if (!fetched.ok) {
					throw new Error(`Failed to download generated image (HTTP ${fetched.status})`);
				}
				const buffer = Buffer.from(await fetched.arrayBuffer());
				output.output.push({
					type: "image",
					mimeType: fetched.headers.get("content-type")?.split(";")[0] || "image/png",
					data: buffer.toString("base64"),
				} satisfies ImageContent);
			}
		}

		if (!output.output.some((item) => item.type === "image")) {
			throw new Error("The image API returned no image data");
		}

		const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
		if (usage) {
			const input = usage.input_tokens ?? 0;
			const imageTokens = usage.output_tokens ?? 0;
			const cost = {
				input: (model.cost.input / 1_000_000) * input,
				output: (model.cost.output / 1_000_000) * imageTokens,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			};
			cost.total = cost.input + cost.output;
			const parsed: Usage = {
				input,
				output: imageTokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: input + imageTokens,
				cost,
			};
			output.usage = parsed;
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};
