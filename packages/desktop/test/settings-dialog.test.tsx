// @vitest-environment jsdom

import type {
	DeclarativeHookView,
	HooksListView,
	ModelSettingsView,
	UsageRangeDays,
	UsageSummaryView,
	WebSearchSettingsView,
} from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HooksSettingsPanel } from "../src/renderer/components/HooksSettingsPanel.tsx";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog.tsx";
import { UsagePanel } from "../src/renderer/components/UsagePanel.tsx";
import { WebSearchSettingsPanel } from "../src/renderer/components/WebSearchSettingsPanel.tsx";
import type { GeneralPreferences } from "../src/renderer/general-preferences.ts";
import { APP_LOCALE_STORAGE_KEY, setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const generalPreferences: GeneralPreferences = {
	motion: "system",
	chatFont: "anthropic-serif",
	codeFont: "system-sans",
};

	const modelSettings: ModelSettingsView = {
	defaultModel: { provider: "openai", modelId: "gpt-5" },
	visionModel: null,
	imageGen: null,
	defaultThinkingSelection: "high",
	providers: [{
		provider: "openai",
		name: "OpenAI",
		builtin: true,
		baseUrl: null,
		api: null,
		auth: { configured: true, source: "stored", label: "••••1234" },
		models: [{ provider: "openai", modelId: "gpt-5", name: "GPT-5", contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, imageInput: true, custom: false }],
	}],
	loadError: null,
};

function usage(rangeDays: UsageRangeDays): UsageSummaryView {
	const daily = Array.from({ length: rangeDays }, (_, index) => ({
		date: new Date(Date.UTC(2026, 7, 8 - rangeDays + index + 1)).toISOString().slice(0, 10),
		chatTokens: index === rangeDays - 1 ? 20 : 0,
		codeTokens: index === rangeDays - 1 ? 80 : 0,
		inputTokens: index === rangeDays - 1 ? 60 : 0,
		outputTokens: index === rangeDays - 1 ? 40 : 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	}));
	return { generatedAt: "2026-08-08T12:00:00.000Z", rangeDays, totalTokens: 100, inputTokens: 60, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, chatTokens: 20, codeTokens: 80, sessionCount: 2, chatSessionCount: 1, codeSessionCount: 1, daily, topModels: [{ provider: "openai", modelId: "gpt-5", totalTokens: 100 }] };
}

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(
		element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
		"value",
	)?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("SettingsDialog", () => {
	it("keeps only the active page mounted and closes with Escape", async () => {
		const api = {
			getProfile: vi.fn().mockResolvedValue({ generatedAt: "2026-08-08T12:00:00.000Z", totalTokens: 0, peakDailyTokens: 0, longestSessionMs: 0, currentStreakDays: 0, longestStreakDays: 0, sessionCount: 0, mostUsedMode: null, mostUsedModePercent: 0, mostUsedThinkingLevel: null, mostUsedThinkingLevelPercent: 0, usedSkillCount: 0, skillUseCount: 0, activity: [], topSkills: [] }),
			getUsage: vi.fn(({ rangeDays }: { rangeDays: UsageRangeDays }) => Promise.resolve(usage(rangeDays))),
			getModelSettings: vi.fn().mockResolvedValue(modelSettings),
			updateModelSettings: vi.fn().mockResolvedValue(modelSettings),
			testModelConnection: vi.fn(),
			getWebSearchSettings: vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false }),
		} as unknown as MetisDesktopApi;
		const onClose = vi.fn();
		const onGeneralPreferencesChange = vi.fn();
		const onThemeChange = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<SettingsDialog
				api={api}
				generalPreferences={generalPreferences}
				onClose={onClose}
				onGeneralPreferencesChange={onGeneralPreferencesChange}
				onThemeChange={onThemeChange}
				serverReady
				theme="dark"
			/>,
		));
		await flush();
		expect(api.getProfile).not.toHaveBeenCalled();
		expect(api.getUsage).not.toHaveBeenCalled();
		await act(async () => button(container, "Profile").click());
		await flush();
		expect(api.getProfile).toHaveBeenCalledTimes(1);
		const pageScroll = container.querySelector<HTMLElement>(".settings-page-scroll")!;
		pageScroll.scrollTop = 120;
		await act(async () => button(container, "Usage").click());
		await flush();
		expect(pageScroll.scrollTop).toBe(0);
		expect(api.getUsage).toHaveBeenCalledWith({ rangeDays: 30 });
		expect(container.querySelector(".profile-panel")).toBeNull();
		await act(async () => button(container, "Model").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await act(async () => button(container, "Default reasoning").click());
		const settingsDialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(settingsDialog.querySelector(".menu-select-popover")).not.toBeNull();
		await act(async () => settingsDialog.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!.click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(onClose).not.toHaveBeenCalled();
		expect(container.querySelector(".model-provider-dialog")).toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(onClose).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("changes language, appearance, motion, and independent prose fonts from General", async () => {
		const api = {
			getWebSearchSettings: vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false }),
		} as unknown as MetisDesktopApi;
		const onClose = vi.fn();
		const onGeneralPreferencesChange = vi.fn();
		const onThemeChange = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<SettingsDialog
				api={api}
				generalPreferences={generalPreferences}
				onClose={onClose}
				onGeneralPreferencesChange={onGeneralPreferencesChange}
				onThemeChange={onThemeChange}
				serverReady
				theme="dark"
			/>,
		));
		await flush();
		expect(container.querySelector(".general-page")).not.toBeNull();
		expect(container.querySelector(".web-search-toggle")).not.toBeNull();
		expect(button(container, "English").getAttribute("aria-pressed")).toBe("true");
		await act(async () => button(container, "中文").click());
		expect(localStorage.getItem(APP_LOCALE_STORAGE_KEY)).toBe("zh-CN");
		const dark = button(container, "深色");
		expect(dark.getAttribute("aria-pressed")).toBe("true");
		await act(async () => button(container, "浅色").click());
		expect(onThemeChange).toHaveBeenCalledWith("light");
		await act(async () => button(container, "减少动效").click());
		expect(onGeneralPreferencesChange).toHaveBeenCalledWith({ ...generalPreferences, motion: "reduced" });
		await act(async () => button(container, "Chat 字体").click());
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]:last-of-type')!.click());
		expect(onGeneralPreferencesChange).toHaveBeenCalledWith({ ...generalPreferences, chatFont: "system-sans" });
		await act(async () => button(container, "Code 字体").click());
		await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click());
		expect(onGeneralPreferencesChange).toHaveBeenCalledWith({ ...generalPreferences, codeFont: "system-serif" });
		await act(async () => root.unmount());
	});

	it("loads and explicitly saves bounded global instructions from Personalization", async () => {
		const getPersonalization = vi.fn().mockResolvedValue({ instructions: "Initial" });
		const updatePersonalization = vi
			.fn()
			.mockImplementation(async ({ instructions }: { instructions: string }) => ({ instructions }));
		const api = {
			getPersonalization,
			updatePersonalization,
			getWebSearchSettings: vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<SettingsDialog
				api={api}
				generalPreferences={generalPreferences}
				onClose={vi.fn()}
				onGeneralPreferencesChange={vi.fn()}
				onThemeChange={vi.fn()}
				serverReady
				theme="dark"
			/>,
		));
		expect(getPersonalization).not.toHaveBeenCalled();
		await act(async () => button(container, "Personalization").click());
		await flush();
		const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Global instructions"]')!;
		expect(textarea.value).toBe("Initial");
		expect(getPersonalization).toHaveBeenCalledTimes(1);
		await act(async () => setValue(textarea, "Be concise."));
		await act(async () => button(container, "Save instructions").click());
		await flush();
		expect(updatePersonalization).toHaveBeenCalledWith({ instructions: "Be concise." });
		expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");

		await act(async () => setValue(textarea, "😀".repeat(16_385)));
		expect(button(container, "Save instructions").disabled).toBe(true);
		expect(container.textContent).toContain("Global instructions are too large.");
		expect(updatePersonalization).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});
});

