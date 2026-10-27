// @vitest-environment jsdom

import type { ClientResult } from "@metis/app-protocol";
import { act, type ComponentProps, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/renderer/components/Composer.tsx";
import { SessionChatView, type SessionChatViewProps } from "../src/renderer/components/SessionChatView.tsx";
import { SessionStatusPanel } from "../src/renderer/components/SessionStatusPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { COMPOSER_EPOCH, COMPOSER_SESSION_ID, composerSnapshot } from "./fixtures/composer-session.ts";

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

async function mount(element: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (next: ReactNode) => {
		await act(async () => root.render(next));
	};
	await render(element);
	return { container, render };
}

function composer(props: Partial<ComponentProps<typeof Composer>> = {}) {
	return (
		<Composer
			disabled={false}
			onInterrupt={async () => undefined}
			onSubmit={vi.fn(async () => undefined)}
			running={false}
			{...props}
		/>
	);
}

function editor(container: ParentNode) {
	return container.querySelector<HTMLElement>('[role="textbox"]')!;
}

function type(input: HTMLElement, text: string) {
	input.textContent = text;
	const range = document.createRange();
	range.selectNodeContents(input);
	range.collapse(false);
	window.getSelection()?.removeAllRanges();
	window.getSelection()?.addRange(range);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(target: EventTarget, value: string) {
	const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

function status(sessionId = COMPOSER_SESSION_ID, tokens = 64_000): ClientResult<"session/status"> {
	return {
		sessionId,
		mode: "chat",
		contextTokens: tokens,
		contextWindow: 128_000,
		contextBasis: "estimated_total",
		contextBreakdown: [{ category: "conversation", tokens }],
		remainingPercent: Math.max(0, 100 - (tokens / 128_000) * 100),
		cacheHitPercent: null,
	};
}

function sessionProps(
	store: AppStore,
	api: Partial<MetisDesktopApi>,
	sessionId = COMPOSER_SESSION_ID,
): SessionChatViewProps {
	return {
		api: api as MetisDesktopApi,
		bootstrapped: false,
		canonicalComposer: sessionId === COMPOSER_SESSION_ID,
		composerFormRef: createRef<HTMLFormElement>(),
		focused: sessionId === COMPOSER_SESSION_ID,
		visible: true,
		sessionId,
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
		onRespond: vi.fn().mockResolvedValue(undefined),
		reducedMotion: false,
		skillCatalogEpoch: 0,
	};
}

function sessionStore(sessionIds = [COMPOSER_SESSION_ID]) {
	const store = new AppStore();
	store.setSupervisor({ state: "ready", serverEpoch: COMPOSER_EPOCH, restartAttempt: 0, failure: null });
	for (const sessionId of sessionIds) {
		const snapshot = composerSnapshot();
		store.applySnapshot(
			composerSnapshot({
				session: { ...snapshot.session, sessionId, state: "idle" },
				activeTurnId: null,
				queuedTurns: [],
				tasks: [],
				goal: null,
			}),
		);
	}
	return store;
}

function ring(container: ParentNode) {
	return container.querySelector<HTMLButtonElement>(".context-usage-ring")!;
}

function controlledPanel(control: HTMLElement) {
	const id = control.getAttribute("aria-controls");
	return id ? document.getElementById(id) : null;
}

describe("composer interaction focus", () => {
	it.each(["interactionPending", "awaitingAnswer"] as const)(
		"defers the latest prefill while %s without changing a draft or stealing another pane's focus",
		async (blockedProp) => {
			const other = await mount(composer({ inputId: "other-composer" }));
			const view = await mount(composer());
			const input = editor(view.container);
			await act(async () => type(input, "My draft"));
			editor(other.container).focus();
			const blocked = { [blockedProp]: true };
			await view.render(composer({ ...blocked, prefillRequest: { id: 1, text: "Old request" } }));
			await view.render(composer({ ...blocked, prefillRequest: { id: 2, text: "Latest request" } }));

			expect(input.textContent).toBe("My draft");
			expect(input.getAttribute("contenteditable")).toBe("false");
			expect(document.activeElement).toBe(editor(other.container));

			await view.render(composer({ prefillRequest: { id: 2, text: "Latest request" } }));
			expect(input.textContent).toBe("My draft\n\nLatest request");
			expect(document.activeElement).toBe(editor(other.container));
			await view.render(composer({ prefillRequest: { id: 2, text: "Latest request" } }));
			expect(input.textContent).toBe("My draft\n\nLatest request");
		},
	);

	it("returns focus to the editor when its own interaction ends", async () => {
		const interaction = <button type="button">Review request</button>;
		const view = await mount(composer({ interactionPending: true, interactionControl: interaction }));
		view.container.querySelector<HTMLButtonElement>(".composer-panels button")!.focus();
		await view.render(composer());
		expect(document.activeElement).toBe(editor(view.container));
	});

	it.each([
		{ interactionPending: true, expected: "Approve or reject the action above to continue." },
		{ awaitingAnswer: true, expected: "Answer the questions above to continue." },
		{ awaitingAnswer: true, interactionPending: true, expected: "Answer the questions above to continue." },
	])(
		"shows the pending action instead of an agent's normal placeholder: $expected",
		async ({ expected, ...pending }) => {
			const view = await mount(composer({ placeholder: "Message this agent", ...pending }));
			expect(editor(view.container).getAttribute("data-placeholder")).toBe(expected);
			await view.render(composer({ placeholder: "Message this agent" }));
			expect(editor(view.container).getAttribute("data-placeholder")).toBe("Message this agent");
		},
	);

	it("releases slash-menu keyboard handling while a human response is pending", async () => {
		const onSlashCommand = vi.fn();
		const view = await mount(composer({ onSlashCommand }));
		const input = editor(view.container);
		input.focus();
		await act(async () => type(input, "/"));
		expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();

		await view.render(
			composer({
				interactionPending: true,
				interactionControl: <button type="button">Review request</button>,
				onSlashCommand,
			}),
		);
		expect(view.container.querySelector('[role="listbox"]')).toBeNull();
		const review = view.container.querySelector<HTMLButtonElement>(".composer-panels button")!;
		review.focus();
		await act(async () => {
			expect(key(review, "Escape").defaultPrevented).toBe(false);
			expect(key(review, "Enter").defaultPrevented).toBe(false);
		});
		expect(onSlashCommand).not.toHaveBeenCalled();
		expect(input.textContent).toBe("/");

		await view.render(composer({ onSlashCommand }));
		expect(view.container.querySelector('[role="listbox"]')).not.toBeNull();
	});
});

describe("context panel interaction lifecycle", () => {
	it("only handles Escape from its own panel and suspends events while closing", async () => {
		const other = await mount(<button type="button">Other pane</button>);
		const otherButton = other.container.querySelector<HTMLButtonElement>("button")!;
		otherButton.focus();
		const onClose = vi.fn();
		const view = await mount(<SessionStatusPanel id="context-a" loading onClose={onClose} />);
		const close = view.container.querySelector<HTMLButtonElement>("button")!;
		expect(document.activeElement).toBe(close);

		otherButton.focus();
		await act(async () => expect(key(otherButton, "Escape").defaultPrevented).toBe(false));
		expect(onClose).not.toHaveBeenCalled();
		close.focus();
		await act(async () => expect(key(close, "Escape").defaultPrevented).toBe(true));
		expect(onClose).toHaveBeenCalledTimes(1);

		await view.render(<SessionStatusPanel closing id="context-a" loading onClose={onClose} />);
		const panel = view.container.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(panel.hasAttribute("inert")).toBe(true);
		expect(panel.getAttribute("aria-hidden")).toBe("true");
		otherButton.focus();
		await act(async () => {
			expect(key(otherButton, "Escape").defaultPrevented).toBe(false);
			otherButton.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		await view.render(<SessionStatusPanel id="context-a" loading onClose={onClose} />);
		expect(panel.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(close);
		await act(async () => key(close, "Escape"));
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it("keeps outside-click focus in the destination pane when the old panel unmounts", async () => {
		const panes = await mount(
			<>
				<button type="button">Open context</button>
				<input aria-label="Other pane draft" />
			</>,
		);
		panes.container.querySelector<HTMLButtonElement>("button")!.focus();
		const onClose = vi.fn();
		const view = await mount(<SessionStatusPanel loading onClose={onClose} />);
		const destination = panes.container.querySelector<HTMLInputElement>("input")!;
		await act(async () => destination.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		destination.focus();
		await view.render(null);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(destination);
	});

	it("does not restore focus into a hidden pane", async () => {
		const previous = await mount(
			<section>
				<button type="button">Open context</button>
			</section>,
		);
		previous.container.querySelector<HTMLButtonElement>("button")!.focus();
		const view = await mount(<SessionStatusPanel loading onClose={vi.fn()} />);
		previous.container.querySelector<HTMLElement>("section")!.hidden = true;
		await view.render(null);
		expect(document.activeElement).toBe(document.body);
	});

	it("binds each session's context ring to its own panel and supports reopening during exit", async () => {
		vi.useFakeTimers();
		const secondId = "33333333-3333-4333-8333-333333333333";
		const store = sessionStore([COMPOSER_SESSION_ID, secondId]);
		const api = { getSessionStatus: vi.fn(async ({ sessionId }: { sessionId: string }) => status(sessionId)) };
		const first = sessionProps(store, api);
		const second = sessionProps(store, api, secondId);
		const view = await mount(
			<>
				<section data-pane="first">
					<SessionChatView {...first} />
				</section>
				<section data-pane="second">
					<SessionChatView {...second} />
				</section>
			</>,
		);
		const firstPane = view.container.querySelector<HTMLElement>('[data-pane="first"]')!;
		const secondPane = view.container.querySelector<HTMLElement>('[data-pane="second"]')!;
		const firstRing = ring(firstPane);
		const secondRing = ring(secondPane);
		expect(firstRing.getAttribute("aria-controls")).not.toBe(secondRing.getAttribute("aria-controls"));
		await act(async () => firstRing.click());
		const firstPanel = controlledPanel(firstRing)!;
		expect(firstPane.contains(firstPanel)).toBe(true);
		expect(firstPanel.querySelector("strong")?.id).toBe(firstPanel.getAttribute("aria-labelledby"));

		await act(async () => secondRing.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		secondRing.focus();
		await act(async () => secondRing.click());
		expect(firstPanel.classList.contains("is-closing")).toBe(true);
		const secondPanel = controlledPanel(secondRing)!;
		expect(secondPane.contains(secondPanel)).toBe(true);
		expect(secondPanel.querySelector("strong")?.id).toBe(secondPanel.getAttribute("aria-labelledby"));
		expect(document.activeElement).toBe(secondPanel.querySelector("button"));

		await act(async () => firstRing.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		firstRing.focus();
		await act(async () => firstRing.click());
		await act(async () => vi.advanceTimersByTime(200));
		expect(controlledPanel(firstRing)).toBe(firstPanel);
		expect(firstPanel.classList.contains("is-closing")).toBe(false);
		expect(firstRing.getAttribute("aria-expanded")).toBe("true");
		expect(controlledPanel(secondRing)).toBeNull();
		expect(document.activeElement).toBe(firstPanel.querySelector("button"));
	});

	it("keeps a closing panel closed when a background status refresh resolves", async () => {
		vi.useFakeTimers();
		const requests: Array<(value: ClientResult<"session/status">) => void> = [];
		const api = {
			getSessionStatus: vi.fn(
				() => new Promise<ClientResult<"session/status">>((resolve) => requests.push(resolve)),
			),
		};
		const props = sessionProps(sessionStore(), api);
		const view = await mount(<SessionChatView {...props} />);
		await act(async () => ring(view.container).click());
		await act(async () => requests.at(-1)!(status()));
		const panel = controlledPanel(ring(view.container))!;
		await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="Close status"]')!.click());
		const previousRequests = requests.length;
		await view.render(<SessionChatView {...props} skillCatalogEpoch={1} />);
		expect(requests).toHaveLength(previousRequests + 1);
		await act(async () => requests.at(-1)!(status(COMPOSER_SESSION_ID, 32_000)));
		expect(ring(view.container).getAttribute("aria-label")).toContain("25%");
		expect(panel.classList.contains("is-closing")).toBe(true);
		expect(panel.hasAttribute("inert")).toBe(true);
		expect(ring(view.container).getAttribute("aria-expanded")).toBe("false");
		await act(async () => vi.advanceTimersByTime(200));
		expect(controlledPanel(ring(view.container))).toBeNull();
	});
});
