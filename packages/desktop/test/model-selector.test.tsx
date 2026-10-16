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
		await act(async () =>
			root.render(
				<ModelSelector
					available={available}
					disabled={false}
					onChange={onChange}
					value={{ provider: "xiaomi", modelId: "mimo-v2.5-pro" }}
				/>,
			),
		);

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		const providers = [...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")];
		expect(providers.map((item) => item.textContent)).toEqual(["Xiaomi MiMo", "OpenAI"]);
		expect(providers[0]!.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);

		// Drill into the current provider: the provider menu stays open and the
		// model submenu appears alongside it with the models listed directly.
		await act(async () => providers[0]!.click());
		expect(container.querySelector(".model-selector-provider")).not.toBeNull();
		expect(container.querySelector(".model-selector-submenu")).not.toBeNull();
		const modelOptions = [
			...container.querySelectorAll<HTMLButtonElement>(".model-selector-submenu [role=menuitemradio]"),
		];
		expect(modelOptions.map((item) => item.textContent)).toEqual(["mimo-v2.51", "mimo-v2.5-pro"]);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
		expect(onChange).toHaveBeenCalledWith(available[0]);

		// Escape returns to the provider list instead of closing the popover.
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".model-selector-provider")!.click());
		expect(container.querySelector(".model-selector-submenu")).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector(".model-selector-submenu")).toBeNull();
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
		await act(async () =>
			root.render(
				<ModelSelector
					available={available}
					disabled={false}
					onChange={onChange}
					value={{ provider: "openai", modelId: "gpt-test" }}
				/>,
			),
		);

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		const azure = [...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")].find((item) =>
			item.textContent?.includes("Azure OpenAI"),
		);
		await act(async () => azure!.click());
		expect(container.querySelector(".model-selector-provider")).not.toBeNull();
		await act(async () =>
			container.querySelector<HTMLButtonElement>(".model-selector-submenu [role=menuitemradio]")!.click(),
		);
		expect(onChange).toHaveBeenCalledWith(available[1]);
		await act(async () => root.unmount());
	});

	it("filters providers with the search box and shows an empty state", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = [
			{ provider: "openai", modelId: "gpt-test", name: "GPT Test" },
			{ provider: "google", modelId: "gemini-test", name: "Gemini Test" },
		] as const;
		await act(async () =>
			root.render(
				<ModelSelector
					available={available}
					disabled={false}
					onChange={vi.fn()}
					value={{ provider: "openai", modelId: "gpt-test" }}
				/>,
			),
		);

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		const search = container.querySelector<HTMLInputElement>('[aria-label="Search providers"]')!;
		expect(document.activeElement).toBe(search);
		expect([...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")]).toHaveLength(2);

		await act(async () => changeInput(search, "goo"));
		expect(
			[...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")].map((item) => item.textContent),
		).toEqual(["Google Gemini"]);
		await act(async () => changeInput(search, "nope"));
		expect(container.textContent).toContain("No matches");
		expect(container.querySelectorAll(".model-selector-provider")).toHaveLength(0);
		await act(async () => root.unmount());
	});

	it("filters models inside the active provider and ignores number shortcuts while typing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const available = [
			{ provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
			{ provider: "openai", modelId: "gpt-5", name: "GPT-5" },
			{ provider: "openai", modelId: "o3", name: "o3" },
		] as const;
		await act(async () =>
			root.render(
				<ModelSelector
					available={available}
					disabled={false}
					onChange={onChange}
					value={{ provider: "openai", modelId: "gpt-4o" }}
				/>,
			),
		);

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".model-selector-provider")!.click());
		const search = container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
		expect(document.activeElement).toBe(search);

		// Typing "1" must not trigger the model number shortcut.
		await act(async () => changeInput(search, "1"));
		expect(onChange).not.toHaveBeenCalled();
		const matches = [
			...container.querySelectorAll<HTMLButtonElement>(".model-selector-submenu [role=menuitemradio]"),
		];
		expect(matches).toHaveLength(0);
		expect(container.textContent).toContain("No matches");

		await act(async () => changeInput(search, "gpt-5"));
		const filtered = [
			...container.querySelectorAll<HTMLButtonElement>(".model-selector-submenu [role=menuitemradio]"),
		];
		expect(filtered).toHaveLength(1);
		expect(filtered[0]!.querySelector("span")?.textContent).toBe("GPT-5");
		await act(async () => filtered[0]!.click());
		expect(onChange).toHaveBeenCalledWith(available[1]);
		await act(async () => root.unmount());
	});
});

function changeInput(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}
