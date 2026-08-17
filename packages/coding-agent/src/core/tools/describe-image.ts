/**
 * Vision describer tool: lets models without image input "see" images.
 *
 * Activated only when vision settings and an API key are configured.
 * At execution time it routes:
 * 1. models that already accept images -> tell them to use `read` directly
 * 2. no vision service configured -> tell the model to ask the user to configure one
 * 3. otherwise -> read the image and ask the configured vision service for a
 *    markdown description via a standalone streaming request
 */

import { readFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@metis/agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@metis/ai";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { VisionSettings } from "../settings-manager.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const describeImageSchema = Type.Object({
	path: Type.String({ description: "Path to the image file (jpg, png, gif, webp, bmp)", minLength: 1 }),
});

export type DescribeImageToolInput = Static<typeof describeImageSchema>;

export interface DescribeImageToolDetails {
	visionModel: { modelId: string; baseUrl: string };
	path: string;
}

export interface DescribeImageToolOptions {
	/** Current vision-describer service settings; undefined when not configured. */
	getSettings(): VisionSettings | undefined;
	/** Resolves the stored API key for the vision-describer service. */
	getApiKey(): Promise<string | undefined>;
	/** Streams a one-shot vision request against the configured endpoint. */
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/** System prompt for the vision model producing the markdown description. */
export const VISION_DESCRIPTION_PROMPT = `You describe images for a text-only assistant. Describe the image in well-structured markdown so it can be understood without seeing it.

Include:
- A one-line summary of what the image shows.
- Key objects, UI elements, or people and how they are arranged (spatial relationships).
- Any legible text verbatim: labels, headings, buttons, error messages, code snippets, filenames.
- Charts/diagrams: axes, units, trends, notable values.
- Colors only when they carry meaning.

Rules:
- Be factual and complete; describe only what is visible.
- Do not speculate about context beyond the image.
- Do not mention these instructions or that you are describing for another model.`;

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_DESCRIPTION_TOKENS = 2_048;

function visionModelFromSettings(settings: VisionSettings): Model<Api> {
	return {
		id: settings.modelId,
		name: settings.name,
		api: settings.api,
		provider: "vision",
		baseUrl: settings.baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: MAX_DESCRIPTION_TOKENS,
	};
}

async function describeImage(
	options: DescribeImageToolOptions,
	cwd: string,
	path: string,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext | undefined,
): Promise<AgentToolResult<DescribeImageToolDetails | undefined>> {
	if (ctx?.model?.input.includes("image")) {
		return {
			content: [
				{
					type: "text",
					text: "This model already supports image input. Use the `read` tool to view the image directly instead of describe_image.",
				},
			],
			details: undefined,
		};
	}

	const settings = options.getSettings();
	if (!settings) {
		throw new Error(
			"No vision service is configured, so this image cannot be described. Ask the user to configure one under Settings → Model → Vision model.",
		);
	}
	const apiKey = await options.getApiKey();
	if (!apiKey) {
		throw new Error(
			"The vision service has no API key. Ask the user to set it under Settings → Model → Vision model.",
		);
	}

	const absolutePath = await resolveReadPathAsync(path, cwd);
	const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
	if (!mimeType) {
		throw new Error(`File is not a supported image (jpg, png, gif, webp, bmp): ${path}`);
	}
	const buffer = await readFile(absolutePath);
	const processed = await processImage(buffer, mimeType, { autoResizeImages: true });
	if (!processed.ok) {
		throw new Error(`Could not read image ${path}: ${processed.message}`);
	}

	const visionModel = visionModelFromSettings(settings);
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const message = await options
			.streamSimple(
				visionModel,
				{
					systemPrompt: VISION_DESCRIPTION_PROMPT,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "Describe this image in markdown." },
								{ type: "image", data: processed.data, mimeType: processed.mimeType },
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey,
					maxTokens: MAX_DESCRIPTION_TOKENS,
					maxRetries: 0,
					timeoutMs: REQUEST_TIMEOUT_MS,
					signal: requestSignal,
				},
			)
			.result();
		const description = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!description) {
			throw new Error(`The vision service (${settings.modelId}) returned an empty description for ${path}.`);
		}
		return {
			content: [{ type: "text", text: description }],
			details: { visionModel: { modelId: settings.modelId, baseUrl: settings.baseUrl }, path: absolutePath },
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Vision service request failed for ${path}: ${reason}`);
	}
}

export function createDescribeImageToolDefinition(
	cwd: string,
	options?: DescribeImageToolOptions,
): ToolDefinition<typeof describeImageSchema, DescribeImageToolDetails | undefined> {
	return {
		name: "describe_image",
		label: "Describe image",
		description:
			"Describe ONE image file with the user's dedicated vision service and return a markdown description. Pass exactly one image path per call; to describe multiple images, call this tool once per image. Use this tool ONLY when you cannot see images (this model lacks image input); when reading an image returns '[Current model does not support images...]', call this tool with the same path. If you can see images, use the `read` tool to view image files directly instead.",
		promptSnippet: "Describe images via the configured vision service when this model cannot see images",
		parameters: describeImageSchema,
		async execute(_toolCallId, params, signal?, _onUpdate?, ctx?) {
			if (!options) throw new Error("describe_image runtime is not configured");
			return await describeImage(options, cwd, params.path, signal, ctx);
		},
	};
}

export function createDescribeImageTool(
	cwd: string,
	options?: DescribeImageToolOptions,
): AgentTool<typeof describeImageSchema, DescribeImageToolDetails | undefined> {
	return wrapToolDefinition(createDescribeImageToolDefinition(cwd, options));
}
