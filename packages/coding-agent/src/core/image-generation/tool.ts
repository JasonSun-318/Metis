import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentToolResult } from "@metis/agent-core";
import { resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { MAX_SESSION_DELIVERED_FILES, writeSessionDeliveredFile } from "../session-attachments.ts";
import type { SessionDeliveredArtifacts } from "../session-delivered-artifacts.ts";
import {
	exactNetworkEndpoint,
	fileReadPermissionClaim,
	permissionClaim,
	permissionDescriptor,
} from "../tool-permission-adapter.ts";
import type { ImageGenerationConfig } from "./config.ts";
import {
	generateProviderImage,
	ImageGenerationParams,
	type ImageReference,
	imageBytes,
	validateImageGenerationOptions,
} from "./provider.ts";
import type { GeneratedImageDetails, ImageGenerationDetails } from "./types.ts";

export interface ImageGenerationToolOptions {
	getConfig: () => ImageGenerationConfig | undefined;
	getApiKey: (config: ImageGenerationConfig) => string | undefined;
	getSession: () => { agentDir: string; sessionId: string; artifacts: SessionDeliveredArtifacts } | undefined;
	fetch?: typeof globalThis.fetch;
}

export function createImageGenerationToolDefinition(
	cwd: string,
	options?: ImageGenerationToolOptions,
): ToolDefinition<typeof ImageGenerationParams, ImageGenerationDetails> {
	const referencePath = (reference: string): { path: string; image?: GeneratedImageDetails } => {
		if (!reference.startsWith("metis-image:")) return { path: resolvePath(reference, cwd, { trim: true }) };
		const fileId = reference.slice("metis-image:".length);
		const artifacts = options?.getSession()?.artifacts;
		const file = artifacts?.resolve(fileId);
		const image = artifacts?.getGeneratedImage(fileId);
		if (!file || !image)
			throw new Error(
				"IMAGE_GENERATION_REFERENCE_UNAVAILABLE: The referenced image is unavailable in this conversation.",
			);
		return { path: file.path, image };
	};
	return {
		name: "image_generate",
		label: "Generate image",
		description:
			"Generate or edit images using the separately configured image model. Images are saved durably and displayed directly in the conversation; do not call deliver_file or repeat them in Markdown. Use reference_images for edits, including metis-image:<fileId> references from earlier results. Returns IMAGE_MODEL_NOT_CONFIGURED when no image service is configured. Unsupported provider options fail explicitly. Do not retry a failed or cancelled billable request automatically.",
		promptSnippet: "Generate or edit images and display them directly in the conversation",
		parameters: ImageGenerationParams,
		executionMode: "sequential",
		permission: permissionDescriptor((input, context) => {
			const config = options?.getConfig();
			if (!config || !options?.getApiKey(config)) return permissionClaim();
			const claims = (input.reference_images ?? []).map((reference) =>
				fileReadPermissionClaim(referencePath(reference).path, context),
			);
			return permissionClaim({
				readPaths: claims.flatMap((claim) => claim.readPaths),
				effects: [...new Set(claims.flatMap((claim) => claim.effects))],
				networkEndpoints: [exactNetworkEndpoint(config.baseUrl)],
			});
		}),
		execute: async (toolCallId, input, signal, onUpdate) => {
			const config = options?.getConfig();
			const apiKey = config ? options?.getApiKey(config) : undefined;
			if (!config || !apiKey)
				throw new Error(
					"IMAGE_MODEL_NOT_CONFIGURED: 尚未配置生图模型或 API Key，请前往「设置 → 模型 → 图像生成」完成配置。",
				);
			const session = options?.getSession();
			if (!session)
				throw new Error("IMAGE_GENERATION_STORAGE_UNAVAILABLE: This session has no durable image storage.");
			if (signal?.aborted) throw new Error("IMAGE_GENERATION_CANCELLED: Image generation was cancelled.");
			const requestedCount = input.count ?? 1;
			if (!input.prompt.trim()) throw new Error("IMAGE_GENERATION_INVALID_INPUT: prompt must not be empty.");
			const paths = input.reference_images ?? [];
			const mode = !input.mode || input.mode === "auto" ? (paths.length ? "edit" : "generate") : input.mode;
			if ((mode === "edit" && paths.length === 0) || (mode === "generate" && paths.length > 0))
				throw new Error(
					"IMAGE_GENERATION_INVALID_INPUT: edit requires reference_images; generate must not include them.",
				);
			validateImageGenerationOptions(config, input);
			if (session.artifacts.list().length + requestedCount > MAX_SESSION_DELIVERED_FILES)
				throw new Error(
					`IMAGE_GENERATION_LIMIT: This session can hold at most ${MAX_SESSION_DELIVERED_FILES} distinct delivered files.`,
				);
			const references: ImageReference[] = [];
			let referenceBytes = 0;
			for (const reference of paths) {
				const { path, image } = referencePath(reference);
				const handle = await open(path, "r");
				try {
					const metadata = await handle.stat();
					const limit = config.api === "google-interactions" ? 14 * 1024 * 1024 : 50 * 1024 * 1024;
					if (!metadata.isFile() || metadata.size < 1 || metadata.size + referenceBytes > limit)
						throw new Error(
							`IMAGE_GENERATION_INVALID_INPUT: Reference images must be regular image files totaling at most ${Math.round(limit / 1024 / 1024)} MiB.`,
						);
					const bytes = await handle.readFile({ signal });
					referenceBytes += bytes.length;
					if (referenceBytes > limit)
						throw new Error("IMAGE_GENERATION_INVALID_INPUT: Reference images exceeded the input size limit.");
					const validated = imageBytes(bytes);
					// Google retains free-tier interactions for one day. Older edits
					// use the owned image bytes without making a failed retry first.
					const imageAge = image ? Date.now() - Date.parse(image.deliveredAt) : Number.NaN;
					const continuation = imageAge >= 0 && imageAge < 24 * 60 * 60 * 1000 ? image?.continuation : undefined;
					references.push({
						bytes,
						mediaType: validated.mediaType,
						name: basename(path),
						...(continuation ? { continuation } : {}),
					});
				} finally {
					await handle.close();
				}
			}
			const images: GeneratedImageDetails[] = [];
			const result = (
				status: ImageGenerationDetails["status"],
				message?: string,
			): AgentToolResult<ImageGenerationDetails> => ({
				content: [
					{
						type: "text",
						text: images.length
							? `${images.length} image(s) generated and displayed in the conversation.\n${images.map((image) => `${image.name}: metis-image:${image.fileId}`).join("\n")}${message ? `\n${message}` : ""}`
							: "Generating images…",
					},
				],
				details: {
					kind: "image_generation",
					status,
					requestedCount,
					images: [...images],
					...(input.aspect_ratio ? { aspectRatio: input.aspect_ratio } : {}),
					...(message ? { message } : {}),
				},
			});
			onUpdate?.(result("generating"));
			try {
				while (images.length < requestedCount) {
					if (signal?.aborted) throw new Error("IMAGE_GENERATION_CANCELLED: Image generation was cancelled.");
					const generated = await generateProviderImage({
						config,
						apiKey,
						input,
						references,
						signal,
						fetch: options?.fetch,
					});
					if (images.length + generated.length > 4)
						throw new Error("IMAGE_GENERATION_INVALID_RESPONSE: Provider returned more than four images.");
					for (const output of generated) {
						if (session.artifacts.list().length >= MAX_SESSION_DELIVERED_FILES)
							throw new Error(
								`IMAGE_GENERATION_LIMIT: This session can hold at most ${MAX_SESSION_DELIVERED_FILES} distinct delivered files.`,
							);
						const fileId = randomUUID().replaceAll("-", "").slice(0, 16);
						const name = `generated-${fileId}.${output.mediaType.split("/")[1]}`;
						writeSessionDeliveredFile(session.agentDir, session.sessionId, fileId, name, output.bytes);
						const { bytes: _bytes, ...metadata } = output;
						const image: GeneratedImageDetails = {
							...metadata,
							fileId,
							name,
							byteLength: output.bytes.length,
							deliveredAt: new Date().toISOString(),
						};
						images.push(image);
						session.artifacts.stageGeneratedImage(toolCallId, image);
					}
					onUpdate?.(result("generating"));
				}
			} catch (error) {
				if (images.length === 0) throw error;
				const message =
					error instanceof Error
						? error.message.slice(0, 2048)
						: "Image generation failed after saving earlier images.";
				return result("partial", message);
			}
			return result("completed");
		},
	};
}