describe("ModelSettingsPanel", () => {
	it("opens a built-in provider as a credential-first form", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const testModelConnection = vi.fn().mockResolvedValue({ ok: true, message: "Connection succeeded", latencyMs: 42 });
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();
		expect(container.querySelector(".model-provider-intro")?.textContent).toContain("Select a provider");
		expect(container.querySelector(".model-settings-page h2")?.textContent).not.toBe("Providers");
		expect(container.querySelectorAll(".model-provider-card")).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await flush();
		expect(container.querySelector(".model-provider-dialog")?.hasAttribute("open")).toBe(true);
		const editor = container.querySelector<HTMLElement>(".model-provider-editor")!;
		expect(editor.textContent).toContain("••••••••••••");
		expect(editor.textContent).not.toContain("Add provider");
		expect(editor.textContent).not.toContain("Base URL");
		expect(editor.textContent).not.toContain("Protocol");
		expect(editor.textContent).not.toContain("Custom models");
		await act(async () => button(editor, "Use this model").click());
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({ mutation: { type: "set_defaults", model: { provider: "openai", modelId: "gpt-5" }, thinkingSelection: "high" } }));
		const credential = editor.querySelector<HTMLInputElement>('input[type="password"]')!;
		await act(async () => {
			setValue(credential, "updated-key");
		});
		await act(async () => button(editor, "Save API key").click());
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: {
				type: "save_provider",
				provider: "openai",
				name: "OpenAI",
				baseUrl: null,
				api: null,
				models: [],
				credential: { action: "set", value: "updated-key" },
			},
		}));
		await act(async () => button(container, "Test connection").click());
		await flush();
		expect(testModelConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", modelId: "gpt-5" }));
		expect(container.textContent).toContain("Connection succeeded · 42 ms");
		await act(async () => button(container, "Clear credentials").click());
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: expect.objectContaining({ provider: "openai", credential: { action: "remove" } }),
		}));
		await act(async () => root.unmount());
	});

	it("selects and saves a vision model from image-capable authenticated models", async () => {
		const visionSettings: ModelSettingsView = {
			...modelSettings,
			visionModel: { provider: "openai", modelId: "gpt-5" },
			providers: [
				{
					provider: "openai",
					name: "OpenAI",
					builtin: true,
					baseUrl: null,
					api: null,
					auth: { configured: true, source: "stored", label: "••••1234" },
					models: [
						{ provider: "openai", modelId: "gpt-5", name: "GPT-5", contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, imageInput: true, custom: false },
						{ provider: "openai", modelId: "gpt-4o-text", name: "GPT Text", contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false, imageInput: false, custom: false },
					],
				},
				{
					provider: "noauth",
					name: "No Auth",
					builtin: true,
					baseUrl: null,
					api: null,
					auth: { configured: false },
					models: [
						{ provider: "noauth", modelId: "eye", name: "Eye", contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false, imageInput: true, custom: false },
					],
				},
			],
		};
		const updateModelSettings = vi.fn().mockResolvedValue(visionSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(visionSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		// 之前保存的视觉模型应显示；纯文本模型和未认证 provider 的模型不在选项里
		await act(async () => button(container, "OpenAI / GPT-5").click());
		await flush();
		const optionNames = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((item) => item.textContent);
		expect(optionNames.some((name) => name?.includes("OpenAI / GPT-5"))).toBe(true);
		expect(optionNames.some((name) => name?.includes("GPT Text"))).toBe(false);
		expect(optionNames.some((name) => name?.includes("Eye"))).toBe(false);
		expect(optionNames.some((name) => name?.includes("Not configured"))).toBe(true);

		// 选“不配置”保存 null
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Not configured"))?.click();
		});
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: { type: "set_vision_model", model: null },
		}));
		await act(async () => root.unmount());
	});

	it("falls back to Not configured when the saved vision model disappears", async () => {
		const noVisionSettings: ModelSettingsView = {
			...modelSettings,
			providers: [{
				provider: "openai",
				name: "OpenAI",
				builtin: true,
				baseUrl: null,
				api: null,
				auth: { configured: true, source: "stored", label: "••••1234" },
				models: [
					{ provider: "openai", modelId: "gpt-5", name: "GPT-5", contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, imageInput: false, custom: false },
				],
			}],
		};
		const updateModelSettings = vi.fn().mockResolvedValue(noVisionSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(noVisionSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		// 默认 visionModel 为 null；空 imageInput 模型时显示空态提示
		expect(container.querySelector(".model-vision-select .menu-select-value")?.textContent).toContain("Not configured");
		expect(container.textContent).toContain("No image-capable models are configured yet.");
		await act(async () => root.unmount());
	});

	it("configures, edits, and removes the image-generation service", async () => {
		const updateModelSettings = vi.fn();
		updateModelSettings.mockImplementation(async ({ mutation }: { mutation: any }) => {
			if (mutation.type === "set_image_gen") {
				return {
					...modelSettings,
					imageGen: mutation.settings
						? { ...mutation.settings, authConfigured: mutation.credential.action !== "remove" }
						: null,
				};
			}
			return modelSettings;
		});
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		// 未配置态
		expect(container.textContent).toContain("Not configured");
		await act(async () => button(container, "Configure").click());
		await flush();

		// 填写表单并保存
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="My image gen"]')!, "My image gen"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="https://api.openai.com/v1"]')!, "https://api.openai.com/v1"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="gpt-image-1"]')!, "gpt-image-1"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="sk-…"]')!, "sk-image-key"));
		await act(async () => button(container, "Save").click());
		await flush();

		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: expect.objectContaining({
				type: "set_image_gen",
				settings: { name: "My image gen", baseUrl: "https://api.openai.com/v1", api: "openai-images", modelId: "gpt-image-1" },
				credential: { action: "set", value: "sk-image-key" },
			}),
		}));
		await act(async () => root.unmount());
	});

	it("adds a custom provider with base URL, API format, key, and multiple models", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Add provider").click());
		await flush();
		expect(container.querySelector(".model-custom-provider-dialog")?.hasAttribute("open")).toBe(true);

		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!, "my-custom");
		});
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!, "https://api.mycorp.dev/v1");
		});
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="sk-…"]')!, "sk-custom-key");
		});
		// 第一行模型（默认已有）
		const firstRow = container.querySelectorAll<HTMLElement>(".model-custom-model-row")[0]!;
		await act(async () => {
			setValue(firstRow.querySelector<HTMLInputElement>('input[placeholder="gpt-5"]')!, "my-model-a");
			setValue(firstRow.querySelectorAll<HTMLInputElement>("input")[1]!, "My Model A");
			setValue(firstRow.querySelectorAll<HTMLInputElement>("input")[2]!, "200000");
			setValue(firstRow.querySelectorAll<HTMLInputElement>("input")[3]!, "32000");
		});
		// 添加第二行
		await act(async () => button(container, "Add model").click());
		await flush();
		const secondRow = container.querySelectorAll<HTMLElement>(".model-custom-model-row")[1]!;
		await act(async () => {
			setValue(secondRow.querySelector<HTMLInputElement>('input[placeholder="gpt-5"]')!, "my-model-b");
			setValue(secondRow.querySelectorAll<HTMLInputElement>("input")[1]!, "My Model B");
		});

		// 切换 API 格式为 Anthropic Messages（MenuSelect 选项是 role=option，portal 到 dialog 内）
		await act(async () => button(container, "OpenAI Responses").click());
		await flush();
		await act(async () => {
			[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Anthropic Messages"))?.click();
		});
		await flush();

		await act(async () => button(container, "Save provider").click());
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: {
				type: "save_provider",
				provider: "my-custom",
				name: "my-custom",
				baseUrl: "https://api.mycorp.dev/v1",
				api: "anthropic-messages",
				models: [
					{ modelId: "my-model-a", name: "My Model A", contextWindow: 200000, maxOutputTokens: 32000, reasoning: false, imageInput: false },
					{ modelId: "my-model-b", name: "My Model B", contextWindow: 128000, maxOutputTokens: 16384, reasoning: false, imageInput: false },
				],
				credential: { action: "set", value: "sk-custom-key" },
			},
		}));
		await act(async () => root.unmount());
	});

	it("edits and removes an existing custom provider with its saved values", async () => {
		const customSettings: ModelSettingsView = {
			...modelSettings,
			defaultModel: { provider: "my-custom", modelId: "my-model-a" },
			providers: [{
				provider: "my-custom",
				name: "My Custom",
				builtin: false,
				baseUrl: "https://api.mycorp.dev/v1",
				api: "anthropic-messages",
				auth: { configured: true, source: "stored", label: "••••1234" },
				models: [
					{ provider: "my-custom", modelId: "my-model-a", name: "My Model A", contextWindow: 200000, maxOutputTokens: 32000, reasoning: false, imageInput: false, custom: true },
					{ provider: "my-custom", modelId: "my-model-b", name: "My Model B", contextWindow: 128000, maxOutputTokens: 16384, reasoning: false, imageInput: false, custom: true },
				],
			}],
		};
		const updateModelSettings = vi.fn().mockResolvedValue(customSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(customSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await flush();
		const editor = container.querySelector<HTMLElement>(".model-custom-provider-dialog")!;
		expect(editor.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!.value)
			.toBe("https://api.mycorp.dev/v1");
		expect(editor.textContent).toContain("My Model A");
		expect(editor.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!.value).toBe("My Custom");
		// 默认模型应预选为 my-model-a（而不是无脑选第一个）
		expect(editor.querySelector(".model-use-row .menu-select-value")?.textContent).toBe("My Model A");

		// 改名后保存：显示名更新，provider id 与已有凭据保持不变；保存成功后 dialog 关闭
		const nameInput = editor.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!;
		await act(async () => { setValue(nameInput, "My Custom Renamed"); });
		await act(async () => button(editor, "Save provider").click());
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: expect.objectContaining({ provider: "my-custom", name: "My Custom Renamed", credential: { action: "keep" } }),
		}));
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();

		// 重新打开并移除
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await flush();
		await act(async () => button(container, "Remove provider").click());
		await flush();
		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: { type: "remove_provider", provider: "my-custom" },
		}));
		await act(async () => root.unmount());
	});

	it("marks a custom model as image-capable when the Image input toggle is checked", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Add provider").click());
		await flush();
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!, "vision-provider"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!, "https://api.vision.dev/v1"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="sk-…"]')!, "sk-vision-key"));
		const firstRow = container.querySelectorAll<HTMLElement>(".model-custom-model-row")[0]!;
		await act(async () => setValue(firstRow.querySelector<HTMLInputElement>('input[placeholder="gpt-5"]')!, "vision-model"));
		// 默认未勾选
		expect((firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
		await act(async () => firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => button(container, "Save provider").click());
		await flush();

		expect(updateModelSettings).toHaveBeenCalledWith(expect.objectContaining({
			mutation: expect.objectContaining({
				provider: "vision-provider",
				models: [
					expect.objectContaining({ modelId: "vision-model", imageInput: true }),
				],
			}),
		}));
		await act(async () => root.unmount());
	});

	it("restores the saved image input toggle when editing a custom provider", async () => {
		const customSettings: ModelSettingsView = {
			...modelSettings,
			defaultModel: null,
			providers: [{
				provider: "vision-provider",
				name: "Vision Provider",
				builtin: false,
				baseUrl: "https://api.vision.dev/v1",
				api: "openai-responses",
				auth: { configured: true, source: "stored", label: "••••1234" },
				models: [
					{ provider: "vision-provider", modelId: "vision-model", name: "Vision Model", contextWindow: 128000, maxOutputTokens: 16384, reasoning: false, imageInput: true, custom: true },
				],
			}],
		};
		const updateModelSettings = vi.fn().mockResolvedValue(customSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(customSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await flush();
		const firstRow = container.querySelectorAll<HTMLElement>(".model-custom-model-row")[0]!;
		expect((firstRow.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
		await act(async () => root.unmount());
	});

	it("rejects a custom provider name that collides with an existing provider", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Add provider").click());
		await flush();
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!, "openai");
		});
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!, "https://api.example.com/v1");
		});
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="sk-…"]')!, "sk-key");
		});
		await act(async () => button(container, "Save provider").click());
		await flush();
		expect(container.textContent).toContain("A provider with this name already exists");
		expect(updateModelSettings).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("rejects duplicate model IDs within a custom provider", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Add provider").click());
		await flush();
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="my-provider"]')!, "my-dup");
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="https://api.example.com/v1"]')!, "https://api.example.com/v1");
			setValue(container.querySelector<HTMLInputElement>('input[placeholder="sk-…"]')!, "sk-key");
		});
		await act(async () => button(container, "Add model").click());
		await flush();
		const rows = container.querySelectorAll<HTMLElement>(".model-custom-model-row");
		await act(async () => {
			setValue(rows[0]!.querySelector('input[placeholder="gpt-5"]')!, "same-id");
			setValue(rows[1]!.querySelector('input[placeholder="gpt-5"]')!, "same-id");
		});
		await act(async () => button(container, "Save provider").click());
		await flush();
		expect(container.textContent).toContain("Model IDs must be unique");
		expect(updateModelSettings).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("opens only one provider dialog at a time", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(modelSettings);
		const api = { getModelSettings: vi.fn().mockResolvedValue(modelSettings), updateModelSettings, testModelConnection: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Add provider").click());
		await flush();
		expect(container.querySelectorAll(".model-provider-dialog")).toHaveLength(1);
		// 打开内置卡片时，自定义编辑器必须被关闭
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await flush();
		expect(container.querySelectorAll(".model-provider-dialog")).toHaveLength(1);
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();
		// 关闭内置 dialog 后再开添加，同样只有一个
		await act(async () => button(container, "Close provider settings").click());
		await flush();
		await act(async () => button(container, "Add provider").click());
		await flush();
		expect(container.querySelectorAll(".model-provider-dialog")).toHaveLength(1);
		expect(container.querySelector(".model-custom-provider-dialog")).not.toBeNull();
		await act(async () => root.unmount());
	});
});

