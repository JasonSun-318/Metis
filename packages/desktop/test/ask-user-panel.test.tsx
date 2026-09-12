// @vitest-environment jsdom

import type { InteractionView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserPanel, type AskUserDraft } from "../src/renderer/components/AskUserPanel.tsx";
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
	const candidate = [...container.querySelectorAll<HTMLButtonElement>(".ask-user-option")]
		.find((button) => button.textContent?.includes(label));
	if (!candidate) throw new Error(`Missing option: ${label}`);
	return candidate;
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set?.call(input, value);
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
  act(() => button(container, "Something else").click());
  const custom = container.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => inputValue(custom, "Linux later\nAfter release"));
  act(() => button(container, "Previous question").click());
  expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
  act(() => button(container, "Continue").click());
  expect(container.querySelector("textarea")?.value).toBe("Linux later\nAfter release");
  await act(async () => { button(container, "Confirm and continue").click(); await new Promise(r => setTimeout(r, 180)); });
  expect(onRespond).toHaveBeenCalledExactlyOnceWith({ interactionId: interaction.interactionId, kind: "ask_user", cancelled: false, answers: [
   { questionId: "question:0", choiceIds: ["choice:1"] },
   { questionId: "question:1", choiceIds: ["choice:0", "choice:2"], customAnswer: "Linux later\nAfter release" },
  ] });
 });

 it("collapses without cancelling and restores the answer after remount", async () => {
  const cache = new Map<string, AskUserDraft>();
  const { container, root, onRespond } = mount(interaction, cache);
  act(() => option(container, "Cloud sync").click());
  act(() => container.querySelector(".ask-user-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onRespond).not.toHaveBeenCalled();
  expect(container.querySelector(".ask-user-panel")).toBeNull();
  act(() => root.render(null));
  act(() => root.render(<AskUserPanel interaction={interaction} onRespond={onRespond} draftCache={cache} />));
  act(() => button(container, "Continue answering").click());
  expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
  await act(async () => { button(container, "Skip all questions").click(); await new Promise(r => setTimeout(r, 180)); });
  expect(onRespond).toHaveBeenCalledExactlyOnceWith({ interactionId: interaction.interactionId, kind: "ask_user", cancelled: true, answers: [] });
 });

 it("handles radio arrows and numeric selection without submitting; ignores IME", () => {
  const { container, onRespond } = mount({ ...interaction, questions: [interaction.questions[0]!] });
  act(() => { option(container, "Local database").focus(); option(container, "Local database").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement).toBe(option(container, "Cloud sync"));
  expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
  act(() => container.querySelector(".ask-user-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true, isComposing: true })));
  expect(option(container, "Cloud sync").getAttribute("aria-checked")).toBe("true");
  act(() => container.querySelector(".ask-user-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
  expect(option(container, "Local database").getAttribute("aria-checked")).toBe("true");
  expect(onRespond).not.toHaveBeenCalled();
 });

 it("preserves custom text on failed submission and prevents duplicate requests", async () => {
  const { container, onRespond } = mount({ ...interaction, questions: [interaction.questions[0]!] });
  onRespond.mockRejectedValueOnce(new Error("Connection lost"));
  act(() => button(container, "Something else").click());
  act(() => inputValue(container.querySelector("textarea")!, "SQLite"));
  const submit = button(container, "Confirm and continue");
  await act(async () => { submit.click(); submit.click(); await new Promise(r => setTimeout(r, 180)); });
  expect(onRespond).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(container.querySelector("textarea")?.value).toBe("SQLite");
  await act(async () => { button(container, "Confirm and continue").click(); await new Promise(r => setTimeout(r, 180)); });
  expect(onRespond).toHaveBeenCalledTimes(2);
 });
});

function button(container: HTMLElement, name: string): HTMLButtonElement {
 const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
 if (!match) throw new Error(`Missing button: ${name}`);
 return match;
}
