// @vitest-environment jsdom

import type { InteractionView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AskUserDraft, AskUserPanel } from "../src/renderer/components/AskUserPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

type AskUserInteraction = Extract<InteractionView, { kind: "ask_user" }>;

const interaction = {
	interactionId: "00000000-0000-4000-8000-000000000501",
	sessionId: "session-1",
	title: "Metis has questions",
	message: "Answer each question to continue.",
	createdAt: "2026-08-10T00:00:00.000Z",
	kind: "ask_user",
	questions: [
		{
			id: "question:0",
			question: "Where should task data be stored?",
			multiple: false,
			choices: [
				{ id: "choice:0", label: "Local database", description: "Works offline" },
				{ id: "choice:1", label: "Cloud sync", description: "Works across devices" },
			],
		},
		{
			id: "question:1",
			question: "Which clients should be supported?",
			multiple: true,
			choices: [
				{ id: "choice:0", label: "Desktop" },
				{ id: "choice:1", label: "Web" },
				{ id: "choice:2", label: "Mobile" },
			],
		},
	],
} satisfies AskUserInteraction;

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

function mount(candidate: AskUserInteraction = interaction, draftCache?: Map<string, AskUserDraft>) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onRespond = vi.fn().mockResolvedValue(undefined);
	act(() => root.render(<AskUserPanel interaction={candidate} onRespond={onRespond} draftCache={draftCache} />));
	return { container, root, onRespond };
}

