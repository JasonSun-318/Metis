// @vitest-environment jsdom

import type { ModelSettingsProviderView, ModelSettingsView, PermissionReviewerConfigView } from "@metis/app-protocol";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerModelSettingsPanel } from "../src/renderer/components/ReviewerModelSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type ReviewerSettingsView = ModelSettingsView;
type ReviewerApi = Parameters<typeof ReviewerModelSettingsPanel>[0]["api"];

const roots: Root[] = [];

function provider(id: string, name: string): ModelSettingsProviderView {
	return {
		provider: id,
		name,
		builtin: false,
		api: "openai-completions" as const,
		baseUrl: "https://models.example.invalid/v1",
		auth: { configured: true, source: "stored" as const },
		models: [
			{
				provider: id,
				modelId: "review-model",
				name: "Review Model",
				contextWindow: 128000,
				maxOutputTokens: 4096,
				reasoning: true,
				thinkingLevels: ["off", "low", "high"] as const,
				reasoningMode: null,
				reasoningSource: null,
				imageInput: false,
				custom: false,
			},
			{
				provider: id,
				modelId: "deep-model",
				name: "Deep Model",
				contextWindow: 128000,
				maxOutputTokens: 1000,
				reasoning: true,
				thinkingLevels: ["low", "medium", "high"] as const,
				reasoningMode: null,
				reasoningSource: null,
				imageInput: false,
				custom: false,
			},
			{
				provider: id,
				modelId: "tiny-model",
				name: "Tiny Model",
				contextWindow: 128000,
				maxOutputTokens: 100,
				reasoning: true,
				thinkingLevels: ["off", "low"] as const,
				reasoningMode: null,
				reasoningSource: null,
				imageInput: false,
				custom: false,
			},
		],
	};
}

function view(reviewer?: ReviewerSettingsView["permissionReviewer"]): ReviewerSettingsView {
	return {
		defaultModel: { provider: "review-provider", modelId: "review-model" },
		defaultThinkingSelection: "high",
		vision: null,
		loadError: null,
		providers: [provider("review-provider", "Review Provider"), provider("other-provider", "Other Provider")],
		permissionReviewer: reviewer ?? { config: null, status: "unconfigured" },
	};
}

function configured(config: PermissionReviewerConfigView, authConfigured?: boolean): ReviewerSettingsView {
	return view({ config, status: "configured", ...(authConfigured === undefined ? {} : { authConfigured }) });
}

const savedProfile: PermissionReviewerConfigView = {
	provider: "review-provider",
	modelId: "review-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
};

const dedicatedConfig: PermissionReviewerConfigView = {
	source: "dedicated",
	name: "My reviewer",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9/v1",
	modelId: "reviewer-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
	reasoningMode: "off",
};

