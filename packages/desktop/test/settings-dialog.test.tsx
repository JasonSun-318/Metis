// @vitest-environment jsdom

import type { ModelSettingsView, UsageRangeDays, UsageSummaryView, WebSearchSettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
