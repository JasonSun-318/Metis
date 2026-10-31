// @vitest-environment jsdom

import type { ModelSettingsProviderView, ModelSettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const roots: Root[] = [];

function unconfiguredProvider(index: number): ModelSettingsProviderView {
	const label = String(index).padStart(2, "0");
	return {
		provider: `provider-${label}`,
		name: `Provider ${label}`,
		builtin: true,
		api: null,
		baseUrl: null,
		auth: { configured: false },
		models: [],
	};
}

function settings(): ModelSettingsView {
	return {
		defaultModel: { provider: "openai", modelId: "gpt-5" },
		defaultThinkingSelection: "high",
		vision: null,
		permissionReviewer: { config: null, status: "unconfigured" },
		loadError: null,
		providers: [
			{
				provider: "openai",
				name: "OpenAI",
				builtin: true,
				api: null,
				baseUrl: null,
				auth: { configured: true, source: "stored" },
				models: [
					{
						provider: "openai",
						modelId: "gpt-5",
						name: "GPT-5",
						contextWindow: 128000,
						maxOutputTokens: 16384,
						reasoning: true,
						thinkingLevels: ["off", "low", "high"],
						reasoningMode: null,
						reasoningSource: null,
						imageInput: true,
						custom: false,
					},
				],
			},
			...Array.from({ length: 18 }, (_, index) => unconfiguredProvider(index)),
		],
	};
}

function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

function setInput(element: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount() {
	const api = {
		getModelSettings: vi.fn().mockResolvedValue(settings()),
		updateModelSettings: vi.fn(),
		testModelConnection: vi.fn(),
		discoverModels: vi.fn(),
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<ModelSettingsPanel api={api as never} serverReady />));
	return { container };
}

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("model settings catalog regions", () => {
	it("lists the default and specialized cards before the bounded provider section", async () => {
		const { container } = await mount();
		const html = container.innerHTML;
		expect(html.indexOf("New task defaults")).toBeLessThan(html.indexOf("Specialized models"));
		expect(html.indexOf("Specialized models")).toBeLessThan(html.indexOf("<h3>Providers</h3>"));
		expect(html.indexOf("Approval model")).toBeLessThan(html.indexOf("<h3>Providers</h3>"));
		expect(container.querySelector(".model-provider-list-region .model-provider-card")?.textContent).toContain(
			"OpenAI",
		);
		expect(container.querySelector(".model-provider-list-region")?.textContent).not.toContain("Provider 00");
	});

	it("searches only the configured list while keeping Add provider visible", async () => {
		const { container } = await mount();
		const search = container.querySelector<HTMLInputElement>('.model-provider-toolbar input[type="search"]')!;
		expect(button(container, "Add provider")).toBeTruthy();
		await act(async () => setInput(search, "no match"));
		expect(container.querySelectorAll(".model-provider-list-region .model-provider-card")).toHaveLength(0);
		expect(container.textContent).toContain("No providers match your search.");
		await act(async () => setInput(search, "openai"));
		expect(container.querySelectorAll(".model-provider-list-region .model-provider-card")).toHaveLength(1);
		expect(button(container, "Add provider")).toBeTruthy();
	});

	it("paginates and searches the full provider catalog in a dialog", async () => {
		const { container } = await mount();
		const trigger = button(container, "Add provider");
		trigger.focus();
		await act(async () => trigger.click());

		const dialog = container.querySelector<HTMLDialogElement>(".model-provider-catalog-dialog")!;
		expect(dialog.hasAttribute("open")).toBe(true);
		expect(dialog.querySelectorAll(".model-provider-card")).toHaveLength(8);
		expect(dialog.textContent).toContain("Page 1 of 3");
		expect(button(dialog, "Previous page").disabled).toBe(true);

		await act(async () => button(dialog, "Next page").click());
		expect(dialog.querySelectorAll(".model-provider-card")).toHaveLength(8);
		expect(dialog.textContent).toContain("Page 2 of 3");
		expect(dialog.querySelector(".model-provider-card")?.textContent).toContain("Provider 08");

		const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
		await act(async () => setInput(search, "Provider 17"));
		expect(dialog.querySelectorAll(".model-provider-card")).toHaveLength(1);
		expect(dialog.textContent).toContain("Provider 17");
		expect(dialog.textContent).toContain("Page 1 of 1");

		await act(async () => setInput(search, "no match"));
		expect(dialog.querySelectorAll(".model-provider-card")).toHaveLength(0);
		expect(dialog.textContent).toContain("No providers match your search.");
		expect(button(dialog, "Add custom provider")).toBeTruthy();

		await act(async () =>
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
		);
		expect(container.querySelector(".model-provider-catalog-dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
