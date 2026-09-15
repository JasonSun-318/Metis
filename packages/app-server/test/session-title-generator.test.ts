import type { ModelRegistry, SettingsManager } from "@metis/coding-agent/host";
import { describe, expect, it, vi } from "vitest";
import { DefaultSessionTitleGenerator } from "../src/session-title-generator.ts";

describe("DefaultSessionTitleGenerator", () => {
	it("asks the model to summarize a greeting as a short title", async () => {
		const streamSimple = vi.fn(() => ({
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "日常问好" }],
			}),
		}));
		const generator = new DefaultSessionTitleGenerator({
			modelRegistry: {
				refresh: vi.fn(),
				find: vi.fn(() => ({ provider: "test", id: "model", reasoning: false })),
				hasConfiguredAuth: vi.fn(() => true),
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
				streamSimple,
			} as unknown as ModelRegistry,
			settingsManager: {
				getDefaultProvider: vi.fn(() => "test"),
				getDefaultModel: vi.fn(() => "model"),
			} as unknown as SettingsManager,
		});

		await expect(generator.generate("你好")).resolves.toBe("日常问好");
		expect(streamSimple).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				systemPrompt: expect.stringContaining("You are a conversation title generator"),
				messages: [expect.objectContaining({ content: "First message: 你好\nTitle:" })],
			}),
			expect.anything(),
		);
	});

	it("uses the default model at its lowest supported thinking level and limits English titles by words", async () => {
		const model = {
			provider: "test-provider",
			id: "test-model",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null },
		};
		const streamSimple = vi.fn(() => ({
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: "## “Fix incorrect session date sorting in sidebar now.”\nExtra" }],
			}),
		}));
		const modelRegistry = {
			refresh: vi.fn(),
			find: vi.fn(() => model),
			hasConfiguredAuth: vi.fn(() => true),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
			streamSimple,
		} as unknown as ModelRegistry;
		const settingsManager = {
			getDefaultProvider: vi.fn(() => model.provider),
			getDefaultModel: vi.fn(() => model.id),
		} as unknown as SettingsManager;
		const generator = new DefaultSessionTitleGenerator({ modelRegistry, settingsManager });

		await expect(generator.generate("Why are old sessions grouped under today?")).resolves.toBe(
			"Fix incorrect session date sorting in…",
		);
		expect(streamSimple).toHaveBeenCalledWith(
			model,
			expect.objectContaining({
				systemPrompt: expect.stringContaining("otherwise use no more than 6 words"),
				messages: [expect.objectContaining({ role: "user" })],
			}),
			expect.objectContaining({ reasoning: "low", maxTokens: 32, maxRetries: 0, timeoutMs: 10_000 }),
		);
	});

	it("does nothing without a configured default and falls back safely after a provider failure", async () => {
		const missingDefault = new DefaultSessionTitleGenerator({
			modelRegistry: { refresh: vi.fn() } as unknown as ModelRegistry,
			settingsManager: {
				getDefaultProvider: vi.fn(() => undefined),
				getDefaultModel: vi.fn(() => undefined),
			} as unknown as SettingsManager,
		});
		await expect(missingDefault.generate("Keep this unnamed")).resolves.toBeUndefined();

		const prompt = "🚀".repeat(60);
		const failed = new DefaultSessionTitleGenerator({
			modelRegistry: {
				refresh: vi.fn(),
				find: vi.fn(() => ({ provider: "test", id: "model", reasoning: false })),
				hasConfiguredAuth: vi.fn(() => true),
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
				streamSimple: vi.fn(() => ({
					result: async () => {
						throw new Error("offline");
					},
				})),
			} as unknown as ModelRegistry,
			settingsManager: {
				getDefaultProvider: vi.fn(() => "test"),
				getDefaultModel: vi.fn(() => "model"),
			} as unknown as SettingsManager,
		});
		await expect(failed.generate(prompt)).resolves.toBe(`${"🚀".repeat(9)}…`);
	});
});
