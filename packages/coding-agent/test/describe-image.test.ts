import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDescribeImageToolDefinition,
	type DescribeImageToolOptions,
	VISION_DESCRIPTION_PROMPT,
} from "../src/core/tools/describe-image.ts";

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

const defaultSettings = {
	name: "My vision",
	baseUrl: "https://api.example.com/v1",
	api: "openai-responses" as const,
	modelId: "v-model",
};

function options(overrides: Partial<DescribeImageToolOptions> = {}): DescribeImageToolOptions {
	return {
		getSettings: () => defaultSettings,
		getApiKey: async () => "sk-vision",
		streamSimple: vi.fn(() => ({
			result: async () => ({
				content: [{ type: "text", text: "# Image\n\nA 1x1 red square." }],
			}),
		})) as unknown as DescribeImageToolOptions["streamSimple"],
		...overrides,
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

	it("throws with setup guidance when no vision service is configured", async () => {
		await expect(run(options({ getSettings: () => undefined }), imagePath)).rejects.toThrow(
			/No vision service is configured/,
		);
	});

	it("throws when the vision service has no API key", async () => {
		await expect(run(options({ getApiKey: async () => undefined }), imagePath)).rejects.toThrow(/no API key/);
	});

	it("throws for non-image files", async () => {
		const textPath = path.join(workDir, "notes.txt");
		fs.writeFileSync(textPath, "not an image");
		await expect(run(options(), textPath)).rejects.toThrow(/not a supported image/);
	});

	it("returns the vision service's markdown description", async () => {
		const streamSimple = vi.fn(() => ({
			result: async () => ({
				content: [{ type: "text", text: "# Image\n\nA 1x1 red square." }],
			}),
		}));
		const result = await run(
			options({ streamSimple: streamSimple as unknown as DescribeImageToolOptions["streamSimple"] }),
			imagePath,
		);
		expect((result.content[0] as { text: string }).text).toContain("A 1x1 red square.");
		expect(result.details).toMatchObject({
			visionModel: { modelId: "v-model", baseUrl: "https://api.example.com/v1" },
		});
		const [model, context] = streamSimple.mock.calls[0] as unknown as [
			{ id: string; api: string; baseUrl: string; input: string[] },
			{ systemPrompt: string; messages: Array<{ content: Array<{ type: string }> }> },
		];
		expect(model).toMatchObject({
			id: "v-model",
			api: "openai-responses",
			baseUrl: "https://api.example.com/v1",
			input: ["text", "image"],
		});
		expect(context.systemPrompt).toBe(VISION_DESCRIPTION_PROMPT);
		expect(context.messages[0].content.some((block) => block.type === "image")).toBe(true);
	});

	it("surfaces vision request failures as tool errors", async () => {
		const streamSimple = vi.fn(() => ({
			result: async () => {
				throw new Error("429 rate limited");
			},
		}));
		await expect(
			run(options({ streamSimple: streamSimple as unknown as DescribeImageToolOptions["streamSimple"] }), imagePath),
		).rejects.toThrow(/Vision service request failed.*429/);
	});
});
