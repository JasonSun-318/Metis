// @vitest-environment jsdom

import type { ModelSettingsView } from "@metis/app-protocol";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGenerationSettingsPanel } from "../src/renderer/components/ImageGenerationSettingsPanel.tsx";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type PanelApi = Parameters<typeof ImageGenerationSettingsPanel>[0]["api"];
const roots: Root[] = [];
const config = {
	name: "Studio",
	api: "openai-images" as const,
	baseUrl: "https://images.example/v1",
	modelId: "image-model",
};
function view(configured = false): ModelSettingsView {
	return {
		defaultModel: null,
		defaultThinkingSelection: "medium",
		autoSessionTitle: true,
		loadError: null,
		permissionReviewer: { config: null, status: "unconfigured" },
		imageGeneration: {
			config: configured ? config : null,
			status: configured ? "configured" : "unconfigured",
			authConfigured: configured,
		},
		providers: [
			{
				provider: "stored",
				name: "Stored Provider",
				api: "openai-completions",
				baseUrl: config.baseUrl,
				builtin: false,
				auth: { configured: true, source: "stored" },
				storedApiKey: true,
				models: [],
			},
			{
				provider: "oauth",
				name: "OAuth Provider",
				api: "openai-completions",
				baseUrl: config.baseUrl,
				builtin: false,
				auth: { configured: true, source: "oauth" },
				storedApiKey: false,
				models: [],
			},
		],
	};
}
function button(root: ParentNode, label: string) {
	const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
	);
	if (!button) throw new Error(`Missing button: ${label}`);
	return button;
}
function field(root: ParentNode, label: string) {
	const input = [...root.querySelectorAll("label")]
		.find((node) => node.querySelector("span")?.textContent === label)
		?.querySelector("input");
	if (!input) throw new Error(`Missing field: ${label}`);
	return input;
}
async function click(root: ParentNode, label: string) {
	await act(async () => button(root, label).click());
}
async function fill(root: ParentNode, label: string, value: string) {
	await act(async () => {
		const input = field(root, label);
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function choose(root: ParentNode, label: string, value: string) {
	await click(root, label);
	await act(async () => {
		const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
			(node) => node.textContent?.trim() === value,
		);
		if (!option) throw new Error(`Missing option: ${value}`);
		option.click();
	});
}
async function mount(settings = view(), updateModelSettings = vi.fn<PanelApi["updateModelSettings"]>()) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onDirtyChange = vi.fn();
	const onBusyChange = vi.fn();
	const onSaved = vi.fn();
	function Harness() {
		const [current, setCurrent] = useState(settings);
		const [open, setOpen] = useState(false);
		return (
			<ImageGenerationSettingsPanel
				api={{ updateModelSettings }}
				busy={false}
				onBusyChange={onBusyChange}
				onDirtyChange={onDirtyChange}
				onOpenChange={setOpen}
				onRequestClose={() => setOpen(false)}
				onSaved={(next) => {
					onSaved(next);
					setCurrent(next);
				}}
				open={open}
				serverReady
				settings={current}
			/>
		);
	}
	await act(async () => root.render(<Harness />));
	return { container, updateModelSettings, onDirtyChange, onBusyChange, onSaved };
}
async function populate(container: ParentNode) {
	await fill(container, "Name", "  Studio  ");
	await fill(container, "Model ID", " image-model ");
	await fill(container, "API key", " fixture-key ");
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

describe("image generation model settings", () => {
	it("opens the compact card, focuses the form and validates without losing the draft", async () => {
		const { container, updateModelSettings, onDirtyChange } = await mount();
		expect(container.querySelector(".image-generation-settings-card")?.tagName).toBe("BUTTON");
		expect(container.textContent).toContain("No image generation model configured");
		expect(container.querySelector("input")).toBeNull();
		await click(container, "Image generation model");
		expect(document.activeElement).toBe(field(container, "Name"));
		await fill(container, "Name", "Draft");
		await click(container, "Save image model");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Fill in the name");
		expect(field(container, "Name").value).toBe("Draft");
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		expect(updateModelSettings).not.toHaveBeenCalled();
	});
	it("saves a dedicated connection, trims fields and clears the secret draft", async () => {
		const { container, updateModelSettings, onSaved } = await mount(
			view(),
			vi.fn<PanelApi["updateModelSettings"]>().mockResolvedValue(view(true)),
		);
		await click(container, "Image generation model");
		await populate(container);
		await click(container, "Save image model");
		expect(updateModelSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				mutation: {
					type: "set_image_generation",
					config: { ...config, baseUrl: "https://api.openai.com/v1" },
					credential: { action: "set", value: "fixture-key" },
				},
			}),
		);
		expect(onSaved).toHaveBeenCalledWith(view(true));
		expect(container.querySelector("dialog")).toBeNull();
		await click(container, "Image generation model");
		expect(field(container, "API key").value).toBe("");
		expect(field(container, "API key").type).toBe("password");
	});
	it("keeps an existing dedicated API key while editing metadata", async () => {
		const { container, updateModelSettings } = await mount(
			view(true),
			vi.fn<PanelApi["updateModelSettings"]>().mockResolvedValue(view(true)),
		);
		await click(container, "Image generation model");
		await fill(container, "Name", "Renamed");
		await click(container, "Save image model");
		expect(updateModelSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				mutation: {
					type: "set_image_generation",
					config: { ...config, name: "Renamed" },
					credential: { action: "keep" },
				},
			}),
		);
	});
	it("reuses only explicitly stored API keys and removes only the old dedicated credential", async () => {
		const { container, updateModelSettings } = await mount(
			view(true),
			vi.fn<PanelApi["updateModelSettings"]>().mockResolvedValue(view(true)),
		);
		await click(container, "Image generation model");
		await click(container, "API key source");
		expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain("OAuth Provider");
		await act(async () =>
			[...document.querySelectorAll<HTMLElement>('[role="option"]')]
				.find((node) => node.textContent === "Stored Provider")!
				.click(),
		);
		expect(container.querySelector('input[type="password"]')).toBeNull();
		await click(container, "Save image model");
		expect(updateModelSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				mutation: {
					type: "set_image_generation",
					config: { ...config, credentialProvider: "stored" },
					credential: { action: "remove" },
				},
			}),
		);
	});
	it("rejects invalid addresses and missing credentials before making a request", async () => {
		const { container, updateModelSettings } = await mount();
		await click(container, "Image generation model");
		await fill(container, "Name", "Studio");
		await fill(container, "Model ID", "image-model");
		await fill(container, "Base URL", "https://images.example/v1?key=secret");
		await click(container, "Save image model");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("without credentials, query parameters");
		await fill(container, "Base URL", "https://images.example/v1");
		await click(container, "Save image model");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter an API key for image generation");
		expect(updateModelSettings).not.toHaveBeenCalled();
	});
	it("switches stock API addresses without replacing a custom endpoint or entered model", async () => {
		const { container } = await mount();
		await click(container, "Image generation model");
		await fill(container, "Model ID", "custom-model");
		await choose(container, "API format", "Google Interactions");
		expect(field(container, "Base URL").value).toBe("https://generativelanguage.googleapis.com/v1beta");
		await choose(container, "API format", "OpenRouter Images");
		expect(field(container, "Base URL").value).toBe("https://openrouter.ai/api/v1");
		await fill(container, "Base URL", "https://proxy.example/v1");
		await choose(container, "API format", "OpenAI Images");
		expect(field(container, "Base URL").value).toBe("https://proxy.example/v1");
		expect(field(container, "Model ID").value).toBe("custom-model");
	});
	it("saves an OpenRouter profile with the dedicated image credential", async () => {
		const routerConfig = {
			...config,
			api: "openrouter-images" as const,
			baseUrl: "https://openrouter.ai/api/v1",
			modelId: "google/gemini-3.1-flash-image",
		};
		const next: ModelSettingsView = {
			...view(true),
			imageGeneration: { config: routerConfig, status: "configured", authConfigured: true },
		};
		const { container, updateModelSettings } = await mount(
			view(),
			vi.fn<PanelApi["updateModelSettings"]>().mockResolvedValue(next),
		);
		await click(container, "Image generation model");
		await populate(container);
		await choose(container, "API format", "OpenRouter Images");
		await fill(container, "Model ID", routerConfig.modelId);
		await click(container, "Save image model");
		expect(updateModelSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				mutation: {
					type: "set_image_generation",
					config: routerConfig,
					credential: { action: "set", value: "fixture-key" },
				},
			}),
		);
		expect(container.textContent).toContain("OpenRouter Images");
		await click(container, "Image generation model");
		expect(field(container, "Base URL").value).toBe(routerConfig.baseUrl);
		expect(field(container, "Model ID").value).toBe(routerConfig.modelId);
		expect(field(container, "API key").value).toBe("");
	});
	it("retains inputs on a server failure and disables duplicate requests while saving", async () => {
		let reject!: (cause: Error) => void;
		const pending = new Promise<ModelSettingsView>((_, fail) => {
			reject = fail;
		});
		const { container, updateModelSettings, onBusyChange } = await mount(
			view(),
			vi.fn<PanelApi["updateModelSettings"]>().mockReturnValue(pending),
		);
		await click(container, "Image generation model");
		await populate(container);
		await click(container, "Save image model");
		expect(button(container, "Saving…").disabled).toBe(true);
		expect(button(container, "Close").disabled).toBe(true);
		expect(onBusyChange).toHaveBeenLastCalledWith(true);
		await act(async () => reject(new Error("Connection settings could not be saved")));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Connection settings could not be saved",
		);
		expect(field(container, "Name").value).toBe("  Studio  ");
		expect(field(container, "API key").value).toBe(" fixture-key ");
		expect(updateModelSettings).toHaveBeenCalledTimes(1);
		expect(onBusyChange).toHaveBeenLastCalledWith(false);
	});
	it("requires a confirmation to remove the configuration while keeping image history", async () => {
		const { container, updateModelSettings } = await mount(
			view(true),
			vi.fn<PanelApi["updateModelSettings"]>().mockResolvedValue(view()),
		);
		await click(container, "Image generation model");
		await click(container, "Remove");
		expect(updateModelSettings).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Existing images will be kept");
		await click(container, "Confirm removal");
		expect(updateModelSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				mutation: { type: "set_image_generation", config: null, credential: { action: "remove" } },
			}),
		);
		expect(container.textContent).toContain("No image generation model configured");
	});
	it("does not reopen a route-targeted form after a successful save", async () => {
		const settings = view();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const api = {
			getModelSettings: vi.fn().mockResolvedValue(settings),
			updateModelSettings: vi.fn().mockResolvedValue(view(true)),
			testModelConnection: vi.fn(),
			discoverModels: vi.fn(),
		};
		await act(async () =>
			root.render(<ModelSettingsPanel api={api} focusImageGeneration initialSettings={settings} serverReady />),
		);
		await populate(container);
		await click(container, "Save image model");
		expect(container.querySelector('dialog[aria-label="Image generation model"]')).toBeNull();
		expect(container.querySelector(".image-generation-settings-card")?.textContent).toContain("Studio");
	});
	it("opens from the settings route and uses the existing unsaved changes confirmation", async () => {
		const settings = view();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const api = {
			getModelSettings: vi.fn().mockResolvedValue(settings),
			updateModelSettings: vi.fn(),
			testModelConnection: vi.fn(),
			discoverModels: vi.fn(),
		};
		await act(async () =>
			root.render(<ModelSettingsPanel api={api} focusImageGeneration initialSettings={settings} serverReady />),
		);
		expect(container.querySelector('dialog[aria-label="Image generation model"]')).not.toBeNull();
		await fill(container, "Name", "Unsaved artwork model");
		await click(container.querySelector('dialog[aria-label="Image generation model"]')!, "Cancel");
		expect(container.textContent).toContain("Unsaved changes");
		expect(field(container, "Name").value).toBe("Unsaved artwork model");
		await click(container, "Keep editing");
		expect(field(container, "Name").value).toBe("Unsaved artwork model");
	});
});
