// @vitest-environment jsdom

import type { InteractionView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserPanel } from "../src/renderer/components/AskUserPanel.tsx";
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

function mount(candidate: AskUserInteraction = interaction) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onRespond = vi.fn().mockResolvedValue(undefined);
	act(() => root.render(<AskUserPanel interaction={candidate} onRespond={onRespond} />));
	return { container, onRespond };
}

function option(container: HTMLElement, label: string): HTMLButtonElement {
	const candidate = [...container.querySelectorAll<HTMLButtonElement>(".ask-user-option")]
		.find((button) => button.textContent?.includes(label));
	if (!candidate) throw new Error(`Missing option: ${label}`);
	return candidate;
}

function inputValue(input: HTMLInputElement, value: string): void {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AskUserPanel", () => {
	it("answers single and multi-select questions atomically, including Something else", async () => {
		const { container, onRespond } = mount();

		expect(container.querySelector(".ask-user-slot .ask-user-panel")).not.toBeNull();
		const singleGroup = container.querySelector<HTMLElement>("[role=radiogroup]")!;
		expect(singleGroup).not.toBeNull();
		expect(singleGroup.getAttribute("aria-labelledby")).toBe(`ask-user-title-${interaction.interactionId}`);
		expect(container.textContent).toContain("1 of 2");
		expect(container.querySelectorAll(".ask-user-option-number")).toHaveLength(2);
		expect(container.querySelectorAll(".ask-user-checkbox")).toHaveLength(0);
		expect(container.textContent).toContain("Something else");

		act(() => option(container, "Cloud sync").click());
		expect(container.textContent).toContain("Which clients should be supported?");
		const multipleGroup = container.querySelector<HTMLElement>("[role=group]")!;
		expect(multipleGroup).not.toBeNull();
		expect(multipleGroup.getAttribute("aria-labelledby")).toBe(`ask-user-title-${interaction.interactionId}`);
		expect(container.querySelectorAll(".ask-user-option-number")).toHaveLength(0);
		expect(container.querySelectorAll(".ask-user-checkbox")).toHaveLength(4);
		expect(onRespond).not.toHaveBeenCalled();

		act(() => option(container, "Desktop").click());
		act(() => option(container, "Mobile").click());
		expect(container.textContent).toContain("2 selected");
		act(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Something else")?.click());
		const custom = container.querySelector<HTMLInputElement>(".ask-user-custom input")!;
		act(() => inputValue(custom, "Linux later"));
		expect(container.textContent).toContain("3 selected");
		await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Submit answers"]')?.click());

		expect(onRespond).toHaveBeenCalledWith({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [
				{ questionId: "question:0", choiceIds: ["choice:1"] },
				{
					questionId: "question:1",
					choiceIds: ["choice:0", "choice:2"],
					customAnswer: "Linux later",
				},
			],
		});
	});

	it("uses a custom answer as the single answer and supports numbered shortcuts", async () => {
		const single = { ...interaction, questions: [interaction.questions[0]] } satisfies AskUserInteraction;
		const customMounted = mount(single);
		act(() => [...customMounted.container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Something else")?.click());
		const custom = customMounted.container.querySelector<HTMLInputElement>(".ask-user-custom input")!;
		act(() => inputValue(custom, "Store it in SQLite"));
		await act(async () => customMounted.container
			.querySelector<HTMLButtonElement>('button[aria-label="Use custom answer"]')?.click());
		expect(customMounted.onRespond).toHaveBeenCalledWith({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [{ questionId: "question:0", choiceIds: [], customAnswer: "Store it in SQLite" }],
		});

		const shortcutMounted = mount(single);
		await act(async () => shortcutMounted.container.querySelector(".ask-user-panel")?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "2" }),
		));
		expect(shortcutMounted.onRespond).toHaveBeenCalledWith(expect.objectContaining({
			cancelled: false,
			answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
		}));
	});

	it("uses checkbox rows with arrow navigation for consecutive multi-select questions", () => {
		const multi = {
			...interaction,
			questions: [
				interaction.questions[1],
				{
					...interaction.questions[1],
					id: "question:2",
					question: "Which platforms should launch first?",
				},
			],
		} satisfies AskUserInteraction;
		const { container } = mount(multi);

		expect(container.querySelector(".ask-user-step.is-submit")).toBeNull();
		act(() => option(container, "Desktop").click());
		expect(container.textContent).toContain("1 selected");
		act(() => container.querySelector<HTMLButtonElement>('.ask-user-step[aria-label="Next question"]')?.click());
		expect(container.textContent).toContain("Which platforms should launch first?");
		expect(container.textContent).toContain("2 of 2");
		expect(container.querySelector('.ask-user-step.is-submit[aria-label="Submit answers"]')).not.toBeNull();
	});

	it("restores previous answers and cancels the whole request with Escape", async () => {
		const { container, onRespond } = mount();
		act(() => option(container, "Local database").click());
		act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')?.click());
		expect(option(container, "Local database").getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')?.disabled).toBe(true);
		expect(container.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')?.disabled).toBe(false);

		await act(async () => container.querySelector(".ask-user-panel")?.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
		));
		expect(onRespond).toHaveBeenCalledWith({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: true,
			answers: [],
		});
	});
});
