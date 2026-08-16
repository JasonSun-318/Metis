/**
 * Vision describer tool: lets models without image input "see" images.
 *
 * The tool is always registered. At execution time it routes:
 * 1. models that already accept images -> tell them to use `read` directly
 * 2. no vision model configured -> tell the model to ask the user to configure one
 * 3. otherwise -> read the image and ask the configured vision model for a
 *    markdown description via a standalone streaming request
 */

import { readFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@metis/agent-core";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const describeImageSchema = Type.Object({
	path: Type.String({ description: "Path to the image file (jpg, png, gif, webp, bmp)", minLength: 1 }),
});

export type DescribeImageToolInput = Static<typeof describeImageSchema>;

export interface DescribeImageToolDetails {
	visionModel: { provider: string; modelId: string };
	path: string;
}

export interface DescribeImageToolOptions {
	/** Current vision-model reference from settings; undefined when not configured. */
	getVisionRef(): { provider: string; modelId: string } | undefined;
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "getApiKeyAndHeaders" | "streamSimple">;
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

	const visionRef = options.getVisionRef();
	if (!visionRef) {
		throw new Error(
			"No vision model is configured, so this image cannot be described. Ask the user to configure one under Settings → Model → Vision model.",
		);
	}

	const visionModel = options.modelRegistry.find(visionRef.provider, visionRef.modelId);
	if (!visionModel || !options.modelRegistry.hasConfiguredAuth(visionModel)) {
		throw new Error(
			`The configured vision model (${visionRef.provider}/${visionRef.modelId}) is unavailable. Ask the user to reconfigure it under Settings → Model → Vision model.`,
		);
	}
	if (!visionModel.input.includes("image")) {
		throw new Error(
			`The configured vision model (${visionRef.provider}/${visionRef.modelId}) does not accept image input. Ask the user to pick an image-capable model under Settings → Model → Vision model.`,
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

	const auth = await options.modelRegistry.getApiKeyAndHeaders(visionModel);
	if (!auth.ok) {
		throw new Error(
			`Could not authenticate the vision model (${visionRef.provider}/${visionRef.modelId}): ${auth.error}`,
		);
	}

	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const message = await options.modelRegistry
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
					apiKey: auth.apiKey,
					env: auth.env,
					headers: auth.headers,
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
			throw new Error(
				`The vision model (${visionRef.provider}/${visionRef.modelId}) returned an empty description for ${path}.`,
			);
		}
		return {
			content: [{ type: "text", text: description }],
			details: { visionModel: visionRef, path: absolutePath },
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Vision model request failed for ${path}: ${reason}`);
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
			"Describe ONE image file with the user's dedicated vision model and return a markdown description. Pass exactly one image path per call; to describe multiple images, call this tool once per image. Use this tool ONLY when you cannot see images (this model lacks image input); when reading an image returns '[Current model does not support images...]', call this tool with the same path. If you can see images, use the `read` tool to view image files directly instead.",
		promptSnippet: "Describe images via the configured vision model when this model cannot see images",
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
