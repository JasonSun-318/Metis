/**
 * Image-generation tool: calls the user-configured image-gen service and
 * saves the generated images into the session's image directory.
 *
 * Always registered. Returns absolute paths (for describe_image) and inline
 * ImageContent (for vision models and the TUI). Each requested image is one
 * request; partial failures are reported honestly instead of retried.
 */

import type { AgentTool } from "@metis/agent-core";
import { generateImages } from "@metis/ai/compat";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { persistSessionImage } from "../session-manager.ts";
import type { ImageGenSettings } from "../settings-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const generateImageSchema = Type.Object({
	prompt: Type.String({ description: "Description of the image to generate", minLength: 1, maxLength: 4_000 }),
	count: Type.Optional(
		Type.Integer({ description: "How many images to generate (default 1, max 4)", minimum: 1, maximum: 4 }),
	),
});

export type GenerateImageToolInput = Static<typeof generateImageSchema>;

export interface GenerateImageToolDetails {
	modelId: string;
	savedPaths: string[];
	imageCount: number;
	failures: number;
}

export interface GenerateImageToolOptions {
	/** Current image-gen service settings; undefined when not configured. */
	getSettings(): ImageGenSettings | undefined;
	/** Resolves the stored API key for the image-gen service. */
	getApiKey(): Promise<string | undefined>;
}

const REQUEST_TIMEOUT_MS = 180_000;

export function createGenerateImageToolDefinition(
	options?: GenerateImageToolOptions,
): ToolDefinition<typeof generateImageSchema, GenerateImageToolDetails | undefined> {
	return {
		name: "generate_image",
		label: "Generate image",
		description:
			"Generate images from a text prompt using the user's configured image-generation service. Saves them into the session image directory and returns both the file paths and the images inline. If you cannot see the images (your model lacks image input), call describe_image with a returned file path.",
		promptSnippet: "Generate images from a prompt with the configured image-gen service",
		parameters: generateImageSchema,
		async execute(_toolCallId, params, signal?, _onUpdate?, ctx?) {
			if (!options) throw new Error("generate_image runtime is not configured");
			const settings = options.getSettings();
			if (!settings) {
				throw new Error(
					"No image-generation service is configured. Ask the user to configure one under Settings → Model → Image generation.",
				);
			}
			const apiKey = await options.getApiKey();
			if (!apiKey) {
				throw new Error(
					"The image-generation service has no API key. Ask the user to set it under Settings → Model → Image generation.",
				);
			}

			const sessionFile = ctx?.sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("generate_image requires a persisted session to store images");
			}

			const count = params.count ?? 1;
			const images: { type: "image"; data: string; mimeType: string; path: string }[] = [];
			const failures: string[] = [];
			for (let index = 0; index < count; index++) {
				const result = await generateImages(
					{
						id: settings.modelId,
						name: settings.name,
						api: settings.api,
						provider: "image-gen",
						baseUrl: settings.baseUrl,
						input: settings.api === "openrouter-images" ? ["text", "image"] : ["text"],
						output: ["image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
					{ input: [{ type: "text", text: params.prompt }] },
					{
						apiKey,
						maxRetries: 0,
						timeoutMs: REQUEST_TIMEOUT_MS,
						...(signal ? { signal } : {}),
					},
				);
				if (result.stopReason !== "stop") {
					failures.push(result.errorMessage || `request ${index + 1} failed (${result.stopReason})`);
					continue;
				}
				const image = result.output.find(
					(item): item is { type: "image"; data: string; mimeType: string } => item.type === "image",
				);
				if (!image) {
					failures.push(`request ${index + 1} returned no image data`);
					continue;
				}
				try {
					const saved = persistSessionImage(sessionFile, image);
					images.push({ ...image, path: saved.path });
				} catch (error) {
					failures.push(
						`request ${index + 1} could not be saved: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			if (images.length === 0) {
				throw new Error(
					`Image generation failed for all ${count} request(s) with ${settings.modelId}: ${failures.join("; ")}`,
				);
			}

			const savedPaths = images.map((image) => image.path);
			const lines = [
				`Generated ${images.length} of ${count} requested image(s) with ${settings.modelId}:`,
				...savedPaths.map((savedPath) => `- ${savedPath}`),
				...(failures.length > 0
					? ["", `${failures.length} request(s) failed:`, ...failures.map((reason) => `- ${reason}`)]
					: []),
				"",
				"If you cannot see the images (no image input), call describe_image with a saved path above.",
			];

			return {
				content: [
					{ type: "text", text: lines.join("\n") },
					...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
				],
				details: {
					modelId: settings.modelId,
					savedPaths,
					imageCount: images.length,
					failures: failures.length,
				},
			};
		},
	};
}

export function createGenerateImageTool(
	options?: GenerateImageToolOptions,
): AgentTool<typeof generateImageSchema, GenerateImageToolDetails | undefined> {
	return wrapToolDefinition(createGenerateImageToolDefinition(options));
}
