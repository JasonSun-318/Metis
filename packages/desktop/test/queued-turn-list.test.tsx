// @vitest-environment jsdom

import type { QueuedTurnView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuedTurnList } from "../src/renderer/components/QueuedTurnList.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const turns = [
	{
		queueItemId: "queue-1",
		revision: "revision-1",
		state: "queued",
		text: "First message",
		attachments: [{ name: "notes.txt", byteLength: 12 }],
	},
	{
		queueItemId: "queue-2",
		revision: "revision-2",
		state: "paused",
		text: "Second message",
		attachments: [],
	},
] satisfies readonly QueuedTurnView[];

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

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function mount(options: { running?: boolean; queuedTurns?: readonly QueuedTurnView[] } = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const handlers = { onDelete: vi.fn(), onEdit: vi.fn(), onSend: vi.fn() };
	await act(async () =>
		root.render(
			<QueuedTurnList
				disabled={false}
				onDelete={handlers.onDelete}
				onEdit={handlers.onEdit}
				onSend={handlers.onSend}
				running={options.running ?? false}
				turns={options.queuedTurns ?? turns}
			/>,
		),
	);
	return { container, handlers };
}

describe("QueuedTurnList", () => {
	it("renders server order and only enables idle Send for the FIFO head", async () => {
		const { container, handlers } = await mount();
		expect([...container.querySelectorAll(".queued-turn-text")].map(({ textContent }) => textContent)).toEqual([
			"First message",
			"Second message",
		]);
		expect(container.textContent).toContain("notes.txt");
		expect(container.querySelector('fieldset[aria-label="Queued message 1"]')).not.toBeNull();
		const sends = [...container.querySelectorAll<HTMLButtonElement>(".queued-turn-send")];
		expect(sends.map(({ textContent, disabled }) => [textContent, disabled])).toEqual([
			["Send", false],
			["Send", true],
		]);
		await act(async () => sends[0]!.click());
		expect(handlers.onSend).toHaveBeenCalledWith(turns[0], "start");
	});

	it("recalls a queued message from a direct Edit button", async () => {
		const { container, handlers } = await mount({ running: true });
		expect([...container.querySelectorAll(".queued-turn-send")].map(({ textContent }) => textContent)).toEqual([
			"Guide",
			"Guide",
		]);
		await act(async () => button(container, "Edit queued message").click());
		expect(handlers.onEdit).toHaveBeenCalledWith(turns[0]);
		expect(container.querySelector('[aria-label="Queued message actions"]')).toBeNull();
		expect(container.querySelector(".queued-turn-editor")).toBeNull();

		await act(async () => button(container, "Guide").click());
		expect(handlers.onSend).toHaveBeenCalledWith(turns[0], "steer");
	});

	it("disables edit and delete while a queued message is sending", async () => {
		const editable = { ...turns[1], state: "queued" as const };
		const sending = { ...turns[0], state: "sending" as const };
		const { container, handlers } = await mount({ running: true, queuedTurns: [editable, sending] });
		const editButtons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Edit queued message"]')];
		expect(editButtons[0]?.disabled).toBe(false);
		expect(editButtons[1]?.disabled).toBe(true);
		expect(container.textContent).toContain("Sending…");
		await act(async () => editButtons[0]!.click());
		expect(handlers.onEdit).toHaveBeenCalledWith(editable);
		await act(async () => button(container, "Delete queued message").click());
		expect(handlers.onDelete).toHaveBeenCalledWith(editable);
	});
});