describe("WebSearchSettingsPanel", () => {
	const webSearchSettings: WebSearchSettingsView = { enabled: false, provider: "brave", authConfigured: false };

	it("reveals a stored API key on demand and hides it again", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue({
			enabled: true,
			provider: "brave",
			authConfigured: true,
			configuredProviders: ["brave", "tavily"],
			authSource: "stored",
		});
		const revealWebSearchCredential = vi.fn().mockResolvedValue({ credential: "brave-secret" });
		const api = { getWebSearchSettings, revealWebSearchCredential } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<WebSearchSettingsPanel api={api} serverReady />));
		await flush();

		const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(input.placeholder.length).toBeGreaterThanOrEqual(24);
		await act(async () => button(container, "Show API key").click());
		await flush();
		expect(revealWebSearchCredential).toHaveBeenCalledWith({ provider: "brave" });
		expect(input.type).toBe("text");
		expect(input.value).toBe("brave-secret");

		await act(async () => button(container, "Hide API key").click());
		expect(input.type).toBe("password");
		expect(input.value).toBe("");

		await act(async () => button(container, "Brave Search").click());
		await flush();
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Tavily"))?.click();
		});
		await flush();
		expect(input.placeholder.length).toBeGreaterThanOrEqual(24);
		expect(button(container, "Show API key")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("loads and saves web search settings with an API key", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue(webSearchSettings);
		const updateWebSearchSettings = vi.fn().mockResolvedValue({ ...webSearchSettings, enabled: true, provider: "serpapi", authConfigured: true, authSource: "stored" });
		const api = { getWebSearchSettings, updateWebSearchSettings } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<WebSearchSettingsPanel api={api} serverReady />));
		await flush();

		expect(container.querySelector(".personalization-section")).not.toBeNull();
		expect(container.querySelector(".web-search-toggle")).not.toBeNull();
		// 切换启用（checkbox 用 click）+ 供应商（serpapi），输入 key，保存
		await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => button(container, "Brave Search").click());
		await flush();
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("SerpApi"))?.click();
		});
		await flush();
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, "serp-key");
		});
		await act(async () => button(container, "Save").click());
		await flush();

		expect(updateWebSearchSettings).toHaveBeenCalledWith({
			enabled: true,
			provider: "serpapi",
			credential: { action: "set", value: "serp-key" },
		});
		expect(container.querySelector(".settings-toast")?.textContent).toContain("Saved");
		await act(async () => root.unmount());
	});

	it("dismisses the saved toast after 2.5 seconds", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue(webSearchSettings);
		const updateWebSearchSettings = vi.fn().mockResolvedValue(webSearchSettings);
		const api = { getWebSearchSettings, updateWebSearchSettings } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<WebSearchSettingsPanel api={api} serverReady />));
		await flush();

		vi.useFakeTimers();
		try {
			await act(async () => button(container, "Save").click());
			expect(container.querySelector(".settings-toast")?.textContent).toContain("Saved");
			await act(async () => vi.advanceTimersByTimeAsync(2_500));
			expect(container.querySelector(".settings-toast")).toBeNull();
		} finally {
			vi.useRealTimers();
			await act(async () => root.unmount());
		}
	});

	it("clears the unsaved API key draft when switching providers", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false });
		const updateWebSearchSettings = vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false });
		const api = { getWebSearchSettings, updateWebSearchSettings } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<WebSearchSettingsPanel api={api} serverReady />));
		await flush();

		// 给 Brave 输入未保存的 key
		await act(async () => {
			setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, "brave-draft");
		});
		// 切到 Tavily：草稿必须被清空，保存时不能把 Brave 的 key 存到 Tavily
		await act(async () => button(container, "Brave Search").click());
		await flush();
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Tavily"))?.click();
		});
		await flush();
		expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");

		await act(async () => button(container, "Save").click());
		await flush();
		expect(updateWebSearchSettings).toHaveBeenCalledWith({
			enabled: false,
			provider: "tavily",
			credential: { action: "keep" },
		});
		await act(async () => root.unmount());
	});
});

