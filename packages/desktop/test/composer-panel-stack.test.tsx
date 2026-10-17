// @vitest-environment jsdom

import type { SessionSnapshot } from "@metis/app-protocol";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionChatView, type SessionChatViewProps } from "../src/renderer/components/SessionChatView.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	COMPOSER_EPOCH,
	COMPOSER_SESSION_ID,
	composerInteraction,
	composerSnapshot,
} from "./fixtures/composer-session.ts";

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.useRealTimers();
});

async function mount(initial = composerSnapshot()) {
	const store = new AppStore();
	store.setSupervisor({ state: "ready", serverEpoch: COMPOSER_EPOCH, restartAttempt: 0, failure: null });
	store.applySnapshot(initial);
	const api = {
		queueTurn: vi.fn().mockResolvedValue({}),
		startTurn: vi.fn().mockResolvedValue({}),
		sendQueuedTurn: vi.fn().mockResolvedValue({}),
		deleteQueuedTurn: vi.fn().mockResolvedValue({}),
	};
	const onRespond = vi.fn().mockResolvedValue(undefined);
	const props: SessionChatViewProps = {
		api: api as unknown as MetisDesktopApi,
		bootstrapped: false,
		canonicalComposer: true,
		composerFormRef: createRef<HTMLFormElement>(),
		focused: true,
		visible: true,
		sessionId: COMPOSER_SESSION_ID,
		store,
		registerSubmit: vi.fn(),
		unregisterSubmit: vi.fn(),
		onChangeModel: vi.fn().mockResolvedValue(undefined),
		onChangePermissionPreset: vi.fn().mockResolvedValue(undefined),
		onChangeThinking: vi.fn().mockResolvedValue(undefined),
		onClearError: vi.fn(),
		onError: vi.fn(),
		onFork: vi.fn(),
		onManageMcp: vi.fn(),
		onManageSkills: vi.fn(),
		onNotice: vi.fn(),
		onOpenKnowledge: vi.fn(),
		onOpenPlan: vi.fn(),
		onPickFiles: vi.fn().mockResolvedValue([]),
		onPreviewDeliveredFile: vi.fn(),
		onResolveDroppedFiles: vi.fn().mockReturnValue([]),
		onRespond,
		reducedMotion: true,
		skillCatalogEpoch: 0,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<SessionChatView {...props} />));
	let cursor = 0;
	const update = async (overrides: Partial<SessionSnapshot>) => {
		await act(async () => store.applySnapshot(composerSnapshot({ ...overrides, cursor: ++cursor })));
	};
	return { container, api, onRespond, update };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

