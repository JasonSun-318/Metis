import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { IMAGE_GENERATION_AUTH_KEY, type ImageGenerationConfig } from "../../src/core/image-generation/config.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const config: ImageGenerationConfig = {
	name: "Images",
	api: "openai-images",
	modelId: "image-model",
	baseUrl: "https://images.test/v1",
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=";

describe("AgentSession image generation", () => {
	it("keeps unconfigured image_generate in the model context and emits a failed tool result", async () => {
		const harness = await createHarness({ withAgentDir: true, permissionPreset: "auto" });
		const request = vi.spyOn(globalThis, "fetch");
		try {
			expect(harness.session.getActiveToolNames()).toContain("image_generate");
			expect(harness.session.systemPrompt).toContain("- image_generate:");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("image_generate", { prompt: "robot" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Please configure the image service."),
			]);
			await harness.session.prompt("draw a robot");
			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "image_generate",
			);
			expect(result).toMatchObject({ isError: true });
			expect(getMessageText(result)).toContain("IMAGE_MODEL_NOT_CONFIGURED");
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
			await harness.cleanup();
		}
	});

	it("honors explicit tool allowlists and exclusions", async () => {
		const restricted = await createHarness({ allowedToolNames: ["read"] });
		const excluded = await createHarness({ excludedToolNames: ["image_generate"] });
		try {
			expect(restricted.session.getActiveToolNames()).not.toContain("image_generate");
			expect(excluded.session.getActiveToolNames()).not.toContain("image_generate");
		} finally {
			await restricted.cleanup();
			await excluded.cleanup();
		}
	});

	it("rejects a changed endpoint after permission approval before calling the provider", async () => {
		let harness!: Harness;
		harness = await createHarness({
			withAgentDir: true,
			settings: { imageGeneration: config },
			permissionPreset: "ask",
			requestPermissionApproval: async () => {
				harness.settingsManager.setImageGenerationConfig({ ...config, baseUrl: "https://different.test/v1" });
				return { decision: "allow" };
			},
		});
		harness.authStorage.set(IMAGE_GENERATION_AUTH_KEY, { type: "api_key", key: "secret" });
		const request = vi.spyOn(globalThis, "fetch");
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("image_generate", { prompt: "robot" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("draw");
			const result = harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolName === "image_generate",
			);
			expect(getMessageText(result)).toContain("Network scope changed");
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
			await harness.cleanup();
		}
	});

	it("refreshes a separate settings/auth writer into an already open session without recreating its tool", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "metis-image-refresh-"));
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.setPermissionPreset("full");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settingsManager,
			authStorage,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			resourceLoader: createTestResourceLoader(),
		});
		const request = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ data: [{ b64_json: png }] }));
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "image_generate")!;
			await expect(tool.execute("before", { prompt: "robot" })).rejects.toThrow("IMAGE_MODEL_NOT_CONFIGURED");
			const writer = SettingsManager.create(cwd, agentDir);
			writer.setImageGenerationConfig(config);
			await writer.flush();
			const authWriter = AuthStorage.create(join(agentDir, "auth.json"));
			authWriter.set(IMAGE_GENERATION_AUTH_KEY, { type: "api_key", key: "first-key" });
			await session.applyModelServiceSettingsRefresh();
			const result = await tool.execute("after", { prompt: "robot" });
			expect(result.details).toMatchObject({ status: "completed" });
			expect(request.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer first-key" });
			authWriter.set(IMAGE_GENERATION_AUTH_KEY, { type: "api_key", key: "updated-key" });
			await session.applyModelServiceSettingsRefresh();
			await tool.execute("updated", { prompt: "robot" });
			expect(request.mock.calls[1]![1]!.headers).toMatchObject({ Authorization: "Bearer updated-key" });
			writer.setImageGenerationConfig(undefined);
			await writer.flush();
			await session.applyModelServiceSettingsRefresh();
			await expect(tool.execute("removed", { prompt: "robot" })).rejects.toThrow("IMAGE_MODEL_NOT_CONFIGURED");
		} finally {
			request.mockRestore();
			session.dispose();
			sessionManager.close();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
