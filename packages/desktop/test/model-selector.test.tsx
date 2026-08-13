// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../src/renderer/components/ModelSelector.tsx";

afterEach(() => document.body.replaceChildren());

describe("ModelSelector", () => {
	it("opens and closes from an external command request", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			available: [{ provider: "openai", modelId: "gpt-test", name: "GPT Test" }],
			disabled: false,
			onChange: vi.fn(),
			value: { provider: "openai", modelId: "gpt-test" },
		} as const;
		await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 0, open: false }} />));
		await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 1, open: true }} />));
		expect(container.querySelector('[role="menu"]')).not.toBeNull();
		await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 2, open: false }} />));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("groups models by provider, drills in, and selects by click or number shortcut", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const available = [
			{ provider: "xiaomi", modelId: "mimo-v2.5", name: "mimo-v2.5" },
			{ provider: "xiaomi", modelId: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
			{ provider: "openai", modelId: "gpt-test", name: "GPT Test" },
		] as const;
		await act(async () => root.render(
			<ModelSelector available={available} disabled={false} onChange={onChange} value={{ provider: "xiaomi", modelId: "mimo-v2.5-pro" }} />,
		));

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		const providers = [...container.querySelectorAll<HTMLButtonElement>('.model-selector-provider')];
		expect(providers.map((item) => item.textContent)).toEqual(["Xiaomi MiMo", "OpenAI"]);
		expect(providers[0]!.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);

		// Drill into the current provider and pick a model by number shortcut.
		await act(async () => providers[0]!.click());
		expect(container.querySelector(".model-selector-back")?.textContent).toContain("Xiaomi MiMo");
		expect([...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
			"mimo-v2.51",
			"mimo-v2.5-pro",
		]);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
		expect(onChange).toHaveBeenCalledWith(available[0]);

		// Escape returns to the provider list instead of closing the popover.
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('.model-selector-provider')!.click());
		expect(container.querySelector(".model-selector-back")).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector(".model-selector-back")).toBeNull();
		expect(container.querySelector(".model-selector-provider")).not.toBeNull();

		// Escape on the provider list closes the popover entirely.
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("selects a model from another provider by click", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const available = [
			{ provider: "openai", modelId: "gpt-test", name: "GPT Test" },
			{ provider: "azure-openai-responses", modelId: "gpt-5.4", name: "GPT-5.4 Azure" },
		] as const;
		await act(async () => root.render(
			<ModelSelector available={available} disabled={false} onChange={onChange} value={{ provider: "openai", modelId: "gpt-test" }} />,
		));

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		const azure = [...container.querySelectorAll<HTMLButtonElement>('.model-selector-provider')]
			.find((item) => item.textContent?.includes("Azure OpenAI"));
		await act(async () => azure!.click());
		await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click());
		expect(onChange).toHaveBeenCalledWith(available[1]);
		await act(async () => root.unmount());
	});
});
