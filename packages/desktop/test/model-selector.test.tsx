// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../src/renderer/components/ModelSelector.tsx";

afterEach(() => document.body.replaceChildren());

describe("ModelSelector", () => {
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
