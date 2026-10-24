// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { SessionWorkspaceView, type WorkspaceProject } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/AgentConversation.tsx", () => ({
	AgentConversation: ({ target }: { target: { agentId: string } }) => (
		<input data-agent-draft={target.agentId} defaultValue="" />
	),
}));
vi.mock("../src/renderer/components/SessionChatView.tsx", () => ({ SessionChatView: () => null }));
vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({
	UniversalFilePreviewer: () => null,
}));

const ALPHA_1 = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const ALPHA_2 = "33333333-3333-4333-8333-333333333333";
const TITLES: Record<string, string> = { [ALPHA_1]: "Alpha one", [BETA]: "Beta", [ALPHA_2]: "Alpha two" };
const PROJECTS: Record<string, WorkspaceProject> = {
	[ALPHA_1]: { key: "/work/alpha", cwd: "/work/alpha", name: "alpha" },
	[ALPHA_2]: { key: "/work/alpha", cwd: "/work/alpha", name: "alpha" },
	[BETA]: { key: "/work/beta", cwd: "/work/beta", name: "beta" },
};

let roots: Root[] = [];

function mount() {
	const api = {
		listBrowserProfiles: vi.fn().mockResolvedValue([]),
		subscribeBrowser: vi.fn(() => () => undefined),
		retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
	} as unknown as MetisDesktopApi;
	const chatView = { api, store: new AppStore() } as unknown as SessionChatViewContext;
	const onChatSession = vi.fn();
	const sessionsById = new Map<
		string,
		ComponentProps<typeof SessionWorkspaceView>["sessionsById"] extends ReadonlyMap<string, infer V> ? V : never
	>([
		[ALPHA_1, { sessionId: ALPHA_1, cwd: "/work/alpha", mode: "code", state: "idle", unread: false }],
		[BETA, { sessionId: BETA, cwd: "/work/beta", mode: "code", state: "running", unread: false }],
		[ALPHA_2, { sessionId: ALPHA_2, cwd: "/work/alpha", mode: "code", state: "idle", unread: false }],
	]);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (props: Partial<ComponentProps<typeof SessionWorkspaceView>>) => {
		await act(async () =>
			root.render(
				<SessionWorkspaceView
					api={api}
					chat={null}
					chatView={chatView}
					chatCwd={null}
					chatFocusRequest={null}
					chatIsDraft={false}
					chatSessionId={ALPHA_1}
					cleanupSessionIds={[]}
					mode="code"
					onActivateSession={vi.fn()}
					onChatSession={onChatSession}
					onCleanupSessionIdsHandled={vi.fn()}
					onDirtySessionIdsChange={vi.fn()}
					onError={vi.fn()}
					onLiveSessionsChange={vi.fn()}
					projectFor={(sessionId) => PROJECTS[sessionId] ?? null}
					sessionsById={sessionsById}
					sessionTitleFor={(sessionId) => TITLES[sessionId] ?? "Task"}
					store={chatView.store}
					theme="dark"
					toolsSidebarOpen={false}
					visible
					{...props}
				/>,
			),
		);
	};
	const tabs = () =>
		[...container.querySelectorAll<HTMLElement>('[role="tab"]')].map(
			(tab) => `${tab.textContent}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`,
		);
	const groups = () => [...container.querySelectorAll(".tool-tab-group-label")].map((label) => label.textContent);
	return { container, onChatSession, render, tabs, groups, sessionsById, api };
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	setLocale("en");
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

describe("workspace tab strip", () => {
	it("opens child tabs without opening the root and keeps their drafts separate", async () => {
		const view = mount();
		await view.render({});
		const child = { sessionId: ALPHA_1, agentId: "child-one", name: "Image task" };
		const sibling = { sessionId: ALPHA_1, agentId: "child-two", name: "Cart task" };
		const onAgentConversationFocus = vi.fn();
		await view.render({ agentFocusRequest: { nonce: 1, target: child }, onAgentConversationFocus });
		expect(view.tabs()).toEqual(["Alpha one", "Image task*"]);
		expect(view.onChatSession).not.toHaveBeenCalled();
		expect(onAgentConversationFocus).toHaveBeenLastCalledWith(child);
		const firstDraft = view.container.querySelector<HTMLInputElement>('[data-agent-draft="child-one"]')!;
		firstDraft.value = "Preserved child draft";
		await view.render({ agentFocusRequest: { nonce: 2, target: sibling }, onAgentConversationFocus });
		expect(view.tabs()).toEqual(["Alpha one", "Image task", "Cart task*"]);
		expect(view.container.querySelector<HTMLInputElement>('[data-agent-draft="child-two"]')!.value).toBe("");
		await view.render({ agentFocusRequest: { nonce: 3, target: child }, onAgentConversationFocus });
		expect(view.container.querySelector<HTMLInputElement>('[data-agent-draft="child-one"]')).toBe(firstDraft);
		expect(firstDraft.value).toBe("Preserved child draft");
		expect(view.api.retainWorkspaceSessions).toHaveBeenLastCalledWith(
			expect.objectContaining({ liveSessionIds: [] }),
		);
	});
	it("keeps a child focused when an unrelated root projection changes", async () => {
		const view = mount();
		await view.render({});
		await view.render({
			agentFocusRequest: { nonce: 1, target: { sessionId: ALPHA_1, agentId: "child", name: "Child task" } },
		});
		await view.render({ chatSessionId: BETA });
		expect(view.tabs()).toContain("Child task*");
		expect(view.tabs()).not.toContain("Beta*");
	});

	it("uses each session's mode for active and inactive conversation icons", async () => {
		const view = mount();
		const sessions = new Map(view.sessionsById);
		sessions.set(ALPHA_1, { ...sessions.get(ALPHA_1)!, mode: "chat" });
		await view.render({ sessionsById: sessions, chatSessionId: ALPHA_1 });
		await view.render({ sessionsById: sessions, chatSessionId: BETA });
		const chatIcon = view.container.querySelector('[role="tab"][aria-label="Alpha one"] > svg')!;
		const codeIcon = view.container.querySelector('[role="tab"][aria-label="Beta"] > svg')!;
		expect(chatIcon.getAttribute("data-mode")).toBe("chat");
		expect(codeIcon.getAttribute("data-mode")).toBe("code");
		expect(chatIcon.innerHTML).not.toBe(codeIcon.innerHTML);
		expect(chatIcon.getAttribute("width")).toBe("13");
		expect(codeIcon.getAttribute("width")).toBe("13");
	});

	it("updates the new task icon with its mode without changing existing session icons", async () => {
		const view = mount();
		await view.render({});
		await view.render({ chatSessionId: null, chatIsDraft: true, mode: "chat" });
		const draftIcon = () => view.container.querySelector('[role="tab"][aria-label="New task"] > svg')!;
		expect(draftIcon().getAttribute("data-mode")).toBe("chat");
		expect(
			view.container.querySelector('[role="tab"][aria-label="Alpha one"] > svg')?.getAttribute("data-mode"),
		).toBe("code");
		await view.render({ chatSessionId: null, chatIsDraft: true, mode: "code" });
		expect(draftIcon().getAttribute("data-mode")).toBe("code");
	});

	it("uses the workspace mode while a session summary is unavailable", async () => {
		const view = mount();
		await view.render({ sessionsById: new Map(), mode: "code" });
		expect(view.container.querySelector('[role="tab"] > svg')?.getAttribute("data-mode")).toBe("code");
	});

	it("groups tabs by project and keeps a project's tabs together", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_2 });

		// Alpha two opens last but joins alpha's group instead of trailing beta.
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two*", "Beta"]);
		expect(view.groups()).toEqual(["alpha", "beta"]);
		expect(view.container.querySelector(".tool-tab-group-label")?.getAttribute("title")).toBe("/work/alpha");
		expect(view.container.querySelectorAll(".tool-tab-group-body")).toHaveLength(2);
	});

	it("shows no project labels while a pane holds a single project", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: ALPHA_2 });
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two*"]);
		expect(view.groups()).toEqual([]);
		expect(view.container.querySelector('[role="tab"]')?.getAttribute("title")).toBe("Alpha one\n/work/alpha");
	});

	it("collapses and expands a project group from its label", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_2 });
		const label = (name: string) =>
			[...view.container.querySelectorAll<HTMLButtonElement>(".tool-tab-group-label")].find((candidate) =>
				candidate.textContent?.startsWith(name),
			)!;
		expect(label("alpha").tagName).toBe("BUTTON");
		expect(label("alpha").getAttribute("aria-expanded")).toBe("true");
		expect(label("alpha").getAttribute("aria-label")).toBe("alpha tab group");

		// Collapsing the active tab's group hands focus to the nearest tab outside it.
		await act(async () => label("alpha").click());
		expect(view.tabs()).toEqual(["Beta*"]);
		expect(label("alpha").getAttribute("aria-expanded")).toBe("false");
		expect(label("alpha").getAttribute("aria-description")).toBe("2 tabs hidden");
		expect(label("alpha").textContent).toBe("alpha2");
		expect(view.onChatSession).toHaveBeenLastCalledWith(BETA);

		await act(async () => label("alpha").click());
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two", "Beta*"]);
		expect(label("alpha").getAttribute("aria-expanded")).toBe("true");
	});

	it("skips collapsed tabs when cycling and reopens a group whose tab is focused", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_2 });
		const betaLabel = () =>
			[...view.container.querySelectorAll<HTMLButtonElement>(".tool-tab-group-label")].find((candidate) =>
				candidate.textContent?.startsWith("beta"),
			)!;
		await act(async () => betaLabel().click());
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two*"]);

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }));
		});
		expect(view.tabs()).toEqual(["Alpha one*", "Alpha two"]);

		// Opening a session whose tab is folded away expands its group.
		await view.render({ chatSessionId: BETA, chatFocusRequest: { nonce: 1, sessionId: BETA } });
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two", "Beta*"]);
		expect(betaLabel().getAttribute("aria-expanded")).toBe("true");
	});

	it("slides one shared underline under the active tab", async () => {
		// jsdom has no layout; give each tab a deterministic rect by position.
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const tabs = [...(this.parentElement?.children ?? [])].filter((el) => el.classList.contains("tool-tab"));
			const index = Math.max(0, tabs.indexOf(this));
			const left = this.classList.contains("tool-tab") ? index * 100 : 0;
			const width = this.classList.contains("tool-tab") ? 100 : 1000;
			return {
				x: left,
				y: 0,
				top: 0,
				left,
				right: left + width,
				bottom: 0,
				width,
				height: 0,
				toJSON: () => ({}),
			} as DOMRect;
		});
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: ALPHA_2 });
		expect(view.container.querySelectorAll(".tool-tab-indicator")).toHaveLength(1);
		const indicator = view.container.querySelector<HTMLElement>(".tool-tab-indicator")!;
		expect(indicator.classList.contains("is-set")).toBe(true);
		expect(indicator.style.width).toBe("80px");
		expect(indicator.style.transform).toBe("translateX(110px)");

		// Selecting another tab retargets the same element instead of drawing a new one.
		const firstTab = view.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Alpha one"]')!;
		await act(async () => firstTab.click());
		expect(indicator.style.transform).toBe("translateX(10px)");
	});

	it("scrolls the strip sideways on the wheel instead of shrinking tabs", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: ALPHA_2 });
		const scroll = view.container.querySelector<HTMLElement>(".tool-tabs-scroll")!;
		await act(async () =>
			scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true })),
		);
		expect(scroll.scrollLeft).toBe(40);
		// A mostly-horizontal wheel gestures scrolls natively, untouched.
		await act(async () =>
			scroll.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 5, bubbles: true, cancelable: true })),
		);
		expect(scroll.scrollLeft).toBe(40);
	});

	it("shows a running session's live status on its tab", async () => {
		const view = mount();
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_1 });
		const betaTab = [...view.container.querySelectorAll<HTMLElement>(".tool-tab")].find((tab) =>
			tab.textContent?.includes("Beta"),
		)!;
		expect(betaTab.querySelector(".tool-tab-status")?.getAttribute("data-status")).toBe("running");
		expect(betaTab.querySelector('[role="tab"]')?.getAttribute("aria-label")).toBe("Beta");
		expect(betaTab.querySelector('[role="tab"]')?.getAttribute("aria-description")).toBe("Running");
	});

	it("closes the focused tab when the close shortcut arrives", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		expect(view.tabs()).toEqual(["Alpha one", "Beta*"]);

		await view.render({ chatSessionId: BETA, closeTabRequest: 1 });
		expect(view.tabs()).toEqual(["Alpha one*"]);
		// Re-rendering with the same request does not close another tab.
		await view.render({ chatSessionId: ALPHA_1, closeTabRequest: 1 });
		expect(view.tabs()).toEqual(["Alpha one*"]);
	});

	it("cycles the focused pane's tabs with Ctrl+Tab and Ctrl+Shift+Tab", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		expect(view.tabs()).toEqual(["Alpha one", "Beta*"]);

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }));
		});
		expect(view.tabs()).toEqual(["Alpha one*", "Beta"]);
		expect(view.onChatSession).toHaveBeenLastCalledWith(ALPHA_1);

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true }),
			);
		});
		expect(view.tabs()).toEqual(["Alpha one", "Beta*"]);
	});

	it("focuses a pane when the user works inside it", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 1200,
			bottom: 800,
			width: 1200,
			height: 800,
			toJSON: () => ({}),
		});
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		const betaTab = [...view.container.querySelectorAll<HTMLElement>(".tool-tab")].find((tab) =>
			tab.textContent?.includes("Beta"),
		)!;
		await act(async () =>
			betaTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })),
		);
		const split = [...view.container.querySelectorAll<HTMLButtonElement>(".workspace-tab-menu button")].find(
			(button) => button.textContent === "Split right",
		)!;
		await act(async () => split.click());
		const strips = () => [...view.container.querySelectorAll<HTMLElement>(".workspace-tabbar[data-pane-id]")];
		expect(strips().map((strip) => strip.classList.contains("is-focused"))).toEqual([false, true]);

		const alphaPaneId = strips()[0]!.dataset.paneId!;
		const alphaPanel = view.container.querySelector<HTMLElement>(`.workspace-panel[data-pane-id="${alphaPaneId}"]`)!;
		await act(async () => alphaPanel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		expect(strips().map((strip) => strip.classList.contains("is-focused"))).toEqual([true, false]);
		expect(view.onChatSession).toHaveBeenLastCalledWith(ALPHA_1);
	});

	it("brings a covered conversation forward once when it asks for approval", async () => {
		const view = mount();
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_1 });
		expect(view.tabs()).toEqual(["Beta", "Alpha one*"]);

		const approval = [{ interactionId: "approval-1", sessionId: BETA }];
		await view.render({ chatSessionId: ALPHA_1, inlineInteractions: approval });
		expect(view.tabs()).toEqual(["Beta*", "Alpha one"]);

		// The user may switch away again; the same pending request does not pull the tab back.
		const alphaTab = view.container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Alpha one"]')!;
		await act(async () => alphaTab.click());
		await view.render({ chatSessionId: ALPHA_1, inlineInteractions: [...approval] });
		expect(view.tabs()).toEqual(["Beta", "Alpha one*"]);
	});

	it("puts the add button right after the tabs and leaves the rest of the strip empty", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		const strip = view.container.querySelector<HTMLElement>(".workspace-tabbar")!;
		expect([...strip.children].map((child) => child.className)).toEqual([
			"tool-tabs-scroll",
			"tool-add",
			"workspace-tabbar-fill",
		]);
	});
});
