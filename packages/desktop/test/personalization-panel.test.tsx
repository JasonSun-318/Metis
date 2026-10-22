// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalizationPanel } from "../src/renderer/components/PersonalizationPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(
		element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
		"value",
	)?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("Personalization instructions", () => {
	const roots: ReturnType<typeof createRoot>[] = [];

	beforeEach(async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		await setLocale("en");
	});

	afterEach(async () => {
		for (const root of roots.splice(0)) await act(async () => root.unmount());
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	async function mount(initial = "Initial") {
		const getPersonalization = vi.fn().mockResolvedValue({ instructions: initial });
		const updatePersonalization = vi.fn();
		const api = {
			getPersonalization,
			updatePersonalization,
		} as unknown as Pick<MetisDesktopApi, "getPersonalization" | "updatePersonalization">;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => root.render(<PersonalizationPanel api={api} serverReady />));
		await flush();
		return { container, updatePersonalization };
	}

	function textarea(container: ParentNode) {
		return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Global instructions"]')!;
	}

	it("keeps the pending explicit save draft unchanged by preset, input, and Clear, then preserves it on failure", async () => {
		const { container, updatePersonalization } = await mount();
		const pending = deferred<{ instructions: string }>();
		updatePersonalization.mockReturnValue(pending.promise);
		const editor = textarea(container);
		await act(async () => setValue(editor, "Be concise."));
		await act(async () => button(container, "Save instructions").click());

		expect(editor.disabled).toBe(true);
		expect(button(container, "Clear instructions").disabled).toBe(true);
		const chips = [...container.querySelectorAll<HTMLButtonElement>(".personalization-preset-chip")];
		expect(chips).toHaveLength(5);
		expect(chips.every((chip) => chip.disabled)).toBe(true);

		await act(async () => {
			chips[0].click();
			button(container, "Clear instructions").click();
			setValue(editor, "Overwritten while a save is pending");
		});
		expect(editor.value).toBe("Be concise.");

		await act(async () => {
			pending.resolve({ instructions: "Be concise." });
			await pending.promise;
		});
		await flush();
		expect(updatePersonalization).toHaveBeenCalledTimes(1);
		expect(updatePersonalization).toHaveBeenCalledWith({ instructions: "Be concise." });
		expect(editor.value).toBe("Be concise.");
		expect(container.textContent).toContain("Saved");

		const failed = deferred<{ instructions: string }>();
		updatePersonalization.mockReturnValue(failed.promise);
		await act(async () => setValue(editor, "Keep this draft"));
		await act(async () => button(container, "Save instructions").click());
		await act(async () => {
			failed.reject(new Error("offline"));
			await failed.promise.catch(() => undefined);
		});
		await flush();
		expect(editor.value).toBe("Keep this draft");
		expect(container.textContent).toContain("Couldn’t save global instructions.");
		expect(container.textContent).toContain("Unsaved changes");
		expect(button(container, "Save instructions").disabled).toBe(false);
		expect(
			[...container.querySelectorAll<HTMLButtonElement>(".personalization-preset-chip")].every(
				(chip) => !chip.disabled,
			),
		).toBe(true);
	});

	it("appends presets once, clears, and enforces the 64 KiB limit", async () => {
		const { container, updatePersonalization } = await mount("Base");
		await act(async () => button(container, "Concise and direct").click());
		const concise =
			"Base\n\nKeep responses concise and efficient, focusing on core conclusions and code changes without unnecessary pleasantries.";
		expect(textarea(container).value).toBe(concise);

		await act(async () => button(container, "Concise and direct").click());
		expect(textarea(container).value).toBe(concise);

		await act(async () => button(container, "Explain reasoning").click());
		expect(textarea(container).value).toBe(
			`${concise}\n\nBefore changing code, explain the reasoning and assess edge cases and architectural impact.`,
		);

		await act(async () => button(container, "Clear instructions").click());
		expect(textarea(container).value).toBe("");
		await act(async () => button(container, "Strict TypeScript").click());
		expect(textarea(container).value).toBe(
			"Follow the TypeScript type system strictly; do not use any or implicit type escapes.",
		);

		await act(async () => setValue(textarea(container), "😀".repeat(16_385)));
		expect(button(container, "Save instructions").disabled).toBe(true);
		expect(container.textContent).toContain("Global instructions are too large.");
		expect(updatePersonalization).not.toHaveBeenCalled();
	});

	it("localizes the Clear control and byte count with the resolved UI locale", async () => {
		const { container } = await mount("Base");
		await act(async () => setLocale("zh-CN"));
		await flush();
		expect(button(container, "清空指令").disabled).toBe(false);
		expect(container.textContent).toContain("快速预设");
		expect(container.textContent).toContain("4 / 65,536 字节");
	});
});
