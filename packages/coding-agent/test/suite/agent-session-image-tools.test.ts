import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@metis/ai";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../src/core/agent-session-factory.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
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

const IMAGE = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

describe("AgentSession image tools", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it.each([false, true])("does not expose the retired service with native images=%s", async (nativeImages) => {
		const legacySettings = {
			autoMemoryEnabled: false,
			vision: {
				name: "Old service",
				baseUrl: "https://vision.example/v1",
				api: "openai-responses",
				modelId: "old-vision-model",
			},
		};
		const harness = await createHarness({
			models: [{ id: "main", input: nativeImages ? ["text", "image"] : ["text"] }],
			settings: legacySettings,
		});
		harnesses.push(harness);
		harness.authStorage.set("vision", { type: "api_key", key: "unused-legacy-key" });
		await harness.session.applyModelServiceSettingsRefresh();

		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("describe_image");
		expect(harness.session.getActiveToolNames()).toContain("read");
		expect(harness.session.systemPrompt).not.toContain("describe_image");
		let providerToolNames: string[] = [];
		harness.setResponses([
			(context) => {
				providerToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Continue normally");
		expect(providerToolNames).toContain("read");
		expect(providerToolNames).not.toContain("describe_image");
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.authStorage.get("vision")).toEqual({ type: "api_key", key: "unused-legacy-key" });
	});

	it("passes uploaded images and read image results to an image-capable main model", async () => {
		const harness = await createHarness({ models: [{ id: "native-images", input: ["text", "image"] }] });
		harnesses.push(harness);
		const imagePath = join(harness.tempDir, "tiny.bmp");
		writeFileSync(imagePath, tinyBmp());
		const contexts: Context[] = [];
		harness.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage(fauxToolCall("read", { path: imagePath }), { stopReason: "toolUse" });
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("Saw both images");
			},
		]);
		await harness.session.prompt("Inspect this upload and the local image", { images: [IMAGE] });

		expect(contexts).toHaveLength(2);
		const user = contexts[0].messages.find((message) => message.role === "user");
		expect(user?.content).toEqual(expect.arrayContaining([IMAGE]));
		const read = contexts[1].messages.find((message) => message.role === "toolResult" && message.toolName === "read");
		expect(read?.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]),
		);
		expect(getMessageText(read)).not.toContain("does not support images");
		expect(getMessageText(harness.session.messages.at(-1))).toBe("Saw both images");
		const storedUser = harness.sessionManager
			.buildSessionContext()
			.messages.find((message) => message.role === "user");
		expect(storedUser?.content).toEqual(expect.arrayContaining([IMAGE]));
	});

	it("reopens historical describe_image calls and results and continues without the retired tool", async () => {
		const harness = await createHarness({ models: [{ id: "native-images", input: ["text", "image"] }] });
		harnesses.push(harness);
		const manager = SessionManager.create(harness.tempDir, join(harness.tempDir, "history"));
		const call = fauxToolCall("describe_image", { path: "old-image.png" });
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "Describe this" }, IMAGE], timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		const oldResult = {
			role: "toolResult" as const,
			toolName: "describe_image",
			toolCallId: call.id,
			content: [{ type: "text" as const, text: "# Image\n\nA tiny red square." }],
			details: {
				visionModel: { modelId: "old-model", baseUrl: "https://vision.example/v1" },
				path: "old-image.png",
			},
			isError: false,
			timestamp: 2,
		};
		manager.appendMessage(oldResult);
		const path = manager.getSessionFile()!;
		manager.close();
		const original = readFileSync(path, "utf8");
		const reopened = SessionManager.open(path);
		const model = harness.getModel();
		const registry = ModelRegistry.inMemory(harness.authStorage);
		registry.registerProvider(model.provider, {
			api: harness.faux.api,
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			streamSimple: harness.faux.streamSimple,
			models: [model],
		});
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			model,
			modelRegistry: registry,
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			sessionManager: reopened,
		});
		try {
			expect(session.messages).toContainEqual(oldResult);
			expect(session.messages.find((message) => message.role === "user")?.content).toEqual(
				expect.arrayContaining([IMAGE]),
			);
			expect(session.getAllTools().map((tool) => tool.name)).not.toContain("describe_image");
			let context: Context | undefined;
			harness.setResponses([
				(input) => {
					context = input;
					return fauxAssistantMessage("Continued from the old description");
				},
			]);
			await session.prompt("Continue from that description");
			expect(context?.messages).toContainEqual(
				expect.objectContaining({ toolName: "describe_image", content: oldResult.content }),
			);
			expect(context?.tools?.map((tool) => tool.name)).not.toContain("describe_image");
			expect(getMessageText(session.messages.at(-1))).toBe("Continued from the old description");
			expect(readFileSync(path, "utf8").startsWith(original)).toBe(true);
			expect(reopened.buildSessionContext().messages).toContainEqual(oldResult);
		} finally {
			await session.abortAndDrainAgentEventPersistence();
			session.dispose();
		}
	});
});
