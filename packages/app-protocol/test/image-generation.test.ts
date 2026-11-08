import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ImageGenerationViewSchema, ModelSettingsMutationSchema, ToolResultBlockViewSchema } from "../src/index.ts";

const config = { name: "Images", api: "openai-images", baseUrl: "https://example.test/v1", modelId: "image-model" };
const image = {
	fileId: "0123456789abcdef",
	name: "image.png",
	byteLength: 120,
	deliveredAt: "2026-11-05T10:00:00.000Z",
	availability: "available",
	mediaType: "image/png",
	width: 1024,
	height: 1024,
};
const result = { status: "completed", requestedCount: 1, images: [image] };

describe("image generation protocol", () => {
	const mutation = Compile(ModelSettingsMutationSchema);
	const view = Compile(ImageGenerationViewSchema);
	it("accepts the OpenRouter image API in settings mutations", () => {
		expect(
			mutation.Check({
				type: "set_image_generation",
				config: { ...config, api: "openrouter-images" },
				credential: { action: "set", value: "key" },
			}),
		).toBe(true);
	});

	it("validates dedicated, reused and cleared profiles without exposing key fields in config", () => {
		expect(
			mutation.Check({ type: "set_image_generation", config, credential: { action: "set", value: "key" } }),
		).toBe(true);
		expect(
			mutation.Check({ type: "set_image_generation", config: { ...config, credentialProvider: "openai" } }),
		).toBe(true);
		expect(mutation.Check({ type: "set_image_generation", config: null })).toBe(true);
		expect(mutation.Check({ type: "set_image_generation", config: { ...config, apiKey: "secret" } })).toBe(false);
		expect(
			mutation.Check({
				type: "set_image_generation",
				config: { ...config, baseUrl: "https://example.test/?key=secret" },
			}),
		).toBe(false);
	});

	it("supports bounded loading and completed results on the existing tool result block", () => {
		expect(view.Check({ status: "generating", requestedCount: 4, images: [] })).toBe(true);
		expect(view.Check(result)).toBe(true);
		expect(view.Check({ ...result, aspectRatio: "auto" })).toBe(true);
		expect(
			Compile(ToolResultBlockViewSchema).Check({
				type: "tool_result",
				toolCallId: "image-1",
				name: "image_generate",
				isError: false,
				output: "Generated image",
				imageGeneration: result,
			}),
		).toBe(true);
	});

	it("rejects unbounded outputs, inline image bytes and private provider continuation metadata", () => {
		expect(view.Check({ ...result, requestedCount: 5 })).toBe(false);
		expect(view.Check({ ...result, images: Array(5).fill(image) })).toBe(false);
		expect(view.Check({ ...result, images: [{ ...image, continuation: { interactionId: "private" } }] })).toBe(false);
		expect(view.Check({ ...result, images: [{ ...image, data: "base64" }] })).toBe(false);
		expect(view.Check({ ...result, images: [{ ...image, mediaType: "image/svg+xml" }] })).toBe(false);
	});
});