function option(container: HTMLElement, label: string): HTMLButtonElement {
	const candidate = [...container.querySelectorAll<HTMLButtonElement>(".ask-user-option")].find((button) =>
		button.textContent?.includes(label),
	);
	if (!candidate) throw new Error(`Missing option: ${label}`);
	return candidate;
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	Object.getOwnPropertyDescriptor(
		input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
		"value",
	)?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AskUserPanel", () => {
	it("selects without advancing and submits all questions only after confirmation", async () => {
		const { container, onRespond } = mount();
		act(() => option(container, "Cloud sync").click());
		expect(container.textContent).toContain("Where should task data be stored?");
		expect(onRespond).not.toHaveBeenCalled();
		act(() => button(container, "Continue").click());
		expect(container.textContent).toContain("Which clients should be supported?");
		act(() => option(container, "Desktop").click());
		act(() => option(container, "Mobile").click());
		const custom = container.querySelector<HTMLTextAreaElement>("textarea")!;
		act(() => inputValue(custom, "Linux later\nAfter release"));
		act(() => button(container, "Previous question").click());
		expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
		act(() => button(container, "Continue").click());
		expect(container.querySelector("textarea")?.value).toBe("Linux later\nAfter release");
		await act(async () => {
			button(container, "Confirm and continue").click();
			await new Promise((r) => setTimeout(r, 180));
		});
		expect(onRespond).toHaveBeenCalledExactlyOnceWith({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [
				{ questionId: "question:0", choiceIds: ["choice:1"] },
				{
					questionId: "question:1",
					choiceIds: ["choice:0", "choice:2"],
					customAnswer: "Linux later\nAfter release",
				},
			],
		});
	});

	it("collapses without cancelling and restores the answer after remount", async () => {
		const cache = new Map<string, AskUserDraft>();
		const { container, root, onRespond } = mount(interaction, cache);
		act(() => option(container, "Cloud sync").click());
		act(() =>
			container
				.querySelector(".ask-user-panel")!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(onRespond).not.toHaveBeenCalled();
		expect(container.querySelector(".ask-user-panel")).toBeNull();
		act(() => root.render(null));
		act(() => root.render(<AskUserPanel interaction={interaction} onRespond={onRespond} draftCache={cache} />));
		act(() => button(container, "Continue answering").click());
		expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
		await act(async () => {
			button(container, "Skip all questions").click();
			await new Promise((r) => setTimeout(r, 180));
		});
		expect(onRespond).toHaveBeenCalledExactlyOnceWith({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: true,
			answers: [],
		});
	});

	it("handles radio arrows and numeric selection without submitting; ignores IME", () => {
		const { container, onRespond } = mount({ ...interaction, questions: [interaction.questions[0]!] });
		act(() => {
			option(container, "Local database").focus();
			option(container, "Local database").dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		expect(document.activeElement).toBe(option(container, "Cloud sync"));
		expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
		act(() =>
			container
				.querySelector(".ask-user-panel")!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, isComposing: true })),
		);
		expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
		act(() =>
			container
				.querySelector(".ask-user-panel")!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })),
		);
		expect(option(container, "Local database").getAttribute("aria-checked")).toBe("true");
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("preserves custom text on failed submission and prevents duplicate requests", async () => {
		const { container, onRespond } = mount({ ...interaction, questions: [interaction.questions[0]!] });
		onRespond.mockRejectedValueOnce(new Error("Connection lost"));
		act(() => inputValue(container.querySelector("textarea")!, "SQLite"));
		const submit = button(container, "Confirm and continue");
		await act(async () => {
			submit.click();
			submit.click();
			await new Promise((r) => setTimeout(r, 180));
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
		expect(container.querySelector("textarea")?.value).toBe("SQLite");
		await act(async () => {
			button(container, "Confirm and continue").click();
			await new Promise((r) => setTimeout(r, 180));
		});
		expect(onRespond).toHaveBeenCalledTimes(2);
	});

	it("browses unanswered questions and returns to the first missing answer on confirmation", () => {
		const { container, onRespond } = mount();
		expect(button(container, "Previous question").disabled).toBe(true);
		act(() => button(container, "Next question").click());
		expect(button(container, "Next question").disabled).toBe(true);
		act(() => option(container, "Desktop").click());
		act(() => button(container, "Confirm and continue").click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Answer question 1 before submitting.");
		expect(container.querySelector("h2")?.textContent).toBe(interaction.questions[0].question);
		expect(onRespond).not.toHaveBeenCalled();
		act(() => inputValue(container.querySelector("textarea")!, "Use SQLite"));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		act(() => button(container, "Next question").click());
		expect(option(container, "Desktop").getAttribute("aria-checked")).toBe("true");
		act(() => button(container, "Previous question").click());
		expect(container.querySelector("textarea")?.value).toBe("Use SQLite");
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("offers custom input immediately, preserves single-choice semantics and reconnect drafts", () => {
		const cache = new Map<string, AskUserDraft>();
		const { container, root, onRespond } = mount(interaction, cache);
		act(() => option(container, "Cloud sync").click());
		act(() => inputValue(container.querySelector("textarea")!, "本地 SQLite"));
		expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("false");
		act(() =>
			root.render(<AskUserPanel interaction={interaction} onRespond={onRespond} draftCache={cache} disabled />),
		);
		expect(container.querySelector("textarea")?.value).toBe("本地 SQLite");
		expect(button(container, "Next question").disabled).toBe(true);
		expect(container.querySelector("textarea")?.disabled).toBe(true);
		act(() => button(container, "Skip all questions").click());
		expect(onRespond).not.toHaveBeenCalled();
		act(() => root.render(<AskUserPanel interaction={interaction} onRespond={onRespond} draftCache={cache} />));
		act(() => option(container, "Local database").click());
		expect(container.querySelector("textarea")?.value).toBe("");
		expect(option(container, "Local database").getAttribute("aria-checked")).toBe("true");
	});

	it("puts Something else in the placeholder and keeps the accessible name", () => {
		const { container } = mount();
		const custom = container.querySelector<HTMLTextAreaElement>("textarea")!;
		expect(custom.getAttribute("aria-label")).toBe("Something else");
		expect(custom.getAttribute("placeholder")).toBe("Something else…");
		expect(container.querySelector(".ask-user-custom strong")).toBeNull();
		expect(container.textContent).not.toContain("Type your own answer");
	});

	it("keeps collapsed drafts and leaves outer height motion to the shared stack", async () => {
		const single = { ...interaction, questions: [interaction.questions[0]!] } satisfies AskUserInteraction;
		const cache = new Map<string, AskUserDraft>();
		const { container, onRespond } = mount(single, cache);
		act(() => inputValue(container.querySelector("textarea")!, "Keep this"));
		act(() => button(container, "Collapse questions").click());
		expect(cache.get(single.interactionId)?.collapsed).toBe(true);
		expect(cache.get(single.interactionId)?.answers[0]?.customAnswer).toBe("Keep this");
		expect(container.querySelector(".ask-user-resume")).not.toBeNull();
		expect(onRespond).not.toHaveBeenCalled();
		act(() => button(container, "Continue answering").click());
		expect(container.querySelector("textarea")?.value).toBe("Keep this");
		act(() => button(container, "Confirm and continue").click());
		const slot = container.querySelector<HTMLElement>(".ask-user-slot")!;
		expect(slot.className).toBe("ask-user-slot");
		expect(slot.classList.contains("is-submitting")).toBe(false);
		expect(slot.style.animation).toBe("");
		expect(slot.style.transition).toBe("");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	});

	it("returns focus to the composer editor after a normal submit unmount", async () => {
		const column = document.createElement("div");
		column.className = "conversation-column";
		const editor = document.createElement("div");
		editor.tabIndex = 0;
		editor.setAttribute("contenteditable", "true");
		column.append(editor);
		document.body.append(column);
		const container = document.createElement("div");
		column.append(container);
		const root = createRoot(container);
		roots.push(root);
		const onRespond = vi.fn().mockResolvedValue(undefined);
		await act(async () => {
			root.render(
				<AskUserPanel
					interaction={{ ...interaction, questions: [interaction.questions[0]!] }}
					onRespond={onRespond}
				/>,
			);
		});
		const heading = container.querySelector("h2")!;
		expect(document.activeElement).toBe(heading);
		act(() => option(container, "Local database").click());
		await act(async () => {
			button(container, "Confirm and continue").click();
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement).toBe(editor);
	});

	it("does not focus an Ask arriving in a background pane", async () => {
		const column = document.createElement("div");
		column.className = "conversation-column";
		const other = document.createElement("div");
		other.className = "conversation-column";
		const otherEditor = document.createElement("div");
		otherEditor.tabIndex = 0;
		otherEditor.setAttribute("contenteditable", "true");
		other.append(otherEditor);
		document.body.append(column, other);
		const container = document.createElement("div");
		column.append(container);
		const root = createRoot(container);
		roots.push(root);
		otherEditor.focus();
		expect(document.activeElement).toBe(otherEditor);
		await act(async () => {
			root.render(<AskUserPanel interaction={interaction} onRespond={vi.fn().mockResolvedValue(undefined)} />);
		});
		expect(document.activeElement).toBe(otherEditor);
		expect(container.querySelector("h2")).not.toBeNull();
	});

	it("does not steal focus from another pane or restore a disabled control", async () => {
		const column = document.createElement("div");
		column.className = "conversation-column";
		const other = document.createElement("div");
		other.className = "conversation-column";
		const otherEditor = document.createElement("div");
		otherEditor.tabIndex = 0;
		otherEditor.setAttribute("contenteditable", "true");
		other.append(otherEditor);
		document.body.append(column, other);
		const container = document.createElement("div");
		column.append(container);
		const root = createRoot(container);
		roots.push(root);
		const onRespond = vi.fn().mockResolvedValue(undefined);
		await act(async () => {
			root.render(<AskUserPanel interaction={interaction} onRespond={onRespond} />);
		});
		const heading = container.querySelector("h2")!;
		expect(document.activeElement).toBe(heading);
		otherEditor.focus();
		expect(document.activeElement).toBe(otherEditor);
		await act(async () => root.unmount());
		expect(document.activeElement).toBe(otherEditor);

		const again = document.createElement("div");
		column.append(again);
		const second = createRoot(again);
		roots.push(second);
		const disabledEditor = document.createElement("div");
		disabledEditor.tabIndex = 0;
		disabledEditor.setAttribute("contenteditable", "true");
		disabledEditor.setAttribute("aria-hidden", "true");
		column.append(disabledEditor);
		await act(async () => {
			second.render(<AskUserPanel interaction={interaction} onRespond={onRespond} />);
		});
		act(() => again.querySelector("h2")!.focus());
		await act(async () => second.unmount());
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.activeElement).not.toBe(disabledEditor);
	});

	it("drops a late response after unmount and ignores a duplicate click", async () => {
		let resolveResponse: (() => void) | undefined;
		const onRespond = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => {
			root.render(
				<AskUserPanel
					interaction={{ ...interaction, questions: [interaction.questions[0]!] }}
					onRespond={onRespond}
				/>,
			);
		});
		act(() => option(container, "Local database").click());
		const submit = button(container, "Confirm and continue");
		await act(async () => {
			submit.click();
			submit.click();
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		await act(async () => {
			resolveResponse?.();
			await Promise.resolve();
		});
		expect(onRespond).toHaveBeenCalledTimes(1);
	});
});

function button(container: HTMLElement, name: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(b) => b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
	);
	if (!match) throw new Error(`Missing button: ${name}`);
	return match;
}
