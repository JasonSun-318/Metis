// @vitest-environment jsdom

import type { ModelSettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { SettingsDialog } from "../src/renderer/components/SettingsDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const roots: Root[] = [];
function settings(): ModelSettingsView {
	return {
		defaultModel: { provider: "openai", modelId: "gpt-5" },
		defaultThinkingSelection: "high",
		vision: null,
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
function field(root: ParentNode, label: string): HTMLInputElement {
	const result = Array.from(root.querySelectorAll("label"))
		.find((candidate) => candidate.querySelector("span")?.textContent === label)
		?.querySelector("input");
	if (!result) throw new Error(`Missing field: ${label}`);
	return result;
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
async function pressEscape() {
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
	);
}
async function mount(fullSettings = false) {
	const view = settings();
	const api = {
		platform: "darwin",
		getModelSettings: vi.fn().mockResolvedValue(view),
		getProfile: vi.fn().mockResolvedValue(null),
		updateModelSettings: vi.fn().mockResolvedValue(view),
		testModelConnection: vi.fn(),
		discoverModels: vi.fn(),
	};
	const onDirtyChange = vi.fn(),
		onClose = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(
			fullSettings ? (
				<SettingsDialog
					api={api as unknown as MetisDesktopApi}
					closeDelayMs={0}
					generalPreferences={{
						motion: "system",
						chatFont: "anthropic-serif",
						codeFont: "system-sans",
						contentFontSize: "15px",
					}}
					onClose={onClose}
					onGeneralPreferencesChange={() => undefined}
					onThemeChange={() => undefined}
					serverReady
					theme="dark"
				/>
			) : (
				<ModelSettingsPanel api={api} onDirtyChange={onDirtyChange} serverReady />
			),
		),
	);
	if (fullSettings) await click(container, "Model");
	return { container, api, view, onDirtyChange, onClose };
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

describe("model editor unsaved changes", () => {
	it("does not close settings for an Escape consumed by a nested control", async () => {
		const { container, onClose } = await mount(true);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		event.preventDefault();
		await act(async () => container.querySelector('[role="dialog"]')!.dispatchEvent(event));
		expect(onClose).not.toHaveBeenCalled();
		await pressEscape();
		expect(onClose).toHaveBeenCalledOnce();
	});
	it("focuses the first field and returns to the model editor trigger", async () => {
		const { container } = await mount();
		const trigger = button(container, "Add custom provider");
		trigger.focus();
		await click(container, "Add custom provider");
		expect(document.activeElement).toBe(field(container, "Provider name"));
		const save = button(container, "Save provider");
		save.focus();
		await act(async () =>
			save.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })),
		);
		expect(document.activeElement).toBe(button(container, "Close provider settings"));
		await pressEscape();
		expect(document.activeElement).toBe(trigger);
	});
	it("clears built-in credential dirty state after a successful save", async () => {
		const { container, onDirtyChange } = await mount();
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await fill(container, "API key", "fake-test-key");
		await click(container, "Save API key");
		expect(field(container, "API key").value).toBe("");
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
		await pressEscape();
		expect(container.querySelector(".model-provider-dialog")).toBeNull();
		expect(container.querySelector(".settings-unsaved-dialog")).toBeNull();
	});

	it("clears saved default selections without a false discard prompt", async () => {
		const { container, api, view, onDirtyChange } = await mount();
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await click(container, "Default reasoning");
		await act(async () => {
			Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
				.find((option) => option.textContent === "Low")!
				.click();
		});
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		api.updateModelSettings.mockResolvedValue({ ...view, defaultThinkingSelection: "low" });
		await click(container, "Set as default for new tasks");
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
		await pressEscape();
		expect(container.querySelector(".model-provider-dialog")).toBeNull();
		expect(container.querySelector(".settings-unsaved-dialog")).toBeNull();
	});

	it("closes an untouched new provider without a discard prompt", async () => {
		const { container, onDirtyChange } = await mount();
		await click(container, "Add custom provider");
		await pressEscape();
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();
		expect(container.querySelector(".settings-unsaved-dialog")).toBeNull();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("keeps an edited draft on Escape, supports continuing, and discards only explicitly", async () => {
		const { container, api, onDirtyChange } = await mount();
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "My unchanged work");
		await fill(container, "Base URL", "https://example.test/v1");
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		await pressEscape();
		expect(container.querySelector(".settings-unsaved-dialog")?.hasAttribute("open")).toBe(true);
		await click(container, "Keep editing");
		expect(field(container, "Provider name").value).toBe("My unchanged work");
		expect(field(container, "Base URL").value).toBe("https://example.test/v1");
		await click(container, "Close provider settings");
		await click(container, "Discard changes");
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();
		expect(api.updateModelSettings).not.toHaveBeenCalled();
		await click(container, "Add custom provider");
		expect(field(container, "Provider name").value).toBe("");
	});

	it("protects backdrop and native cancel exits, and cancelling the prompt keeps the editor", async () => {
		const { container } = await mount();
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "Backdrop draft");
		await act(async () => container.querySelector<HTMLDialogElement>(".model-custom-provider-dialog")!.click());
		const prompt = container.querySelector<HTMLDialogElement>(".settings-unsaved-dialog")!;
		await act(async () => prompt.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(field(container, "Provider name").value).toBe("Backdrop draft");
		expect(container.querySelector(".settings-unsaved-dialog")).toBeNull();
		await act(async () =>
			container
				.querySelector(".model-custom-provider-dialog")!
				.dispatchEvent(new Event("cancel", { cancelable: true })),
		);
		expect(container.querySelector(".settings-unsaved-dialog")).not.toBeNull();
	});

	it("protects built-in credentials and the optional vision form", async () => {
		const { container } = await mount();
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await fill(container, "API key", "fake-test-key");
		await pressEscape();
		await click(container, "Keep editing");
		expect(field(container, "API key").value).toBe("fake-test-key");
		await pressEscape();
		await click(container, "Discard changes");
		await click(container, "Configure");
		await fill(container, "Name", "Vision draft");
		await click(container.querySelector(".model-service-dialog")!, "Cancel");
		expect(container.querySelector(".settings-unsaved-dialog")).not.toBeNull();
		await click(container, "Keep editing");
		expect(field(container, "Name").value).toBe("Vision draft");
	});

	it("retains all input on save failure and continues to protect the draft", async () => {
		const { container, api } = await mount();
		api.updateModelSettings.mockRejectedValue(new Error("offline"));
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "Failed save");
		await fill(container, "Base URL", "https://example.test/v1");
		await fill(container, "API key", "fake-test-key");
		await fill(container, "Model ID", "model-1");
		await click(container, "Save provider");
		expect(container.textContent).toContain("offline");
		await pressEscape();
		await click(container, "Keep editing");
		for (const [label, value] of [
			["Provider name", "Failed save"],
			["Base URL", "https://example.test/v1"],
			["API key", "fake-test-key"],
			["Model ID", "model-1"],
		]) {
			expect(field(container, label!).value).toBe(value);
		}
	});

	it("blocks closing while a save is pending and resets dirty state after success", async () => {
		const { container, api, view, onDirtyChange } = await mount();
		let finish!: (value: ModelSettingsView) => void;
		api.updateModelSettings.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "Pending save");
		await fill(container, "Base URL", "https://example.test/v1");
		await fill(container, "API key", "fake-test-key");
		await fill(container, "Model ID", "model-1");
		await click(container, "Save provider");
		await pressEscape();
		await click(container, "Close provider settings");
		expect(container.querySelector(".model-custom-provider-dialog")).not.toBeNull();
		expect(container.querySelector(".settings-unsaved-dialog")).toBeNull();
		await act(async () => finish(view));
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("does not replace a dirty provider when another provider is selected", async () => {
		const { container } = await mount();
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "Before switch");
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		expect(field(container, "Provider name").value).toBe("Before switch");
		await click(container, "Keep editing");
		expect(field(container, "Provider name").value).toBe("Before switch");
		await act(async () => container.querySelector<HTMLButtonElement>(".model-provider-card")!.click());
		await click(container, "Discard changes");
		expect(container.querySelector(".model-custom-provider-dialog")).toBeNull();
		expect(container.querySelector(".model-provider-dialog")?.textContent).toContain("OpenAI");
	});

	it.each(["General", "Back to app"])("reports dirty edits to settings navigation: %s", async (destination) => {
		const { container, onClose } = await mount(true);
		await click(container, "Add custom provider");
		await fill(container, "Provider name", "Navigation draft");
		await click(container, destination);
		expect(container.querySelector(".settings-unsaved-dialog")).not.toBeNull();
		await click(container, "Keep editing");
		expect(field(container, "Provider name").value).toBe("Navigation draft");
		expect(onClose).not.toHaveBeenCalled();
	});
});
