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

	it("shows the real model list and selects by click or number shortcut", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const available = [
			{ provider: "xiaomi", modelId: "mimo-v2.5", name: "mimo-v2.5" },
			{ provider: "xiaomi", modelId: "mimo-v2.5-pro", name: "mimo-v2.5-pro" },
		] as const;
		await act(async () => root.render(
			<ModelSelector available={available} disabled={false} onChange={onChange} value={{ provider: "xiaomi", modelId: "mimo-v2.5-pro" }} />,
		));

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		expect([...container.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual([
			"mimo-v2.51",
			"mimo-v2.5-pro",
		]);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
		expect(onChange).toHaveBeenCalledWith(available[0]);
		await act(async () => root.unmount());
	});
});
