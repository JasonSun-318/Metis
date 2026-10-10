// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChatViewContext } from "../src/renderer/components/SessionChatView.tsx";
import { SessionWorkspaceView, type WorkspaceProject } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/SessionChatView.tsx", () => ({ SessionChatView: () => null }));
vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({ UniversalFilePreviewer: () => null }));

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
	const sessionsById = new Map<string, ComponentProps<typeof SessionWorkspaceView>["sessionsById"] extends ReadonlyMap<string, infer V> ? V : never>([
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
	return { container, onChatSession, render, tabs, groups };
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
	it("groups tabs by project and keeps a project's tabs together", async () => {
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		await view.render({ chatSessionId: ALPHA_2 });

		// Alpha two opens last but joins alpha's group instead of trailing beta.
		expect(view.tabs()).toEqual(["Alpha one", "Alpha two*", "Beta"]);
		expect(view.groups()).toEqual(["alpha", "beta"]);
		expect(view.container.querySelector(".tool-tab-group-label")?.getAttribute("title")).toBe("/work/alpha");
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
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true }));
		});
		expect(view.tabs()).toEqual(["Alpha one", "Beta*"]);
	});

	it("focuses a pane when the user works inside it", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}),
		});
		const view = mount();
		await view.render({ chatSessionId: ALPHA_1 });
		await view.render({ chatSessionId: BETA });
		const betaTab = [...view.container.querySelectorAll<HTMLElement>(".tool-tab")].find((tab) =>
			tab.textContent?.includes("Beta"),
		)!;
		await act(async () => betaTab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
		const split = [...view.container.querySelectorAll<HTMLButtonElement>(".workspace-tab-menu button")].find(
			(button) => button.textContent === "Split right",
		)!;
		await act(async () => split.click());
		const strips = () => [...view.container.querySelectorAll<HTMLElement>(".workspace-tabbar")];
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
