// @vitest-environment jsdom

import type { MemorySettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySettingsPanel } from "../src/renderer/components/MemorySettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(name));
	if (!match) throw new Error(`Missing button: ${name}`);
	return match as HTMLButtonElement;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

describe("MemorySettingsPanel", () => {
	const memorySettings: MemorySettingsView = {
		autoMemoryEnabled: true,
		memoryEngine: "index",
		embeddingConfigured: false,
		rerankConfigured: false,
		lastError: null,
		memoryMigrationNotice: null,
	};

	it("loads and saves memory settings", async () => {
		const getMemorySettings = vi.fn().mockResolvedValue(memorySettings);
		const updateMemorySettings = vi.fn().mockResolvedValue({
			...memorySettings,
			autoMemoryEnabled: false,
		});
		const api = { getMemorySettings, updateMemorySettings } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} onConfigureModels={vi.fn()} serverReady />));
		await flush();

		expect(getMemorySettings).toHaveBeenCalledTimes(1);
		expect(container.querySelector(".memory-settings-section")).not.toBeNull();
		expect(container.querySelector(".web-search-toggle")).not.toBeNull();

		await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => button(container, "Save").click());
		await flush();

		expect(updateMemorySettings).toHaveBeenCalledWith({
			autoMemoryEnabled: false,
			memoryEngine: "index",
		});
		expect(container.querySelector(".settings-toast")?.textContent).toContain("Saved");
		await act(async () => root.unmount());
	});

	it("warns, renders health/migration state, and navigates to Model configuration", async () => {
		const onConfigureModels = vi.fn();
		const getMemorySettings = vi.fn().mockResolvedValue(memorySettings);
		const updateMemorySettings = vi.fn();
		const api = { getMemorySettings, updateMemorySettings } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} onConfigureModels={onConfigureModels} serverReady />));
		await flush();

		expect(container.querySelector(".memory-settings-warning")?.textContent).toMatch(/embedding model/i);

		const engineTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Memory engine"]')!;
		await act(async () => engineTrigger().click());
		await flush();
		const extractOption = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) =>
			item.textContent?.includes("Extract"),
		);
		expect(extractOption?.disabled).toBe(true);

		await act(async () => button(container, "Configure in Models").click());
		expect(onConfigureModels).toHaveBeenCalledOnce();
		await act(async () => root.unmount());
	});

	it("enables Extract only when Embedding is configured and sends no model refs", async () => {
		const configured = { ...memorySettings, embeddingConfigured: true };
		const updateMemorySettings = vi.fn().mockResolvedValue({ ...configured, memoryEngine: "extract" });
		const api = {
			getMemorySettings: vi.fn().mockResolvedValue(configured),
			updateMemorySettings,
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<MemorySettingsPanel api={api} onConfigureModels={vi.fn()} serverReady />));
		await flush();

		const engineTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Memory engine"]')!;
		await act(async () => engineTrigger().click());
		await flush();
		const enabledExtract = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) =>
			item.textContent?.includes("Extract"),
		);
		expect(enabledExtract?.disabled).toBe(false);
		await act(async () => enabledExtract?.click());
		await flush();
		await act(async () => button(container, "Save").click());
		await flush();

		expect(updateMemorySettings).toHaveBeenCalledWith({
			autoMemoryEnabled: true,
			memoryEngine: "extract",
		});
		await act(async () => root.unmount());
	});
});
