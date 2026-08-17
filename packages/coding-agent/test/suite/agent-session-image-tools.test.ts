import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Context, Model, SimpleStreamOptions } from "@metis/ai";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { VISION_PROVIDER_ID } from "../../src/core/settings-manager.ts";
import { createDescribeImageToolDefinition, VISION_DESCRIPTION_PROMPT } from "../../src/core/tools/describe-image.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

/** 1x1 red BMP accepted by processImage. */
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

const DESCRIBE_SNIPPET = "Describe images via the configured vision service when this model cannot see images";
const DESCRIBE_DESCRIPTION = createDescribeImageToolDefinition("/tmp").description;

const visionSettings = {
	name: "My vision",
	baseUrl: "https://vision.example/v1",
	api: "openai-responses" as const,
	modelId: "vision-model",
};

describe("AgentSession image tools", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it("keeps describe_image inactive until settings and an API key exist", async () => {
		const withoutConfig = await createHarness();
		harnesses.push(withoutConfig);

		expect(withoutConfig.session.getAllTools().map((tool) => tool.name)).toContain("describe_image");
		expect(withoutConfig.session.getActiveToolNames()).not.toContain("describe_image");
		expect(withoutConfig.session.systemPrompt).not.toContain("- describe_image:");

		const settingsOnly = await createHarness({
			settings: { vision: visionSettings },
		});
		harnesses.push(settingsOnly);
		expect(settingsOnly.session.getActiveToolNames()).not.toContain("describe_image");
	});

	it("activates describe_image only when the vision service has settings and a stored key", async () => {
		const harness = await createHarness({
			settings: { vision: visionSettings },
		});
		harnesses.push(harness);
		harness.authStorage.set(VISION_PROVIDER_ID, { type: "api_key", key: "sk-vision" });
		await harness.session.refreshImageToolSettings();

		expect(harness.session.getActiveToolNames()).toContain("describe_image");
		expect(harness.session.systemPrompt).toContain(`- describe_image: ${DESCRIBE_SNIPPET}`);

		const describe = harness.session.agent.state.tools.find((tool) => tool.name === "describe_image");
		expect(describe?.description).toBe(DESCRIBE_DESCRIPTION);
		expect(describe?.parameters).toMatchObject({
			type: "object",
			properties: { path: expect.objectContaining({ type: "string" }) },
			required: ["path"],
		});
	});

	it("sends describe_image to the chat model and routes execution through the configured vision service", async () => {
		const harness = await createHarness({
			models: [{ id: "text-only", name: "Text Only", input: ["text"] }],
			settings: { vision: visionSettings },
			withAgentDir: true,
		});
		harnesses.push(harness);
		harness.authStorage.set(VISION_PROVIDER_ID, { type: "api_key", key: "sk-vision" });
		await harness.session.refreshImageToolSettings();

		const imagePath = join(harness.tempDir, "tiny.bmp");
		writeFileSync(imagePath, tinyBmp());

		const visionCalls: Array<{
			model: Model<Api>;
			context: Context;
			options?: SimpleStreamOptions;
		}> = [];
		const originalStreamSimple = ModelRegistry.prototype.streamSimple;
		vi.spyOn(ModelRegistry.prototype, "streamSimple").mockImplementation(function (
			this: ModelRegistry,
			model,
			context,
			options,
		) {
			if (model.provider === "vision") {
				visionCalls.push({ model, context, options });
				return {
					result: async () => ({
						content: [{ type: "text", text: "# Image\n\nA tiny red square." }],
					}),
				} as ReturnType<ModelRegistry["streamSimple"]>;
			}
			return originalStreamSimple.call(this, model, context, options);
		});

		const providerTools: Array<{ name: string; description?: string }>[] = [];
		harness.setResponses([
			(context) => {
				providerTools.push(
					(context.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
				);
				return fauxAssistantMessage(fauxToolCall("describe_image", { path: imagePath }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Describe the image");

		expect(providerTools[0]?.map((tool) => tool.name)).toContain("describe_image");
		expect(providerTools[0]?.find((tool) => tool.name === "describe_image")?.description).toBe(DESCRIBE_DESCRIPTION);

		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "describe_image",
		);
		expect(getMessageText(toolResult)).toContain("A tiny red square.");
		expect(visionCalls).toHaveLength(1);
		expect(visionCalls[0]?.model).toMatchObject({
			id: "vision-model",
			name: "My vision",
			api: "openai-responses",
			provider: "vision",
			baseUrl: "https://vision.example/v1",
			input: ["text", "image"],
		});
		expect(visionCalls[0]?.context.systemPrompt).toBe(VISION_DESCRIPTION_PROMPT);
		expect(visionCalls[0]?.options?.apiKey).toBe("sk-vision");
		const userContent = visionCalls[0]?.context.messages[0]?.content;
		expect(Array.isArray(userContent) && userContent.some((block) => block.type === "image")).toBe(true);
	});

	it("deactivates describe_image after the vision service is cleared", async () => {
		const harness = await createHarness({
			models: [{ id: "text-only", name: "Text Only", input: ["text"] }],
			settings: { vision: visionSettings },
			withAgentDir: true,
		});
		harnesses.push(harness);
		harness.authStorage.set(VISION_PROVIDER_ID, { type: "api_key", key: "sk-vision" });
		await harness.session.refreshImageToolSettings();
		expect(harness.session.getActiveToolNames()).toContain("describe_image");

		harness.settingsManager.clearVisionSettings();
		harness.authStorage.remove(VISION_PROVIDER_ID);
		await harness.session.refreshImageToolSettings();

		expect(harness.session.getActiveToolNames()).not.toContain("describe_image");
		expect(harness.session.systemPrompt).not.toContain("- describe_image:");
	});
});
