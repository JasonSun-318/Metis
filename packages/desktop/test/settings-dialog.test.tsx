// @vitest-environment jsdom

import type { ModelSettingsView, UsageRangeDays, UsageSummaryView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog.tsx";
import { UsagePanel } from "../src/renderer/components/UsagePanel.tsx";
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
		const api = {} as unknown as MetisDesktopApi;
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
		const api = { getPersonalization, updatePersonalization } as unknown as MetisDesktopApi;
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
		expect(container.textContent).not.toContain("Add provider");
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