describe("session composer panel stack", () => {
	it("keeps AskUser answers and the input lock when the question panel is folded", async () => {
		const { container, onRespond } = await mount(
			composerSnapshot({ pendingInteractions: [composerInteraction("ask_user")] }),
		);
		const option = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
		await act(async () => option.click());
		await act(async () => button(container, "Collapse questions").click());
		expect(container.querySelector(".ask-user-resume")).not.toBeNull();
		expect(container.querySelector("#composer-input")?.getAttribute("contenteditable")).toBe("false");
		expect(onRespond).not.toHaveBeenCalled();
		const resume = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(control) => control.textContent === "Continue answering",
		)!;
		await act(async () => resume.click());
		expect(container.querySelector('[role="radio"]')?.getAttribute("aria-checked")).toBe("true");
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("removes a completed task panel after its exit animation while the other panels stay mounted", async () => {
		vi.useFakeTimers();
		const { container, update } = await mount();
		const goal = container.querySelector(".goal-bar-slot");
		const editor = container.querySelector("#composer-input");
		await update({ tasks: composerSnapshot().tasks.map((task) => ({ ...task, completed: true })) });
		await act(async () => vi.advanceTimersByTime(450));
		expect(container.querySelector(".task-list-slot.is-closing")).not.toBeNull();
		await act(async () => vi.advanceTimersByTime(200));
		expect(container.querySelector(".task-list-slot")).toBeNull();
		expect(container.querySelector(".composer-panels")?.firstElementChild).toBe(goal);
		expect(container.querySelector("#composer-input")).toBe(editor);
	});

	it("groups simultaneous panels into one surface with the pending approval nearest the input", async () => {
		const { container } = await mount(
			composerSnapshot({ pendingInteractions: [composerInteraction("session_permission_approval")] }),
		);
		const panels = container.querySelector(".composer-surface .composer-panels");
		expect(panels).not.toBeNull();
		expect([...panels!.children].map((child) => child.className)).toEqual([
			"task-list-slot",
			"goal-bar-slot",
			"queued-turn-list",
			"permission-approval-slot",
		]);
		expect(container.querySelectorAll(".permission-approval-panel")).toHaveLength(1);
	});

	it.each(["ask_user", "session_permission_approval"] as const)(
		"keeps drafts and locks input and queued actions during %s, then restores them",
		async (kind) => {
			const { container, api, update } = await mount();
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => {
				editor.textContent = "draft to keep";
				editor.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await update({ pendingInteractions: [composerInteraction(kind)] });
			expect(editor.getAttribute("contenteditable")).toBe("false");
			expect(editor.textContent).toBe("draft to keep");
			const queuedButtons = [...container.querySelectorAll<HTMLButtonElement>(".queued-turn-actions button")];
			expect(queuedButtons).toHaveLength(3);
			expect(queuedButtons.every((control) => control.disabled)).toBe(true);
			await act(async () => {
				for (const control of queuedButtons) control.click();
				container.querySelector<HTMLFormElement>("form.composer")!.requestSubmit();
			});
			expect(api.queueTurn).not.toHaveBeenCalled();
			expect(api.sendQueuedTurn).not.toHaveBeenCalled();
			expect(api.deleteQueuedTurn).not.toHaveBeenCalled();
			await update({ pendingInteractions: [] });
			expect(editor.getAttribute("contenteditable")).toBe("true");
			expect(editor.textContent).toBe("draft to keep");
			expect(queuedButtons.every((control) => !control.disabled)).toBe(true);
			await act(async () => button(container, "Guide with queued message").click());
			expect(api.sendQueuedTurn).toHaveBeenCalledWith(
				expect.objectContaining({ queueItemId: "queued-1", delivery: "steer" }),
			);
		},
	);

	it("keeps a collapsed approval pending and expands a replacement request", async () => {
		const interaction = composerInteraction("session_permission_approval");
		const { container, onRespond, update } = await mount(composerSnapshot({ pendingInteractions: [interaction] }));
		await act(async () => button(container, "Collapse approval").click());
		expect(onRespond).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLElement>(".permission-approval-body")?.hidden).toBe(true);
		expect(container.querySelector(".permission-approval-body")?.hasAttribute("inert")).toBe(true);
		expect(container.querySelector("#composer-input")?.getAttribute("contenteditable")).toBe("false");
		await update({ pendingInteractions: [{ ...interaction, interactionId: "approval-2", title: "New request" }] });
		expect(container.querySelector<HTMLElement>(".permission-approval-body")?.hidden).toBe(false);
		expect(onRespond).not.toHaveBeenCalled();
	});

	it("folds the queue without sending or deleting it and keeps it folded across updates", async () => {
		const { container, api, update } = await mount();
		await act(async () => button(container, "Collapse queued messages").click());
		expect(container.querySelector<HTMLElement>(".queued-turn-body")?.hidden).toBe(true);
		expect(container.querySelector(".queued-turn-body")?.hasAttribute("inert")).toBe(true);
		await update({
			queuedTurns: [
				...composerSnapshot().queuedTurns,
				{
					queueItemId: "queued-2",
					revision: "revision-2",
					state: "queued",
					text: "Second message",
					attachments: [],
				},
			],
		});
		expect(container.querySelector<HTMLElement>(".queued-turn-body")?.hidden).toBe(true);
		expect(container.querySelector(".queued-turn-count")?.textContent).toBe("2");
		await act(async () => button(container, "Expand queued messages").click());
		expect(container.querySelectorAll(".queued-turn-row")).toHaveLength(2);
		expect(api.sendQueuedTurn).not.toHaveBeenCalled();
		expect(api.deleteQueuedTurn).not.toHaveBeenCalled();
	});

	it("removes empty panels without remounting the composer", async () => {
		const { container, update } = await mount();
		const editor = container.querySelector("#composer-input");
		await update({ queuedTurns: [], tasks: [], goal: null });
		expect(container.querySelector(".composer-panels")?.childElementCount).toBe(0);
		expect(container.querySelector("#composer-input")).toBe(editor);
	});
});