function button(root: ParentNode, label: string): HTMLButtonElement {
	const result = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

function maybeButton(root: ParentNode, label: string): HTMLButtonElement | undefined {
	return Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
}

function field(root: ParentNode, label: string): HTMLInputElement {
	const result = Array.from(root.querySelectorAll("label"))
		.find((candidate) => candidate.querySelector("span")?.textContent === label)
		?.querySelector("input");
	if (!result) throw new Error(`Missing field: ${label}`);
	return result;
}

async function fill(root: ParentNode, label: string, value: string) {
	await act(async () => {
		const input = field(root, label);
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function fillByAria(root: ParentNode, label: string, value: string) {
	await act(async () => {
		const input = root.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
		if (!input) throw new Error(`Missing input: ${label}`);
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function click(root: ParentNode, label: string) {
	await act(async () => button(root, label).click());
}

async function clickMaybe(root: ParentNode, label: string) {
	const target = maybeButton(root, label);
	if (target) await act(async () => target.click());
}

async function choose(root: ParentNode, label: string, option: string) {
	await click(root, label);
	await act(async () => {
		const matches = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
		const target = matches.find((candidate) => candidate.textContent?.trim() === option);
		if (!target) throw new Error(`Missing option: ${option}`);
		target.click();
	});
}

async function submitForm(root: ParentNode) {
	await act(async () => {
		root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

async function mount(
	settings: ReviewerSettingsView = view(),
	overrides: {
		readonly updateModelSettings?: ReturnType<typeof vi.fn>;
		readonly testModelConnection?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const updateModelSettings = overrides.updateModelSettings ?? vi.fn();
	const testModelConnection = overrides.testModelConnection ?? vi.fn();
	const api = {
		getModelSettings: vi.fn().mockResolvedValue(settings),
		updateModelSettings,
		testModelConnection,
		discoverModels: vi.fn(),
	} as unknown as ReviewerApi;
	const onSaved = vi.fn();
	const onDirtyChange = vi.fn();
	const onRequestClose = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	function Harness() {
		const [current, setCurrent] = useState(settings);
		const [reset, setReset] = useState(0);
		return (
			<ReviewerModelSettingsPanel
				api={api}
				busy={false}
				key={reset}
				onDirtyChange={onDirtyChange}
				onRequestClose={() => {
					onRequestClose();
					// 模拟父组件的 discardEditor：真正丢弃草稿并重新挂载面板。
					setReset((value) => value + 1);
				}}
				onSaved={(next) => {
					onSaved(next);
					setCurrent(next);
				}}
				serverReady
				settings={current}
			/>
		);
	}
	await act(async () => root.render(<Harness />));
	return {
		container,
		api,
		updateModelSettings,
		testModelConnection,
		onSaved,
		onDirtyChange,
		onRequestClose,
	};
}

async function openEditor(container: ParentNode) {
	await clickMaybe(container, "Configure");
	if (!maybeButton(container, "Save approval model")) await click(container, "Edit");
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

describe("independent approval model settings", () => {
	it("shows a compact status card without an Auto enable control or inline fields", async () => {
		const { container, onDirtyChange } = await mount();

		expect(container.querySelector(".reviewer-model-section")?.textContent).toContain("Approval model");
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("No approval model configured");
		expect(container.querySelector(".reviewer-model-section input")).toBeNull();
		expect(container.querySelector(".reviewer-model-section input[role='switch']")).toBeNull();
		expect(container.textContent).not.toMatch(/enable auto/i);
		expect(button(container, "Configure")).toBeTruthy();
		expect(container.querySelector("dialog")?.open).toBeFalsy();
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("saves exactly the five-field provider profile and returns to the card", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(savedProfile));
		const { container, onSaved, onDirtyChange } = await mount(view(), { updateModelSettings });

		await openEditor(container);
		expect(container.querySelector("dialog")?.getAttribute("aria-label")).toBe("Approval model");
		expect(field(container, "Timeout (ms)").value).toBe("8000");
		expect(field(container, "Max output tokens").value).toBe("512");
		const advanced = container.querySelector<HTMLDetailsElement>(".reviewer-model-advanced");
		expect(advanced?.open).toBe(false);

		await click(container, "Save approval model");

		expect(updateModelSettings).toHaveBeenCalledTimes(1);
		expect(updateModelSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			mutation: {
				type: "set_permission_reviewer",
				config: {
					provider: "review-provider",
					modelId: "review-model",
					thinkingLevel: "off",
					timeoutMs: 8000,
					maxOutputTokens: 512,
				},
			},
		});
		expect(updateModelSettings.mock.calls[0]![0].mutation).not.toHaveProperty("model");
		expect(updateModelSettings.mock.calls[0]![0].mutation).not.toHaveProperty("thinkingSelection");
		expect(onSaved).toHaveBeenCalledWith(configured(savedProfile));
		expect(container.querySelector("dialog")).toBeNull();
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("Approval model configured");
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("Review Model");
		expect(container.textContent).toContain("Approval model saved");
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it("reopens from the saved provider values and offers only the selected model's levels", async () => {
		const saved: PermissionReviewerConfigView = {
			...savedProfile,
			modelId: "deep-model",
			thinkingLevel: "medium",
			maxOutputTokens: 1000,
		};
		const updateModelSettings = vi.fn().mockResolvedValue(configured(saved));
		const { container, onDirtyChange } = await mount(configured(saved), { updateModelSettings });

		await openEditor(container);
		expect(button(container, "Approval model").textContent).toContain("Deep Model");
		expect(button(container, "Approval reasoning").textContent).toContain("Medium");
		expect(field(container, "Max output tokens").value).toBe("1000");

		await choose(container, "Approval reasoning", "High");
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		await click(container, "Approval reasoning");
		const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((option) =>
			option.textContent?.trim(),
		);
		expect(options).toEqual(["Low", "Medium", "High"]);
		await click(container, "Approval reasoning");

		await click(container, "Save approval model");
		expect(updateModelSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			mutation: {
				type: "set_permission_reviewer",
				config: {
					provider: "review-provider",
					modelId: "deep-model",
					thinkingLevel: "high",
					timeoutMs: 8000,
					maxOutputTokens: 1000,
				},
			},
		});
	});

	it("saves a dedicated connection with the credential outside the config", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(dedicatedConfig, true));
		const { container, onSaved } = await mount(view(), { updateModelSettings });

		await openEditor(container);
		await choose(container, "Connection type", "Dedicated connection");
		await fill(container, "Name", "My reviewer");
		await fill(container, "Base URL", "http://127.0.0.1:9/v1");
		await fill(container, "Model ID", "reviewer-model");
		await fill(container, "API key", "dedicated-secret");
		await click(container, "Save approval model");

		const mutation = updateModelSettings.mock.calls[0]![0].mutation;
		expect(mutation).toEqual({
			type: "set_permission_reviewer",
			config: {
				source: "dedicated",
				name: "My reviewer",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9/v1",
				modelId: "reviewer-model",
				thinkingLevel: "off",
				timeoutMs: 8000,
				maxOutputTokens: 512,
				reasoningMode: "off",
			},
			credential: { action: "set", value: "dedicated-secret" },
		});
		expect(mutation.config).not.toHaveProperty("provider");
		expect(mutation.config).not.toHaveProperty("apiKey");
		expect(mutation.config).not.toHaveProperty("authConfigured");
		expect(JSON.stringify(mutation.config)).not.toContain("dedicated-secret");
		expect(onSaved).toHaveBeenCalledWith(configured(dedicatedConfig, true));
		expect(container.querySelector("dialog")).toBeNull();
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("My reviewer");
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("reviewer-model");
		expect(container.textContent).not.toContain("dedicated-secret");
	});

	it("keeps an existing dedicated key when the field is left blank", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(dedicatedConfig, true));
		const { container } = await mount(configured(dedicatedConfig, true), { updateModelSettings });

		await openEditor(container);
		expect(button(container, "Connection type").textContent).toContain("Dedicated connection");
		expect(field(container, "API key").value).toBe("");
		expect(container.querySelector(".model-saved-credential")?.textContent).toContain("Saved API key");
		await click(container, "Save approval model");

		expect(updateModelSettings.mock.calls[0]![0].mutation).toEqual({
			type: "set_permission_reviewer",
			config: dedicatedConfig,
			credential: { action: "keep" },
		});
	});

	it("requires a key for a new dedicated connection and for a saved one whose key is missing", async () => {
		const updateModelSettings = vi.fn();
		const first = await mount(view(), { updateModelSettings });
		await openEditor(first.container);
		await choose(first.container, "Connection type", "Dedicated connection");
		await fill(first.container, "Name", "My reviewer");
		await fill(first.container, "Base URL", "http://127.0.0.1:9/v1");
		await fill(first.container, "Model ID", "reviewer-model");
		await click(first.container, "Save approval model");
		expect(first.container.querySelector('[role="alert"]')?.textContent).toContain(
			"Enter an API key to save the dedicated approval model.",
		);
		expect(updateModelSettings).not.toHaveBeenCalled();

		const missingKey = view({ config: dedicatedConfig, status: "invalid", authConfigured: false });
		const second = await mount(missingKey, { updateModelSettings });
		expect(second.container.querySelector(".reviewer-model-status")?.textContent).toContain("missing its API key");
		await openEditor(second.container);
		expect(button(second.container, "Test approval model").disabled).toBe(true);
		await click(second.container, "Save approval model");
		expect(second.container.querySelector('[role="alert"]')?.textContent).toContain(
			"Enter an API key to save the dedicated approval model.",
		);
		expect(updateModelSettings).not.toHaveBeenCalled();
	});

	it("maps dedicated reasoning levels with the existing off/manual editor and keeps saved selections", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(dedicatedConfig, true));
		const { container } = await mount(view(), { updateModelSettings });

		await openEditor(container);
		await choose(container, "Connection type", "Dedicated connection");
		await fill(container, "Name", "My reviewer");
		await fill(container, "Base URL", "http://127.0.0.1:9/v1");
		await fill(container, "Model ID", "reviewer-model");
		await fill(container, "API key", "dedicated-secret");

		const toggle = container.querySelector<HTMLInputElement>(".model-reasoning-editor input[role='switch']")!;
		expect(toggle.checked).toBe(false);
		await act(async () => toggle.click());
		expect(button(container, "Approval reasoning").textContent).toContain("Low");
		await click(container, "Save approval model");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Enter the API value for every reasoning level.",
		);
		expect(updateModelSettings).not.toHaveBeenCalled();
		await fillByAria(container, "API value 1", "enabled");
		await click(container, "Save approval model");

		expect(updateModelSettings.mock.calls[0]![0].mutation.config).toMatchObject({
			source: "dedicated",
			reasoningMode: "manual",
			thinkingLevel: "low",
			thinkingLevelMap: { low: "enabled" },
		});

		const savedManual: PermissionReviewerConfigView = {
			...dedicatedConfig,
			reasoningMode: "manual",
			thinkingLevel: "high",
			thinkingLevelMap: { low: "vendor-low", high: "vendor-high" },
		};
		const reopened = await mount(configured(savedManual, true), {
			updateModelSettings: vi.fn().mockResolvedValue(configured(savedManual, true)),
		});
		await openEditor(reopened.container);
		expect(button(reopened.container, "Approval reasoning").textContent).toContain("High");
		await click(reopened.container, "Approval reasoning");
		expect(
			Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((option) =>
				option.textContent?.trim(),
			),
		).toEqual(["Low", "High"]);
	});

	it("tests only the saved profile when the draft is unchanged and never sends a credential", async () => {
		const testModelConnection = vi
			.fn()
			.mockResolvedValue({ ok: true, message: "OK", latencyMs: 123, thinkingLevel: "off", outputTokens: 17 });
		const configuredView = configured(savedProfile);
		const { container } = await mount(configuredView, { testModelConnection });

		await openEditor(container);
		expect(button(container, "Test approval model").disabled).toBe(false);
		await click(container, "Test approval model");

		expect(testModelConnection).toHaveBeenCalledTimes(1);
		expect(testModelConnection).toHaveBeenCalledWith({
			requestId: expect.any(String),
			kind: "permission-review",
		});
		const notice = container.querySelector<HTMLElement>(".system-notice-stack.is-global .system-notice");
		expect(notice?.textContent).toContain("123 ms");
		expect(notice?.textContent).not.toMatch(/thinking|reasoning level/i);

		await choose(container, "Approval reasoning", "Low");
		expect(button(container, "Test approval model").disabled).toBe(true);
		await clickMaybe(container, "Test approval model");
		expect(testModelConnection).toHaveBeenCalledTimes(1);
	});

	it("keeps the dialog open while a saved-profile test is pending", async () => {
		let finish!: (result: { ok: boolean; message: string; latencyMs: number }) => void;
		const testModelConnection = vi.fn(
			() =>
				new Promise<{ ok: boolean; message: string; latencyMs: number }>((resolve) => {
					finish = resolve;
				}),
		);
		const { container, onRequestClose } = await mount(configured(savedProfile), { testModelConnection });
		await openEditor(container);
		await click(container, "Test approval model");
		const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
		await act(async () => {
			dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
			dialog.click();
		});
		expect(onRequestClose).not.toHaveBeenCalled();
		expect(container.querySelector("dialog")).not.toBeNull();
		await act(async () => finish({ ok: true, message: "Passed", latencyMs: 1 }));
		await click(container, "Cancel");
		expect(onRequestClose).toHaveBeenCalledOnce();
	});

	it("reports test failures without exposing a credential", async () => {
		const testModelConnection = vi
			.fn()
			.mockResolvedValue({ ok: false, message: "Sample denied", latencyMs: 88, thinkingLevel: "off" });
		const { container } = await mount(configured(savedProfile), { testModelConnection });

		await openEditor(container);
		await click(container, "Test approval model");

		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("Approval model test failed");
		expect(alert?.textContent).toContain("Sample denied");
		const exportText = container.textContent ?? "";
		expect(exportText).not.toContain("reviewer-key");
	});

	it("keeps the draft and reports errors when saving fails", async () => {
		const updateModelSettings = vi.fn().mockRejectedValue(new Error("offline"));
		const { container, onSaved, onDirtyChange } = await mount(view(), { updateModelSettings });
		await openEditor(container);
		await choose(container, "Approval reasoning", "Low");

		await click(container, "Save approval model");

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("offline");
		expect(onSaved).not.toHaveBeenCalled();
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);
		expect(button(container, "Approval reasoning").textContent).toContain("Low");
		expect(container.querySelector("dialog")).not.toBeNull();
	});

	it("discards the draft on cancel, Escape, and backdrop, reopening from saved values", async () => {
		const updateModelSettings = vi.fn();
		const { container, onRequestClose } = await mount(configured(savedProfile), { updateModelSettings });

		for (const dismiss of ["cancel", "escape", "backdrop"] as const) {
			await openEditor(container);
			await choose(container, "Approval reasoning", "Low");
			if (dismiss === "cancel") await click(container, "Cancel");
			else if (dismiss === "escape")
				await act(async () => {
					container
						.querySelector("dialog")!
						.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
				});
			else
				await act(async () => {
					container.querySelector("dialog")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
				});
			expect(onRequestClose).toHaveBeenCalledTimes(["cancel", "escape", "backdrop"].indexOf(dismiss) + 1);
			expect(container.querySelector("dialog")).toBeNull();
		}

		expect(updateModelSettings).not.toHaveBeenCalled();
		await openEditor(container);
		expect(button(container, "Approval reasoning").textContent).toContain("Off");
	});

	it("validates dedicated URLs and budget boundaries before saving", async () => {
		const updateModelSettings = vi.fn();
		const { container } = await mount(view(), { updateModelSettings });
		await openEditor(container);
		await choose(container, "Connection type", "Dedicated connection");
		await fill(container, "Name", "My reviewer");
		await fill(container, "Base URL", "ftp://example.test/v1");
		await fill(container, "Model ID", "reviewer-model");
		await fill(container, "API key", "dedicated-secret");
		await click(container, "Save approval model");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter a valid https:// or http:// URL");

		await fill(container, "Base URL", "http://127.0.0.1:9/v1");
		await fill(container, "Timeout (ms)", "999");
		await submitForm(container);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Timeout must be between 1000 and 15000 ms.",
		);

		await fill(container, "Timeout (ms)", "8000");
		await fill(container, "Max output tokens", "127");
		await submitForm(container);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Output token limit must be between 128 and 8192.",
		);

		await fill(container, "Max output tokens", "8193");
		await submitForm(container);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Output token limit must be between 128 and 8192.",
		);
		expect(updateModelSettings).not.toHaveBeenCalled();
	});

	it("blocks saving and testing a provider model below the reviewer output minimum", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(savedProfile));
		const testModelConnection = vi.fn();
		const { container } = await mount(view(), { updateModelSettings, testModelConnection });

		await openEditor(container);
		await choose(container, "Approval model", "Tiny Model");

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("below 128 tokens");
		expect(field(container, "Max output tokens").value).toBe("100");
		expect(button(container, "Save approval model").disabled).toBe(true);
		expect(button(container, "Test approval model").disabled).toBe(true);
		await clickMaybe(container, "Save approval model");
		await clickMaybe(container, "Test approval model");
		expect(updateModelSettings).not.toHaveBeenCalled();
		expect(testModelConnection).not.toHaveBeenCalled();
	});

	it("does not add or edit shared providers from the reviewer settings", async () => {
		const updateModelSettings = vi.fn().mockResolvedValue(configured(savedProfile));
		const { container } = await mount(view(), { updateModelSettings });

		expect(maybeButton(container, "Add provider")).toBeUndefined();
		expect(maybeButton(container, "Edit provider")).toBeUndefined();
		await openEditor(container);
		expect(maybeButton(container, "Add provider")).toBeUndefined();
		expect(maybeButton(container, "Edit provider")).toBeUndefined();
		await click(container, "Save approval model");
		expect(updateModelSettings).toHaveBeenCalledTimes(1);
		expect(updateModelSettings.mock.calls[0]![0].mutation.type).toBe("set_permission_reviewer");
	});

	it("clears the saved configuration and removes only the dedicated key", async () => {
		const cleared = view({ config: null, status: "unconfigured" });
		const updateModelSettings = vi.fn().mockResolvedValue(cleared);
		const { container, onSaved } = await mount(configured(dedicatedConfig, true), { updateModelSettings });

		await openEditor(container);
		await click(container, "Remove approval model");
		await click(container, "Confirm remove approval model");

		expect(updateModelSettings).toHaveBeenCalledWith({
			requestId: expect.any(String),
			mutation: {
				type: "set_permission_reviewer",
				config: null,
				credential: { action: "remove" },
			},
		});
		expect(onSaved).toHaveBeenCalledWith(cleared);
		expect(container.querySelector("dialog")).toBeNull();
		expect(container.textContent).toContain("Approval model removed");
		expect(container.querySelector(".reviewer-model-status")?.textContent).toContain("No approval model configured");
	});

	it("shows an invalid saved configuration without reviving it as configured", async () => {
		const { container } = await mount(view({ config: null, status: "invalid" }));

		expect(container.querySelector(".reviewer-model-status.invalid")?.textContent).toContain(
			"saved approval model configuration is invalid",
		);
		await openEditor(container);
		expect(button(container, "Test approval model").disabled).toBe(true);
	});
});
