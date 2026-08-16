import * as fs from "node:fs";
import { readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerateImageToolDefinition, type GenerateImageToolOptions } from "../src/core/tools/generate-image.ts";

const generateImagesMock = vi.hoisted(() => vi.fn());

vi.mock("@metis/ai/compat", () => ({
	generateImages: generateImagesMock,
}));

const PNG_BASE64 = Buffer.from("fake-png").toString("base64");
const HASH_FILENAME = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

function makeOptions(overrides: Partial<GenerateImageToolOptions> = {}): GenerateImageToolOptions {
	return {
		getSettings: () => ({
			name: "My image gen",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-images",
			modelId: "gpt-image-1",
		}),
		getApiKey: async () => "sk-test",
		...overrides,
	};
}

async function run(
	options: GenerateImageToolOptions | undefined,
	params: { prompt: string; count?: number },
	sessionFile: string,
) {
	const definition = createGenerateImageToolDefinition(options);
	return await definition.execute("tc1", params, undefined, undefined, {
		sessionManager: { getSessionFile: () => sessionFile },
	} as never);
}

describe("generate_image tool", () => {
	let workDir: string;
	let sessionFile: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-generate-img-"));
		sessionFile = path.join(workDir, "session.jsonl");
		generateImagesMock.mockReset();
	});
	afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

	function savedImages(): string[] {
		const imagesDir = path.join(workDir, "images");
		if (!fs.existsSync(imagesDir)) return [];
		return readdirSync(imagesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => readdirSync(path.join(imagesDir, entry.name)).filter((name) => HASH_FILENAME.test(name)));
	}

	it("throws setup guidance when no service is configured", async () => {
		await expect(
			run(makeOptions({ getSettings: () => undefined }), { prompt: "a cat" }, sessionFile),
		).rejects.toThrow(/No image-generation service is configured/);
	});

	it("throws when the API key is missing", async () => {
		await expect(
			run(makeOptions({ getApiKey: async () => undefined }), { prompt: "a cat" }, sessionFile),
		).rejects.toThrow(/no API key/);
	});

	it("throws for non-persisted (in-memory) sessions", async () => {
		await expect(run(makeOptions(), { prompt: "a cat" }, "")).rejects.toThrow(/persisted session/);
	});

	it("saves one image and returns its path as text", async () => {
		generateImagesMock.mockResolvedValue({
			stopReason: "stop",
			output: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
		});
		const result = await run(makeOptions(), { prompt: "a red circle" }, sessionFile);

		const files = savedImages();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(HASH_FILENAME);
		expect((result.content[0] as { text: string }).text).toContain("Generated 1 of 1");
		expect((result.content[0] as { text: string }).text).toContain(path.join(workDir, "images"));
		expect(result.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(result.details).toMatchObject({
			modelId: "gpt-image-1",
			failures: 0,
			imageCount: 1,
		});
		expect(result.details?.savedPaths).toHaveLength(1);
		expect(path.basename(result.details!.savedPaths[0]!)).toMatch(HASH_FILENAME);
		expect(generateImagesMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: "gpt-image-1", api: "openai-images", baseUrl: "https://api.openai.com/v1" }),
			{ input: [{ type: "text", text: "a red circle" }] },
			expect.objectContaining({ apiKey: "sk-test" }),
		);
	});

	it("reports partial failures honestly when only some images succeed", async () => {
		generateImagesMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				output: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }],
			})
			.mockResolvedValueOnce({ stopReason: "error", errorMessage: "429 rate limited" });
		const result = await run(makeOptions(), { prompt: "a red circle", count: 2 }, sessionFile);

		expect(generateImagesMock).toHaveBeenCalledTimes(2);
		expect(savedImages()).toHaveLength(1);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("Generated 1 of 2");
		expect(text).toContain("429 rate limited");
		expect(result.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(result.details).toMatchObject({ failures: 1, imageCount: 1 });
	});

	it("throws when every request fails", async () => {
		generateImagesMock.mockResolvedValue({ stopReason: "error", errorMessage: "quota exceeded" });
		await expect(run(makeOptions(), { prompt: "a cat", count: 2 }, sessionFile)).rejects.toThrow(
			/failed for all 2 request\(s\).*quota exceeded/,
		);
		expect(savedImages()).toHaveLength(0);
	});

	it("uses webp/jpg extensions from the returned mime type", async () => {
		generateImagesMock.mockResolvedValue({
			stopReason: "stop",
			output: [{ type: "image", mimeType: "image/webp", data: PNG_BASE64 }],
		});
		const result = await run(makeOptions(), { prompt: "a cat" }, sessionFile);
		expect(savedImages()[0]).toMatch(/\.webp$/);
		expect(result.content[1]).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/webp" });
	});
});
