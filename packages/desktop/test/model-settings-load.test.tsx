// @vitest-environment jsdom

import type { ModelSettingsView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsPanel } from "../src/renderer/components/ModelSettingsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type PanelApi = Parameters<typeof ModelSettingsPanel>[0]["api"];

const roots: Root[] = [];

function view(loadError: string | null = null): ModelSettingsView {
	return {
		defaultModel: { provider: "openai", modelId: "gpt-5" },
		defaultThinkingSelection: "high",
		vision: null,
		loadError,
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

async function mount(api: PanelApi) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<ModelSettingsPanel api={api} serverReady />));
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

describe("model settings initial load", () => {
	it("shows a local error and Retry without editor actions when the transport rejects", async () => {
		const getModelSettings = vi.fn().mockRejectedValue(new Error("transport unavailable"));
		const { container } = await mount({
			getModelSettings,
			updateModelSettings: vi.fn(),
			testModelConnection: vi.fn(),
			discoverModels: vi.fn(),
		} as unknown as PanelApi);

		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("transport unavailable");
		expect(alert?.textContent).toContain("Retry");
		expect(container.textContent).not.toContain("Choose default model");
		expect(container.textContent).not.toContain("Add custom provider");
		expect(container.textContent).not.toContain("Configure");
		expect(container.querySelector(".model-provider-catalog")).toBeNull();
		expect(container.querySelector(".model-service-panel")).toBeNull();
	});

	it("reloads the same view on Retry and then shows built-in providers and controls", async () => {
		const getModelSettings = vi
			.fn()
			.mockRejectedValueOnce(new Error("transport unavailable"))
			.mockResolvedValue(view());
		const { container } = await mount({
			getModelSettings,
			updateModelSettings: vi.fn(),
			testModelConnection: vi.fn(),
			discoverModels: vi.fn(),
		} as unknown as PanelApi);

		expect(container.querySelector('[role="alert"]')?.textContent).toContain("transport unavailable");
		await act(async () => button(container, "Retry").click());

		expect(getModelSettings).toHaveBeenCalledTimes(2);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("OpenAI");
		expect(container.textContent).toContain("GPT-5");
		expect(container.textContent).toContain("Add custom provider");
		expect(container.textContent).toContain("Change default model");
	});

	it("keeps catalog and repair controls for a valid view carrying loadError", async () => {
		const loadError = "Provider catalog could not be refreshed.";
		const { container } = await mount({
			getModelSettings: vi.fn().mockResolvedValue(view(loadError)),
			updateModelSettings: vi.fn(),
			testModelConnection: vi.fn(),
			discoverModels: vi.fn(),
		} as unknown as PanelApi);

		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain(loadError);
		expect(container.textContent).toContain("OpenAI");
		expect(container.textContent).toContain("Add custom provider");
		expect(container.textContent).toContain("Hide provider catalog");
		expect(button(container, "Configure")).toBeTruthy();
	});
});
