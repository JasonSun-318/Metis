import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImagesModel } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastClientOptions: undefined as unknown,
	nextResponse: undefined as unknown,
	nextError: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.lastClientOptions = options;
		}

		images = {
			generate: (params: unknown) => {
				mockState.lastParams = params;
				if (mockState.nextError) return Promise.reject(mockState.nextError);
				return Promise.resolve(mockState.nextResponse);
			},
		};
	}
	return { default: FakeOpenAI };
});

import { generateImages as generateImagesOpenAI } from "../src/api/openai-images.ts";

function model(): ImagesModel<"openai-images"> {
	return {
		id: "gpt-image-1",
		name: "GPT Image 1",
		api: "openai-images",
		provider: "custom",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

const CONTEXT = { input: [{ type: "text" as const, text: "A red circle on white background" }] };

beforeEach(() => {
	mockState.lastParams = undefined;
	mockState.lastClientOptions = undefined;
	mockState.nextResponse = undefined;
	mockState.nextError = undefined;
});

describe("openai-images api", () => {
	it("sends prompt to /images/generations and returns b64 image content", async () => {
		mockState.nextResponse = {
			data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A red circle" }],
			usage: { input_tokens: 10, output_tokens: 1024, total_tokens: 1034 },
		};
		const result = await generateImagesOpenAI(model(), CONTEXT, { apiKey: "sk-test" });

		expect(result.stopReason).toBe("stop");
		expect(mockState.lastParams).toMatchObject({
			model: "gpt-image-1",
			prompt: "A red circle on white background",
			n: 1,
		});
		expect(mockState.lastClientOptions).toMatchObject({ apiKey: "sk-test", baseURL: "https://api.openai.com/v1" });
		expect(result.output).toEqual([
			{ type: "text", text: "A red circle" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		]);
		expect(result.usage).toMatchObject({ input: 10, output: 1024 });
	});

	it("downloads legacy url responses and converts them to base64", async () => {
		const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(
			async () => new Response(Buffer.from("fake-png-bytes"), { headers: { "content-type": "image/png" } }),
		);
		globalThis.fetch = fetchMock as typeof fetch;
		mockState.nextResponse = { data: [{ url: "https://tmp.example/img.png" }] };
		try {
			const result = await generateImagesOpenAI(model(), CONTEXT, { apiKey: "sk-test" });
			expect(result.stopReason).toBe("stop");
			expect(result.output).toContainEqual({ type: "image", mimeType: "image/png", data: pngBase64 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("rejects image input (generations endpoint is text-only)", async () => {
		const result = await generateImagesOpenAI(
			model(),
			{ input: [{ type: "image", mimeType: "image/png", data: "eHg=" }] },
			{ apiKey: "sk-test" },
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/does not accept image input/);
	});

	it("fails without an api key or with no image data", async () => {
		const noKey = await generateImagesOpenAI(model(), CONTEXT);
		expect(noKey.stopReason).toBe("error");
		expect(noKey.errorMessage).toMatch(/No API key/);

		mockState.nextResponse = { data: [{ revised_prompt: "no image" }] };
		const noImage = await generateImagesOpenAI(model(), CONTEXT, { apiKey: "sk-test" });
		expect(noImage.stopReason).toBe("error");
		expect(noImage.errorMessage).toMatch(/no image data/);
	});

	it("wraps provider errors instead of rejecting", async () => {
		mockState.nextError = new Error("429 rate limited");
		const result = await generateImagesOpenAI(model(), CONTEXT, { apiKey: "sk-test" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("429 rate limited");
		expect(result.output).toEqual([]);
	});
});
