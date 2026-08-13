// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/components/Composer.tsx";

afterEach(() => document.body.replaceChildren());

function type(textarea: HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Composer slash commands", () => {
	it("executes a selected built-in without sending it to the model", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSlashCommand = vi.fn();
		const onSubmit = vi.fn(async () => undefined);
		await act(async () => root.render(
			<Composer disabled={false} onInterrupt={async () => undefined} onSlashCommand={onSlashCommand} onSubmit={onSubmit} running={false} />,
		));
		const textarea = container.querySelector("textarea")!;
		await act(async () => type(textarea, "/com"));
		expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(onSlashCommand).toHaveBeenCalledWith("compact");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(textarea.value).toBe("");
		await act(async () => root.unmount());
	});

	it("inserts a removable Skill chip and sends unknown slash text normally", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onSubmit = vi.fn(async () => undefined);
		const props = {
			disabled: false,
			onInterrupt: async () => undefined,
			onSubmit,
			running: false,
			skills: [{ name: "codebase-design", description: "Design deep modules" }],
		};
		await act(async () => root.render(<Composer {...props} />));
		const textarea = container.querySelector("textarea")!;
		await act(async () => type(textarea, "/skill:code"));
		await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(container.querySelector(".composer-chips .is-skill")?.textContent).toContain("codebase-design");
		await act(async () => type(textarea, "review this"));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
			text: "review this",
			skill: expect.objectContaining({ name: "codebase-design" }),
		}));

		await act(async () => type(textarea, "/unknown"));
		await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
		expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "/unknown" }));
		await act(async () => root.unmount());
	});
});
