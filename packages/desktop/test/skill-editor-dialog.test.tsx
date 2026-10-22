// @vitest-environment jsdom

import type { SkillDetailView } from "@metis/app-protocol";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillEditorDialog } from "../src/renderer/components/SkillEditorDialog.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type SkillEditorProps = ComponentProps<typeof SkillEditorDialog>;

const initial: SkillDetailView = {
	name: "writing-plans",
	description: "writing-plans description",
	source: "user",
	revision: "a".repeat(64),
	directoryPath: "/skills/writing-plans",
	entryFile: "SKILL.md",
	files: ["SKILL.md"],
	content: '---\nname: writing-plans\ndescription: "writing-plans description"\n---\n\n## Workflow\n',
	instructions: "## Workflow\n",
	updatedAt: "2026-08-11T08:00:00.000Z",
	editable: true,
};

const cleanDraft = {
	name: "weekly-status-report",
	description: "Summarize the week when asked for progress.",
	instructions: "Collect wins, blockers, and next steps.",
};

const roots: Root[] = [];

function dialog(container: ParentNode): HTMLElement {
	const element = container.querySelector<HTMLElement>('[role="dialog"]');
	if (!element) throw new Error("Missing dialog");
	return element;
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function hasButton(container: ParentNode, label: string): boolean {
	return [...container.querySelectorAll("button")].some(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
}

function setInput(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype =
		element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

function fields(container: ParentNode) {
	const root = dialog(container);
	return {
		name: root.querySelector<HTMLInputElement>('input[placeholder="weekly-status-report"]')!,
		description: root.querySelector<HTMLTextAreaElement>(".skill-editor-description")!,
		instructions: root.querySelector<HTMLTextAreaElement>(".skill-editor-instructions")!,
		content: root.querySelector<HTMLTextAreaElement>(".dialog-form-body textarea:not(.skill-editor-description)")!,
	};
}

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function render(overrides: Partial<SkillEditorProps> = {}) {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	let props: SkillEditorProps = {
		error: null,
		initial: undefined,
		mode: "create",
		onCancel: vi.fn(),
		onSubmit: vi.fn(),
		pending: false,
		source: "user",
		...overrides,
	};
	const renderWith = async (next: Partial<SkillEditorProps> = {}) => {
		props = { ...props, ...next };
		await act(async () => {
			root.render(<SkillEditorDialog {...props} />);
		});
		await flush();
	};
	await renderWith();
	return { container, renderWith, root };
}

async function fillCreate(container: ParentNode, draft = cleanDraft) {
	const field = fields(container);
	await act(async () => {
		setInput(field.name, draft.name);
		setInput(field.description, draft.description);
		setInput(field.instructions, draft.instructions);
	});
	return field;
}

function pressEscape(target: Element): void {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
	});
}

function pressBackdrop(container: ParentNode): void {
	act(() => {
		container
			.querySelector(".modal-backdrop")!
			.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
	});
}

beforeEach(async () => {
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
});

describe("SkillEditorDialog discard protection", () => {
	it("closes a clean create dialog immediately", async () => {
		const onCancel = vi.fn();
		const { container } = await render({ onCancel });
		await act(async () => button(dialog(container), "Close").click());
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(hasButton(dialog(container), "Keep editing")).toBe(false);
	});

	it("closes a clean edit dialog immediately without treating the initial content as dirty", async () => {
		const onCancel = vi.fn();
		const { container } = await render({ initial, mode: "edit", onCancel });
		pressEscape(dialog(container));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(hasButton(dialog(container), "Keep editing")).toBe(false);
	});

	it.each(["Close", "Cancel", "backdrop", "Escape"] as const)(
		"guards the %s close path for a dirty create draft",
		async (route) => {
			const onCancel = vi.fn();
			const { container } = await render({ onCancel });
			const field = await fillCreate(container);

			if (route === "Close") await act(async () => button(dialog(container), "Close").click());
			else if (route === "Cancel") await act(async () => button(dialog(container), "Cancel").click());
			else if (route === "backdrop") pressBackdrop(container);
			else pressEscape(dialog(container));

			expect(onCancel).not.toHaveBeenCalled();
			expect(dialog(container).textContent).toContain("Your changes have not been saved.");
			expect(field.name.value).toBe(cleanDraft.name);
			expect(field.description.value).toBe(cleanDraft.description);
			expect(field.instructions.value).toBe(cleanDraft.instructions);

			await act(async () => button(dialog(container), "Keep editing").click());
			expect(onCancel).not.toHaveBeenCalled();
			expect(hasButton(dialog(container), "Keep editing")).toBe(false);
			expect(field.name.value).toBe(cleanDraft.name);
			expect(field.description.value).toBe(cleanDraft.description);
			expect(field.instructions.value).toBe(cleanDraft.instructions);
		},
	);

	it("keeps an edited draft on Keep editing and discards it with one cancel", async () => {
		const onCancel = vi.fn();
		const { container } = await render({ initial, mode: "edit", onCancel });
		const edited = `${initial.content}\n## Extra\n\nKeep it short.\n`;
		const field = fields(container);
		await act(async () => setInput(field.content, edited));

		pressEscape(dialog(container));
		expect(onCancel).not.toHaveBeenCalled();
		expect(hasButton(dialog(container), "Keep editing")).toBe(true);
		await act(async () => button(dialog(container), "Keep editing").click());
		expect(onCancel).not.toHaveBeenCalled();
		expect(fields(container).content.value).toBe(edited);

		pressEscape(dialog(container));
		await act(async () => button(dialog(container), "Discard changes").click());
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("returns to editing when Escape is pressed while the discard prompt is visible", async () => {
		const onCancel = vi.fn();
		const { container } = await render({ onCancel });
		const field = await fillCreate(container);

		pressEscape(dialog(container));
		const keepEditing = button(dialog(container), "Keep editing");
		await flush();
		expect(document.activeElement).toBe(keepEditing);

		pressEscape(keepEditing);
		await flush();
		expect(onCancel).not.toHaveBeenCalled();
		expect(hasButton(dialog(container), "Keep editing")).toBe(false);
		expect(dialog(container)).toBeTruthy();
		expect(field.name.value).toBe(cleanDraft.name);
		expect(field.description.value).toBe(cleanDraft.description);
		expect(field.instructions.value).toBe(cleanDraft.instructions);
		expect(document.activeElement).toBe(field.name);
	});

	it("cannot close while a save is pending", async () => {
		const onCancel = vi.fn();
		const { container, renderWith } = await render({ onCancel });
		await fillCreate(container);
		await renderWith({ pending: true });

		expect(button(dialog(container), "Close").disabled).toBe(true);
		expect(button(dialog(container), "Cancel").disabled).toBe(true);
		expect(button(dialog(container), "Saving…").disabled).toBe(true);

		pressEscape(dialog(container));
		pressBackdrop(container);
		await act(async () => button(dialog(container), "Close").click());
		await act(async () => button(dialog(container), "Cancel").click());

		expect(onCancel).not.toHaveBeenCalled();
		expect(hasButton(dialog(container), "Keep editing")).toBe(false);
	});

	it("keeps every field and generated content across a failed save", async () => {
		const onSubmit = vi.fn();
		const { container, renderWith } = await render({ onSubmit });
		const field = await fillCreate(container);

		await act(async () => button(dialog(container), "Create").click());
		expect(onSubmit).toHaveBeenCalledWith(
			cleanDraft.name,
			`---\nname: ${cleanDraft.name}\ndescription: ${JSON.stringify(cleanDraft.description)}\n---\n\n${cleanDraft.instructions}\n`,
		);

		await renderWith({ pending: true });
		expect(field.name.disabled).toBe(true);
		expect(field.description.disabled).toBe(true);
		expect(field.instructions.disabled).toBe(true);

		await renderWith({ error: "Could not save the Skill.", pending: false });
		expect(dialog(container).querySelector('[role="alert"]')?.textContent).toBe("Could not save the Skill.");
		expect(field.name.value).toBe(cleanDraft.name);
		expect(field.description.value).toBe(cleanDraft.description);
		expect(field.instructions.value).toBe(cleanDraft.instructions);
		expect(field.name.disabled).toBe(false);
	});

	it("clears local validation feedback as soon as the invalid field changes", async () => {
		const onSubmit = vi.fn();
		const { container } = await render({ onSubmit });
		const field = await fillCreate(container, { ...cleanDraft, name: "Bad Name" });

		await act(async () => button(dialog(container), "Create").click());
		expect(onSubmit).not.toHaveBeenCalled();
		expect(dialog(container).querySelector('[role="alert"]')?.textContent).toContain(
			"Use lowercase letters, numbers, and single hyphens for the Skill name.",
		);

		await act(async () => setInput(field.name, cleanDraft.name));
		expect(dialog(container).querySelector('[role="alert"]')).toBeNull();

		await act(async () => button(dialog(container), "Create").click());
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});
});
