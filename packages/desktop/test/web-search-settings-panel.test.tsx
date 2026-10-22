// @vitest-environment jsdom

import type { WebSearchSettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSearchSettingsPanel } from "../src/renderer/components/WebSearchSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

let roots: Root[] = [];

const loadedSettings: WebSearchSettingsView = { enabled: false, provider: "brave", authConfigured: false };

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function setValue(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderPanel(api: MetisDesktopApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<WebSearchSettingsPanel api={api} serverReady />));
	roots.push(root);
	return container;
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

describe("WebSearchSettingsPanel load and save", () => {
	it("shows a retryable load error without config controls, then loads the real settings", async () => {
		let resolveRetry: ((view: WebSearchSettingsView) => void) | undefined;
		const getWebSearchSettings = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockImplementationOnce(
				() =>
					new Promise<WebSearchSettingsView>((resolve) => {
						resolveRetry = resolve;
					}),
			);
		const api = { getWebSearchSettings } as unknown as MetisDesktopApi;
		const container = renderPanel(api);
		await flush();

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("offline");
		expect(container.querySelector('input[type="password"]')).toBeNull();
		expect(container.querySelector('input[type="checkbox"]')).toBeNull();
		expect(container.querySelector(".web-search-provider-select")).toBeNull();
		expect([...container.querySelectorAll("button")].some((candidate) => candidate.textContent === "Save")).toBe(
			false,
		);
		expect(button(container, "Retry")).not.toBeNull();

		await act(async () => button(container, "Retry").click());
		expect(container.querySelector(".settings-loading")).not.toBeNull();
		expect(container.querySelector('input[type="password"]')).toBeNull();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(getWebSearchSettings).toHaveBeenCalledTimes(2);

		resolveRetry?.({
			enabled: true,
			provider: "tavily",
			authConfigured: true,
			configuredProviders: ["tavily"],
			authSource: "stored",
		});
		await flush();

		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
		expect(button(container, "Tavily")).not.toBeNull();
		expect(
			container.querySelector<HTMLInputElement>('input[type="password"]')?.placeholder.length,
		).toBeGreaterThanOrEqual(24);
		expect(container.textContent).toContain("Credential is stored locally by Metis.");
		expect(button(container, "Save")).not.toBeNull();
	});

	it("retains the API key draft and shows the error when saving fails", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue(loadedSettings);
		const updateWebSearchSettings = vi.fn().mockRejectedValue(new Error("save failed"));
		const api = { getWebSearchSettings, updateWebSearchSettings } as unknown as MetisDesktopApi;
		const container = renderPanel(api);
		await flush();

		const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
		await act(async () => setValue(keyInput, "draft-key"));
		await act(async () => button(container, "Save").click());
		await flush();

		expect(updateWebSearchSettings).toHaveBeenCalledTimes(1);
		expect(updateWebSearchSettings).toHaveBeenCalledWith({
			enabled: false,
			provider: "brave",
			credential: { action: "set", value: "draft-key" },
		});
		expect(keyInput.value).toBe("draft-key");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("save failed");
		expect(button(container, "Save")).not.toBeNull();
	});

	it("does not send a duplicate save while the first one is pending", async () => {
		const getWebSearchSettings = vi.fn().mockResolvedValue(loadedSettings);
		let resolveSave: ((view: WebSearchSettingsView) => void) | undefined;
		const updateWebSearchSettings = vi.fn(
			() =>
				new Promise<WebSearchSettingsView>((resolve) => {
					resolveSave = resolve;
				}),
		);
		const api = { getWebSearchSettings, updateWebSearchSettings } as unknown as MetisDesktopApi;
		const container = renderPanel(api);
		await flush();

		await act(async () =>
			setValue(container.querySelector<HTMLInputElement>('input[type="password"]')!, "pending-key"),
		);
		await act(async () => button(container, "Save").click());
		await flush();

		const savingButton = button(container, "Saving…");
		expect(savingButton.disabled).toBe(true);
		await act(async () => savingButton.click());
		await flush();
		expect(updateWebSearchSettings).toHaveBeenCalledTimes(1);

		resolveSave?.({ ...loadedSettings, enabled: true, authConfigured: true, authSource: "stored" });
		await flush();
		expect(container.querySelector(".system-notice")?.textContent).toContain("Saved");
	});
});
