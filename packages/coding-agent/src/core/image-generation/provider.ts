import { getImageDimensions } from "@metis/tui";
import { type Static, Type } from "typebox";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { readBoundedResponseBytes } from "../bounded-response.ts";
import type { ImageGenerationConfig } from "./config.ts";
import type { GeneratedImageDetails, GeneratedImageMediaType } from "./types.ts";

export const ImageGenerationParams = Type.Object(
	{
		prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Describe the image or requested edit." }),
		mode: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("generate"), Type.Literal("edit")], {
				description: "Defaults to edit when reference_images are supplied.",
			}),
		),
		reference_images: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
				maxItems: 16,
				description:
					"Local image paths or metis-image:<fileId> references returned by this tool. Required for edits.",
			}),
		),
		count: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 4,
				description: "Number of images, default 1. Each image uses one billable request; no automatic retry.",
			}),
		),
		aspect_ratio: Type.Optional(
			Type.String({
				pattern: "^(auto|[1-9][0-9]?:[1-9][0-9]?)$",
				description:
					"For example 1:1, 3:2, 2:3, 16:9, 9:16; defaults to auto. Supported ratios depend on the configured model.",
			}),
		),
		resolution: Type.Optional(
			Type.Union(
				[Type.Literal("auto"), Type.Literal("512"), Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")],
				{
					description:
						"Google and OpenRouter support model-dependent 512/1K/2K/4K tiers. OpenAI supports 1K and model-dependent 2K/4K; 4K must fit its pixel limits.",
				},
			),
		),
		quality: Type.Optional(
			Type.Union(
				[
					Type.Literal("auto"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
					Type.Literal("max"),
				],
				{
					description:
						"OpenAI rendering quality; OpenRouter supports auto/low/medium/high; Google only supports auto.",
				},
			),
		),
		background: Type.Optional(
			Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")], {
				description: "OpenAI and model-dependent OpenRouter background. Transparent output requires png or webp.",
			}),
		),
		output_format: Type.Optional(
			Type.Union([Type.Literal("png"), Type.Literal("jpeg"), Type.Literal("webp")], {
				description:
					"OpenAI/OpenRouter: png/jpeg/webp; Google: png/jpeg. Supported formats depend on the model. Defaults to the provider default.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ImageGenerationInput = Static<typeof ImageGenerationParams>;
export interface ImageReference {
	readonly bytes: Buffer;
	readonly mediaType: GeneratedImageMediaType;
	readonly name: string;
	readonly continuation?: GeneratedImageDetails["continuation"];
}
export interface ProviderImage {
	readonly bytes: Buffer;
	readonly mediaType: GeneratedImageMediaType;
	readonly width?: number;
	readonly height?: number;
	readonly continuation?: GeneratedImageDetails["continuation"];
}

export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const GOOGLE_RATIOS = new Set([
	"1:1",
	"2:3",
	"3:2",
	"3:4",
	"4:3",
	"4:5",
	"5:4",
	"9:16",
	"16:9",
	"21:9",
	"1:8",
	"8:1",
	"1:4",
	"4:1",
]);

function unsupported(message: string): never {
	throw new Error(`IMAGE_GENERATION_UNSUPPORTED: ${message}`);
}

function openAiSize(config: ImageGenerationConfig, input: ImageGenerationInput): string {
	const ratio = input.aspect_ratio === "auto" ? undefined : input.aspect_ratio;
	const resolution = input.resolution === "auto" ? undefined : input.resolution;
	if (!ratio && !resolution) return "auto";
	if (resolution === "512") unsupported("OpenAI Images does not support the 512 resolution option.");
	const standard = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
	if ((!resolution || resolution === "1K") && (ratio ?? "1:1") in standard)
		return standard[(ratio ?? "1:1") as keyof typeof standard];
	if (/^gpt-image-1(?:$|[-.])/.test(config.modelId))
		unsupported(
			"This OpenAI model supports 1K with aspect_ratio 1:1, 3:2 or 2:3. Use a newer model for other sizes.",
		);
	const [widthRatio, heightRatio] = (ratio ?? "1:1").split(":").map(Number) as [number, number];
	const aspect = widthRatio / heightRatio;
	if (aspect < 1 / 3 || aspect > 3) unsupported("OpenAI aspect_ratio must be between 1:3 and 3:1.");
	const longest =
		resolution === "4K" ? 3840 : resolution === "2K" ? 2048 : Math.sqrt(1024 * 1024 * Math.max(aspect, 1 / aspect));
	const width = Math.round((aspect >= 1 ? longest : longest * aspect) / 16) * 16;
	const height = Math.round((aspect >= 1 ? longest / aspect : longest) / 16) * 16;
	if (width * height > 3840 * 2160)
		unsupported("This 4K aspect ratio exceeds OpenAI's pixel limit. Use 2K or a wider/taller aspect ratio.");
	return `${width}x${height}`;
}

/** Validate capabilities before reading inputs or making a billable request. */
export function validateImageGenerationOptions(config: ImageGenerationConfig, input: ImageGenerationInput): void {
	if (config.api === "google-interactions") {
		if (input.quality && input.quality !== "auto")
			unsupported("Google Interactions does not expose quality; omit it or use auto.");
		if (input.background && input.background !== "auto")
			unsupported("Google Interactions does not expose background; describe it in the prompt instead.");
		if (input.output_format === "webp")
			unsupported("Google Interactions supports PNG or JPEG output in this integration.");
		if (input.aspect_ratio && input.aspect_ratio !== "auto" && !GOOGLE_RATIOS.has(input.aspect_ratio))
			unsupported("Unsupported Google image aspect_ratio.");
	} else {
		if (config.api === "openai-images") openAiSize(config, input);
		else if (input.quality === "xhigh" || input.quality === "max")
			unsupported("OpenRouter Images quality must be auto, low, medium or high.");
		if (input.background === "transparent" && input.output_format === "jpeg")
			unsupported("Transparent images require PNG or WebP output.");
	}
}

export function imageBytes(bytes: Buffer, declaredMediaType?: unknown): Omit<ProviderImage, "continuation"> {
	if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES)
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Image is empty or exceeds 32 MiB.");
	const mediaType = detectSupportedImageMimeType(bytes);
	if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp")
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Expected PNG, JPEG or WebP image bytes.");
	if (declaredMediaType !== undefined && declaredMediaType !== mediaType)
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Image media type does not match its bytes.");
	const dimensions = getImageDimensions(bytes.toString("base64"), mediaType);
	if (
		!dimensions ||
		dimensions.widthPx < 1 ||
		dimensions.heightPx < 1 ||
		dimensions.widthPx > 65_535 ||
		dimensions.heightPx > 65_535
	)
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Invalid image dimensions.");
	return { bytes, mediaType, width: dimensions.widthPx, height: dimensions.heightPx };
}

function decodeImage(data: unknown, mediaType?: unknown): Omit<ProviderImage, "continuation"> {
	if (
		typeof data !== "string" ||
		data.length > Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) ||
		!/^[A-Za-z0-9+/]+={0,2}$/.test(data)
	)
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Missing or invalid inline image data.");
	return imageBytes(Buffer.from(data, "base64"), mediaType);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** One request per output permits progress and preserves earlier images if a later request fails. */
export async function generateProviderImage(options: {
	config: ImageGenerationConfig;
	apiKey: string;
	input: ImageGenerationInput;
	references: ImageReference[];
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
}): Promise<ProviderImage[]> {
	const { config, input, references } = options;
	const controller = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, controller]) : controller;
	const isGoogle = config.api === "google-interactions";
	const isOpenRouter = config.api === "openrouter-images";
	const headers: Record<string, string> = isGoogle
		? { "x-goog-api-key": options.apiKey }
		: { Authorization: `Bearer ${options.apiKey}` };
	let body: string | FormData;
	if (isGoogle) {
		const previous = references.length === 1 ? references[0]!.continuation : undefined;
		const continuation =
			previous?.baseUrl === config.baseUrl && previous.modelId === config.modelId ? previous : undefined;
		body = JSON.stringify({
			model: config.modelId,
			input:
				continuation || references.length === 0
					? input.prompt
					: [
							{ type: "text", text: input.prompt },
							...references.map((reference) => ({
								type: "image",
								data: reference.bytes.toString("base64"),
								mime_type: reference.mediaType,
							})),
						],
			...(continuation ? { previous_interaction_id: continuation.interactionId } : {}),
			response_format: {
				type: "image",
				delivery: "inline",
				...(input.output_format ? { mime_type: `image/${input.output_format}` } : {}),
				...(input.aspect_ratio && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
				...(input.resolution && input.resolution !== "auto" ? { image_size: input.resolution } : {}),
			},
		});
		headers["Content-Type"] = "application/json";
	} else if (isOpenRouter) {
		body = JSON.stringify({
			model: config.modelId,
			prompt: input.prompt,
			n: 1,
			...(input.aspect_ratio && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
			...(input.resolution && input.resolution !== "auto" ? { resolution: input.resolution } : {}),
			...(input.quality ? { quality: input.quality } : {}),
			...(input.background ? { background: input.background } : {}),
			...(input.output_format ? { output_format: input.output_format } : {}),
			...(references.length
				? {
						input_references: references.map((reference) => ({
							type: "image_url",
							image_url: { url: `data:${reference.mediaType};base64,${reference.bytes.toString("base64")}` },
						})),
					}
				: {}),
		});
		headers["Content-Type"] = "application/json";
	} else {
		const params = {
			model: config.modelId,
			prompt: input.prompt,
			n: 1,
			size: openAiSize(config, input),
			...(input.quality ? { quality: input.quality } : {}),
			...(input.background ? { background: input.background } : {}),
			...(input.output_format ? { output_format: input.output_format } : {}),
		};
		if (references.length) {
			body = new FormData();
			for (const [key, value] of Object.entries(params)) body.append(key, String(value));
			for (const reference of references)
				body.append(
					"image[]",
					new Blob([new Uint8Array(reference.bytes)], { type: reference.mediaType }),
					reference.name,
				);
		} else {
			body = JSON.stringify(params);
			headers["Content-Type"] = "application/json";
		}
	}
	const endpoint = isGoogle
		? "interactions"
		: isOpenRouter
			? "images"
			: references.length
				? "images/edits"
				: "images/generations";
	let response: Response;
	try {
		response = await (options.fetch ?? globalThis.fetch)(`${config.baseUrl}/${endpoint}`, {
			method: "POST",
			headers,
			body,
			signal,
			redirect: "error",
		});
	} catch (error) {
		if (options.signal?.aborted)
			throw new Error("IMAGE_GENERATION_CANCELLED: Image generation was cancelled.", { cause: error });
		if (controller.aborted)
			throw new Error("IMAGE_GENERATION_TIMEOUT: Image generation timed out. No automatic retry was made.", {
				cause: error,
			});
		throw new Error(
			"IMAGE_GENERATION_NETWORK: Could not reach the configured image service. No automatic retry was made.",
			{ cause: error },
		);
	}
	if (!response.ok) {
		await response.body?.cancel();
		const hint =
			response.status === 401 || response.status === 403
				? "Check the API key, model access and provider policy."
				: response.status === 429
					? "The provider rate or credit limit was reached."
					: "Check the configured model and supported parameters.";
		throw new Error(`IMAGE_GENERATION_PROVIDER_ERROR: HTTP ${response.status}. ${hint} No automatic retry was made.`);
	}
	let data: Record<string, unknown>;
	try {
		const bounded = await readBoundedResponseBytes(response, MAX_PROVIDER_RESPONSE_BYTES);
		data = record(JSON.parse(Buffer.from(bounded.data).toString("utf8")));
	} catch (error) {
		if (options.signal?.aborted)
			throw new Error("IMAGE_GENERATION_CANCELLED: Image generation was cancelled.", { cause: error });
		if (controller.aborted)
			throw new Error("IMAGE_GENERATION_TIMEOUT: Image generation timed out. No automatic retry was made.", {
				cause: error,
			});
		throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: The provider returned an unreadable or oversized response.", {
			cause: error,
		});
	}
	if (!isGoogle) {
		if (!Array.isArray(data.data) || data.data.length !== 1)
			throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Expected one image in the provider response.");
		const image = record(data.data[0]);
		const decoded = decodeImage(
			image.b64_json,
			isOpenRouter ? image.media_type : input.output_format ? `image/${input.output_format}` : undefined,
		);
		if (input.output_format && decoded.mediaType !== `image/${input.output_format}`)
			throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: The provider did not return the requested output format.");
		return [decoded];
	}
	const images = Array.isArray(data.steps)
		? data.steps.flatMap((step) => {
				const output = record(step);
				return output.type === "model_output" && Array.isArray(output.content)
					? output.content.filter((part) => record(part).type === "image")
					: [];
			})
		: [];
	if (data.status !== "completed" || images.length === 0 || images.length > 4)
		throw new Error(
			"IMAGE_GENERATION_NO_IMAGE: The provider did not complete an image output. The request may have been declined; no automatic retry was made.",
		);
	const continuation: GeneratedImageDetails["continuation"] =
		typeof data.id === "string" && data.id.length > 0 && data.id.length <= 2048
			? { api: "google-interactions", modelId: config.modelId, baseUrl: config.baseUrl, interactionId: data.id }
			: undefined;
	return images.map((image) => {
		const decoded = decodeImage(record(image).data, record(image).mime_type);
		if (input.output_format && decoded.mediaType !== `image/${input.output_format}`)
			throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: The provider did not return the requested output format.");
		return { ...decoded, ...(continuation ? { continuation } : {}) };
	});
}
