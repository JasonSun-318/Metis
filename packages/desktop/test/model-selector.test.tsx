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
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })),
		);
		expect(onChange).toHaveBeenCalledWith(available[0]);

		// Escape returns to the provider list instead of closing the popover.
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
		await act(async () => container.querySelector<HTMLButtonElement>(".model-selector-provider")!.click());
		expect(container.querySelector(".model-selector-submenu")).not.toBeNull();
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(container.querySelector(".model-selector-submenu")).toBeNull();
		expect(container.querySelector(".model-selector-provider")).not.toBeNull();

		// Escape on the provider list closes the popover entirely.
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
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

	it("has no search inputs and navigates every provider and model with real item focus", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = [
			{ provider: "openai", modelId: "gpt-4o", name: "GPT-4o" },
			{ provider: "openai", modelId: "gpt-5", name: "GPT-5" },
			{ provider: "google", modelId: "gemini-a", name: "Gemini A" },
			{ provider: "google", modelId: "gemini-b", name: "Gemini B" },
			{ provider: "xiaomi", modelId: "mimo", name: "MiMo" },
		] as const;
		try {
			await act(async () =>
				root.render(
					<ModelSelector
						available={available}
						disabled={false}
						onChange={vi.fn()}
						value={{ provider: "openai", modelId: "gpt-5" }}
					/>,
				),
			);
			const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!;
			await act(async () => trigger.click());
			const providers = [...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")];
			expect(container.querySelector("input")).toBeNull();
			expect(providers.map((item) => item.textContent)).toEqual(["OpenAI", "Google Gemini", "Xiaomi MiMo"]);
			expect(document.activeElement).toBe(providers[0]);
			await press("End");
			expect(document.activeElement).toBe(providers[2]);
			await press("Home");
			await press("ArrowDown");
			expect(document.activeElement).toBe(providers[1]);
			await press("ArrowRight");
			const models = [...container.querySelectorAll<HTMLButtonElement>(".model-selector-submenu button")];
			expect(models.map((item) => item.querySelector("span")?.textContent)).toEqual(["Gemini A", "Gemini B"]);
			expect(container.querySelector("input")).toBeNull();
			expect(document.activeElement).toBe(models[0]);
			await press("ArrowUp");
			expect(document.activeElement).toBe(models[1]);
			await press("Home");
			expect(document.activeElement).toBe(models[0]);
			await press("End");
			expect(document.activeElement).toBe(models[1]);
			await press("ArrowLeft");
			expect(container.querySelector(".model-selector-submenu")).toBeNull();
			expect(document.activeElement).toBe(providers[1]);
			await press("Escape");
			expect(container.querySelector('[role="menu"]')).toBeNull();
			expect(document.activeElement).toBe(trigger);
			await act(async () => trigger.click());
			await press("ArrowRight");
			expect(document.activeElement?.textContent).toBe("GPT-5");
			await press("Escape");
			expect(document.activeElement).toBe(container.querySelector(".model-selector-provider"));
			await press("Escape");
			expect(document.activeElement).toBe(trigger);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps all ten models reachable while number shortcuts retain their original first-nine mapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = Array.from({ length: 10 }, (_, index) => ({
			provider: "openai",
			modelId: `model-${index}`,
			name: `Model ${index}`,
		}));
		const onChange = vi.fn();
		try {
			await act(async () =>
				root.render(
					<ModelSelector
						available={available}
						disabled={false}
						onChange={onChange}
						value={{ provider: "openai", modelId: "model-9" }}
					/>,
				),
			);
			await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!.click());
			await press("ArrowRight");
			expect(container.querySelectorAll(".model-selector-submenu button")).toHaveLength(10);
			expect(document.activeElement?.textContent).toBe("Model 9");
			const editor = document.createElement("textarea");
			document.body.append(editor);
			const unrelated = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
			await act(async () => editor.dispatchEvent(unrelated));
			expect(unrelated.defaultPrevented).toBe(false);
			expect(onChange).not.toHaveBeenCalled();
			await press("9");
			expect(onChange).toHaveBeenCalledExactlyOnceWith(available[8]);
			expect(container.querySelector('[role="menu"]')).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("preserves focus through background model refresh and dismisses on Tab, outside pointer or focus", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = [
			{ provider: "openai", modelId: "first", name: "First" },
			{ provider: "openai", modelId: "second", name: "Second" },
		];
		const props = { available, disabled: false, onChange: vi.fn(), value: { provider: "openai", modelId: "first" } };
		try {
			await act(async () => root.render(<ModelSelector {...props} />));
			const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!;
			await act(async () => trigger.click());
			await press("ArrowRight");
			await press("ArrowDown");
			const focused = document.activeElement;
			await act(async () =>
				root.render(
					<ModelSelector
						{...props}
						available={[...available, { provider: "openai", modelId: "third", name: "Third" }]}
					/>,
				),
			);
			expect(document.activeElement).toBe(focused);
			const tab = await press("Tab");
			expect(tab.defaultPrevented).toBe(false);
			expect(container.querySelector('[role="menu"]')).toBeNull();
			const outside = document.createElement("button");
			container.append(outside);
			await act(async () => outside.focus());
			expect(document.activeElement).toBe(outside);
			await act(async () => trigger.click());
			await act(async () => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
			expect(container.querySelector('[role="menu"]')).toBeNull();
			await act(async () => trigger.click());
			await act(async () => outside.focus());
			expect(container.querySelector('[role="menu"]')).toBeNull();
			expect(document.activeElement).toBe(outside);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("recovers a removed provider's focus while preserving keyboard navigation", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = [
			{ provider: "openai", modelId: "first", name: "First" },
			{ provider: "google", modelId: "gemini", name: "Gemini" },
			{ provider: "xiaomi", modelId: "mimo", name: "MiMo" },
		];
		const props = { available, disabled: false, onChange: vi.fn(), value: { provider: "openai", modelId: "first" } };
		try {
			await act(async () => root.render(<ModelSelector {...props} />));
			const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!;
			await act(async () => trigger.click());
			const removed = document.activeElement!;
			await act(async () => root.render(<ModelSelector {...props} available={available.slice(1)} />));
			expect(removed.isConnected).toBe(false);
			expect(document.activeElement?.textContent).toBe("Google Gemini");
			await press("ArrowDown");
			expect(document.activeElement?.textContent).toBe("Xiaomi MiMo");
			await press("Escape");
			expect(container.querySelector('[role="menu"]')).toBeNull();
			expect(document.activeElement).toBe(trigger);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("recovers a removed model and returns from a vanished provider without leaving an empty submenu", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const available = [
			{ provider: "openai", modelId: "first", name: "First" },
			{ provider: "openai", modelId: "second", name: "Second" },
			{ provider: "openai", modelId: "third", name: "Third" },
			{ provider: "google", modelId: "gemini", name: "Gemini" },
		];
		const props = { available, disabled: false, onChange: vi.fn(), value: { provider: "openai", modelId: "first" } };
		try {
			await act(async () => root.render(<ModelSelector {...props} />));
			const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!;
			await act(async () => trigger.click());
			await press("ArrowRight");
			await press("ArrowDown");
			const removed = document.activeElement!;
			await act(async () =>
				root.render(
					<ModelSelector {...props} available={available.filter((model) => model.modelId !== "second")} />,
				),
			);
			expect(removed.isConnected).toBe(false);
			expect(document.activeElement?.textContent).toBe("First");
			await press("ArrowDown");
			expect(document.activeElement?.textContent).toBe("Third2");
			await act(async () =>
				root.render(
					<ModelSelector {...props} available={available.filter((model) => model.provider === "google")} />,
				),
			);
			expect(container.querySelector(".model-selector-submenu")).toBeNull();
			expect(document.activeElement?.textContent).toBe("Google Gemini");
			await press("ArrowRight");
			expect(document.activeElement?.textContent).toBe("Gemini1");
			await act(async () => root.render(<ModelSelector {...props} available={[]} />));
			expect(container.querySelector('[role="menu"]')).toBeNull();
			expect(trigger.disabled).toBe(true);
			expect(document.activeElement).not.toBe(trigger);
			const editor = document.createElement("textarea");
			container.append(editor);
			await act(async () => editor.focus());
			await act(async () => root.render(<ModelSelector {...props} available={[...available]} />));
			expect(document.activeElement).toBe(editor);
			expect(container.querySelector('[role="menu"]')).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("keeps selection pending across external requests and recovers after a rejected callback", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		let reject!: (reason: Error) => void;
		const onChange = vi.fn(
			() =>
				new Promise<void>((_, fail) => {
					reject = fail;
				}),
		);
		const available = [
			{ provider: "openai", modelId: "first", name: "First" },
			{ provider: "openai", modelId: "second", name: "Second" },
		];
		const props = { available, disabled: false, onChange, value: { provider: "openai", modelId: "first" } };
		try {
			await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 0, open: false }} />));
			const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Select model"]')!;
			await act(async () => trigger.click());
			await press("ArrowRight");
			await press("2");
			expect(onChange).toHaveBeenCalledExactlyOnceWith(available[1]);
			expect(trigger.disabled).toBe(true);
			await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 1, open: true }} />));
			expect(container.querySelector('[role="menu"]')).toBeNull();
			await act(async () => reject(new Error("Selection failed")));
			expect(trigger.disabled).toBe(false);
			expect(container.querySelector('[role="menu"]')).toBeNull();
			await act(async () => root.render(<ModelSelector {...props} commandRequest={{ id: 2, open: true }} />));
			expect(document.activeElement).toBe(container.querySelector(".model-selector-provider"));
			await act(async () =>
				root.render(<ModelSelector {...props} disabled commandRequest={{ id: 2, open: true }} />),
			);
			expect(container.querySelector('[role="menu"]')).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});
});

async function press(key: string) {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
	await act(async () => {
		document.activeElement!.dispatchEvent(event);
	});
	return event;
}
