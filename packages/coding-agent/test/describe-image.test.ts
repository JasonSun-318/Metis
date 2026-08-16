import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDescribeImageToolDefinition, type DescribeImageToolOptions } from "../src/core/tools/describe-image.ts";

/** 1x1 red BMP, the smallest image processImage accepts (see image-process.test.ts). */
function tinyBmp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function modelWithInput(input: ("text" | "image")[]) {
	return { id: "v-model", name: "Vision", provider: "test", input } as never;
}

function registryMock(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
	return {
		find: vi.fn(() => modelWithInput(["text", "image"])),
		hasConfiguredAuth: vi.fn(() => true),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "k", env: undefined, headers: undefined })),
		streamSimple: vi.fn(() => ({
			result: async () => ({
				content: [{ type: "text", text: "# Image\n\nA 1x1 red square." }],
			}),
		})),
		...overrides,
	};
}

function options(
	overrides: Omit<Partial<DescribeImageToolOptions>, "modelRegistry"> & {
		modelRegistry?: ReturnType<typeof registryMock>;
	} = {},
): DescribeImageToolOptions {
	return {
		getVisionRef: () => ({ provider: "test", modelId: "v-model" }),
		...overrides,
		modelRegistry: (overrides.modelRegistry ??
			registryMock()) as unknown as DescribeImageToolOptions["modelRegistry"],
	};
}

async function run(toolOptions: DescribeImageToolOptions | undefined, imagePath: string, ctx?: object) {
	const definition = createDescribeImageToolDefinition("/tmp", toolOptions);
	return await definition.execute("tc1", { path: imagePath }, undefined, undefined, ctx as never);
}

describe("describe_image tool", () => {
	let workDir: string;
	let imagePath: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-describe-img-"));
		imagePath = path.join(workDir, "tiny.bmp");
		fs.writeFileSync(imagePath, tinyBmp());
	});
	afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

	it("tells vision-capable models to use read instead", async () => {
		const result = await run(options(), imagePath, { model: modelWithInput(["text", "image"]) });
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("`read` tool");
	});

	it("throws with setup guidance when no vision model is configured", async () => {
		await expect(run(options({ getVisionRef: () => undefined }), imagePath)).rejects.toThrow(
			/No vision model is configured/,
		);
	});

	it("throws when the configured vision model is unavailable", async () => {
		const registry = registryMock({ find: vi.fn(() => undefined) });
		await expect(run(options({ modelRegistry: registry }), imagePath)).rejects.toThrow(/unavailable/);
		const registryNoAuth = registryMock({ hasConfiguredAuth: vi.fn(() => false) });
		await expect(run(options({ modelRegistry: registryNoAuth }), imagePath)).rejects.toThrow(/unavailable/);
	});

	it("throws when the configured vision model cannot accept images", async () => {
		const registry = registryMock({ find: vi.fn(() => modelWithInput(["text"])) });
		await expect(run(options({ modelRegistry: registry }), imagePath)).rejects.toThrow(/does not accept image input/);
	});

	it("throws for non-image files", async () => {
		const textPath = path.join(workDir, "notes.txt");
		fs.writeFileSync(textPath, "not an image");
		await expect(run(options(), textPath)).rejects.toThrow(/not a supported image/);
	});

	it("returns the vision model's markdown description", async () => {
		const registry = registryMock();
		const result = await run(options({ modelRegistry: registry }), imagePath);
		expect((result.content[0] as { text: string }).text).toContain("A 1x1 red square.");
		expect(result.details).toMatchObject({ visionModel: { provider: "test", modelId: "v-model" } });
		// 请求里带 system prompt 和图片内容
		const call = registry.streamSimple.mock.calls[0] as unknown as {
			1: { systemPrompt: string; messages: Array<{ content: Array<{ type: string }> }> };
		};
		expect(call[1].systemPrompt).toContain("markdown");
		const blocks = call[1].messages[0].content;
		expect(blocks.some((block: { type: string }) => block.type === "image")).toBe(true);
	});

	it("surfaces vision request failures as tool errors", async () => {
		const registry = registryMock({
			streamSimple: vi.fn(() => ({
				result: async () => {
					throw new Error("429 rate limited");
				},
			})),
		});
		await expect(run(options({ modelRegistry: registry }), imagePath)).rejects.toThrow(
			/Vision model request failed.*429/,
		);
	});
});