describe("HooksSettingsPanel", () => {
	const hook: DeclarativeHookView = {
		id: "11111111-2222-4333-8444-555555555555",
		name: "Block dangerous bash",
		enabled: true,
		event: "PreToolUse",
		matcher: "bash",
		runMode: "shell",
		command: "echo blocked >&2; exit 2",
		timeoutSeconds: 30,
	};
	const listView = (hooks: DeclarativeHookView[], loadErrors: string[] = []): HooksListView => ({ hooks, loadErrors });

	it("creates a hook from the form and returns to the list", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([]));
		const upsertHook = vi.fn().mockResolvedValue(
			listView([
				{
					id: "22222222-3333-4444-8555-666666666666",
					name: "Notify on stop",
					enabled: true,
					event: "Stop",
					runMode: "process",
					command: "/usr/bin/say",
					args: ["done"],
				},
			]),
		);
		const api = { listHooks, upsertHook } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();

		expect(container.textContent).toContain("No hooks configured");
		await act(async () => button(container, "New hook").click());
		await flush();

		// 事件切到 Stop：匹配器字段应该消失
		expect(container.querySelector('input[placeholder="bash, write, edit"]')).not.toBeNull();
		await act(async () => button(container, "Pre tool use").click());
		await flush();
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Stop"))?.click();
		});
		await flush();
		expect(container.querySelector('input[placeholder="bash, write, edit"]')).toBeNull();

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Block dangerous bash"]')!, "Notify on stop"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="/usr/bin/env"]')!, "/usr/bin/say"));
		await act(async () => setValue(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="One argument per line"]')!, "done"));
		await act(async () => button(container, "Save").click());
		await flush();

		expect(upsertHook).toHaveBeenCalledTimes(1);
		const saved = upsertHook.mock.calls[0][0].hook;
		expect(saved).toMatchObject({
			name: "Notify on stop",
			event: "Stop",
			runMode: "process",
			command: "/usr/bin/say",
			args: ["done"],
			enabled: true,
		});
		expect(saved.matcher).toBeUndefined();
		expect(container.textContent).toContain("Notify on stop");
		await act(async () => root.unmount());
	});

	it("shows shell mode without the arguments field and builds a shell hook", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([]));
		const upsertHook = vi.fn().mockResolvedValue(listView([]));
		const api = { listHooks, upsertHook } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();
		await act(async () => button(container, "New hook").click());
		await flush();

		expect(container.querySelector('textarea[placeholder="One argument per line"]')).not.toBeNull();
		await act(async () => button(container, "Process").click());
		await flush();
		await act(async () => {
			[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((item) => item.textContent?.includes("Shell command"))?.click();
		});
		await flush();
		expect(container.querySelector('textarea[placeholder="One argument per line"]')).toBeNull();

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Block dangerous bash"]')!, "Shell hook"));
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="echo \'Hello from hook\'"]')!, "echo hi | tr a-z A-Z"));
		// 高级设置默认折叠，展开后才能改超时
		const advanced = container.querySelector<HTMLDetailsElement>(".hooks-advanced")!;
		expect(advanced.open).toBe(false);
		await act(async () => advanced.querySelector("summary")!.click());
		await flush();
		expect(advanced.open).toBe(true);
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="60"]')!, "45"));
		await act(async () => button(container, "Save").click());
		await flush();

		expect(upsertHook).toHaveBeenCalledWith({
			hook: expect.objectContaining({
				name: "Shell hook",
				runMode: "shell",
				command: "echo hi | tr a-z A-Z",
				timeoutSeconds: 45,
			}),
		});
		await act(async () => root.unmount());
	});

	it("validates name, command, JSON metadata, and timeout before saving", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([]));
		const upsertHook = vi.fn().mockResolvedValue(listView([]));
		const api = { listHooks, upsertHook } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();
		await act(async () => button(container, "New hook").click());
		await flush();

		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.textContent).toContain("Enter a hook name.");
		expect(upsertHook).not.toHaveBeenCalled();

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Block dangerous bash"]')!, "h1"));
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.textContent).toContain("Enter a command.");
		expect(upsertHook).not.toHaveBeenCalled();

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="/usr/bin/env"]')!, "/bin/echo"));
		// 高级设置默认折叠，展开后才能改超时和自定义字段
		await act(async () => container.querySelector<HTMLElement>(".hooks-advanced summary")!.click());
		await flush();
		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="60"]')!, "9000"));
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.textContent).toContain("Timeout must be between 1 and 600 seconds.");
		expect(upsertHook).not.toHaveBeenCalled();

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="60"]')!, "30"));
		await act(async () => setValue(container.querySelector<HTMLTextAreaElement>('textarea[placeholder=\'{ "channel": "ops" }\']')!, "[1]"));
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.textContent).toContain("Custom fields must be a JSON object.");
		expect(upsertHook).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("toggles and deletes existing hooks from the list", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([hook]));
		const upsertHook = vi.fn().mockResolvedValue(listView([{ ...hook, enabled: false }]));
		const deleteHook = vi.fn().mockResolvedValue(listView([]));
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
		const api = { listHooks, upsertHook, deleteHook } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();

		expect(container.textContent).toContain("Block dangerous bash");
		await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await flush();
		expect(upsertHook).toHaveBeenCalledWith({ hook: { ...hook, enabled: false } });

		await act(async () => button(container, "Delete").click());
		await flush();
		expect(confirmSpy).toHaveBeenCalled();
		expect(deleteHook).toHaveBeenCalledWith({ id: hook.id });
		await act(async () => root.unmount());
	});

	it("edits an existing hook and keeps its id", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([hook]));
		const upsertHook = vi.fn().mockResolvedValue(listView([{ ...hook, name: "Renamed" }]));
		const api = { listHooks, upsertHook } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();

		await act(async () => button(container, "Edit hook").click());
		await flush();
		expect(container.textContent).toContain("Edit hook");
		expect((container.querySelector<HTMLInputElement>('input[placeholder="bash, write, edit"]') as HTMLInputElement).value).toBe("bash");

		await act(async () => setValue(container.querySelector<HTMLInputElement>('input[placeholder="Block dangerous bash"]')!, "Renamed"));
		await act(async () => button(container, "Save").click());
		await flush();
		expect(upsertHook).toHaveBeenCalledWith({ hook: expect.objectContaining({ id: hook.id, name: "Renamed" }) });
		await act(async () => root.unmount());
	});

	it("surfaces load errors from malformed hooks.json entries", async () => {
		const listHooks = vi.fn().mockResolvedValue(listView([hook], ["bad: Hook event must be one of: …"]));
		const api = { listHooks } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<HooksSettingsPanel api={api} serverReady />));
		await flush();
		expect(container.textContent).toContain("Some hooks could not be loaded:");
		expect(container.textContent).toContain("bad: Hook event must be one of: …");
		await act(async () => root.unmount());
	});
});

describe("UsagePanel", () => {
	it("switches ranges and exposes chart and table views from one summary", async () => {
		const getUsage = vi.fn(({ rangeDays }: { rangeDays: UsageRangeDays }) => Promise.resolve(usage(rangeDays)));
		const api = { getUsage } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<UsagePanel api={api} serverReady />));
		await flush();
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(30);
		await act(async () => button(container, "7d").click());
		await flush();
		expect(getUsage).toHaveBeenLastCalledWith({ rangeDays: 7 });
		expect(container.querySelectorAll(".usage-bar")).toHaveLength(7);
		const tableView = button(container, "Table view");
		await act(async () => tableView.click());
		expect(tableView.getAttribute("aria-pressed")).toBe("true");
		expect(button(container, "Chart view").getAttribute("aria-pressed")).toBe("false");
		expect(container.querySelector(".usage-chart-wrap")).toBeNull();
		expect(container.querySelector("table")).not.toBeNull();
		const chartView = button(container, "Chart view");
		await act(async () => chartView.click());
		expect(chartView.getAttribute("aria-pressed")).toBe("true");
		expect(container.querySelector(".usage-chart-wrap")).not.toBeNull();
		expect(container.querySelector("table")).toBeNull();
		await act(async () => root.unmount());
	});
});
