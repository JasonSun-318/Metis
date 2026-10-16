// @vitest-environment jsdom

import type { PlanView } from "@metis/app-protocol";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspaceView } from "../src/renderer/components/SessionWorkspace.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/SessionChatView.tsx", () => ({
	SessionChatView: () => <input aria-label="Chat input" />,
}));
vi.mock("../src/renderer/components/TerminalPanel.tsx", () => ({
	TerminalPanel: ({ terminalId, visible }: { terminalId: string; visible: boolean }) => (
		<div className={`terminal-panel${visible ? " is-visible" : ""}`} data-terminal-id={terminalId}>
			<input aria-label="Terminal input" />
		</div>
	),
}));
vi.mock("../src/renderer/components/BrowserPanel.tsx", () => ({
	BrowserPanel: ({
		browserId,
		visible,
		covered,
		startPageTools,
	}: {
		browserId: string;
		visible: boolean;
		covered?: boolean;
		startPageTools?: ReactNode;
	}) => (
		<div className="browser-panel" data-browser-id={browserId} data-visible={visible} data-covered={covered}>
			{startPageTools}
		</div>
	),
}));
vi.mock("../src/renderer/components/KnowledgePanel.tsx", () => ({
	KnowledgePanel: () => <div>Knowledge content</div>,
}));
vi.mock("../src/renderer/components/PlanPreview.tsx", () => ({
	PlanPreview: ({ plan }: { plan: PlanView }) => <div>{plan.markdown}</div>,
}));
vi.mock("../src/renderer/components/preview/UniversalFilePreviewer.tsx", () => ({
	UniversalFilePreviewer: () => <div>File preview</div>,
}));

type WorkspaceProps = ComponentProps<typeof SessionWorkspaceView>;
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const plan: PlanView = {
	planId: "plan-1",
	revision: 1,
	title: "Original plan",
	markdown: "Original content",
	status: "proposed",
	createdAt: "2026-10-13T00:00:00.000Z",
};
let roots: Root[] = [];

function button(root: ParentNode, label: string): HTMLButtonElement {
	const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function mount() {
	const api = {
		listBrowserProfiles: vi.fn().mockResolvedValue([]),
		subscribeBrowser: vi.fn(() => () => undefined),
		retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
		closeTerminal: vi.fn().mockResolvedValue(undefined),
		closeBrowser: vi.fn().mockResolvedValue(undefined),
	} as unknown as MetisDesktopApi;
	const container = document.createElement("div");
	const chatSlot = document.createElement("div");
	const toolsSlot = document.createElement("div");
	document.body.append(container, chatSlot, toolsSlot);
	const root = createRoot(container);
	roots.push(root);
	const store = new AppStore();
	const onToolsSidebarOpenChange = vi.fn();
	let props: WorkspaceProps = {
		api,
		chat: null,
		chatCwd: "/work/one",
		chatFocusRequest: null,
		chatIsDraft: false,
		chatSessionId: SESSION,
		cleanupSessionIds: [],
		mode: "code",
		onActivateSession: vi.fn(),
		onChatSession: vi.fn(),
		onCleanupSessionIdsHandled: vi.fn(),
		onDirtySessionIdsChange: vi.fn(),
		onError: vi.fn(),
		onLiveSessionsChange: vi.fn(),
		chatView: { api, store } as WorkspaceProps["chatView"],
		sessionsById: new Map([
			[SESSION, { sessionId: SESSION, cwd: "/work/one", mode: "code" }],
			[OTHER, { sessionId: OTHER, cwd: "/work/two", mode: "code" }],
		]),
		sessionTitleFor: (id) => (id === SESSION ? "One" : "Two"),
		store,
		theme: "dark",
		visible: true,
		toolsSidebarOpen: true,
		titlebarTabsSlot: chatSlot,
		titlebarToolsSlot: toolsSlot,
		onToolsSidebarOpenChange,
	};
	const render = async (next: Partial<WorkspaceProps> = {}) => {
		props = { ...props, ...next };
		await act(async () => root.render(<SessionWorkspaceView {...props} />));
	};
	const addTerminal = async () => {
		await act(async () => button(container.querySelector(".tool-sidebar-menu")!, "Terminal").click());
		return container.querySelector<HTMLElement>(".terminal-panel")!.dataset.terminalId!;
	};
	return { api, container, chatSlot, toolsSlot, onToolsSidebarOpenChange, render, addTerminal };
}

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	await setLocale("en");
});
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("per-session tools sidebar", () => {
	it("uses the chat space left beside the sidebar when checking a split", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 1000,
			bottom: 800,
			width: 1000,
			height: 800,
			toJSON: () => ({}),
		});
		const view = mount();
		await view.render({ toolsSidebarWidth: 393 });
		await act(async () =>
			button(view.chatSlot, "One")
				.closest(".tool-tab")!
				.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
		);
		expect(button(view.container, "Split right").disabled).toBe(true);
		expect(button(view.container, "Split right").title).toBe("Not enough room to split");
		await view.render({ toolsSidebarOpen: false });
		expect(button(view.container, "Split right").disabled).toBe(false);
	});

	it("opens a new browser tab with tools and makes the plus button create another tab", async () => {
		const view = mount();
		await view.render();
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(button(view.toolsSlot, "New tab")).toBeDefined();
		expect(view.container.querySelector(".tool-sidebar-menu")).not.toBeNull();
		await act(async () => button(view.toolsSlot, "New browser tab").click());
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(document.querySelector(".tool-add-menu")).toBeNull();
	});

	it("returns to a new browser tab after the last tool tab is closed", async () => {
		const view = mount();
		await view.render();
		const original = view.container.querySelector<HTMLElement>(".browser-panel")!.dataset.browserId;
		await act(async () => button(view.toolsSlot, "Close New tab").click());
		expect(view.api.closeBrowser).toHaveBeenCalledWith({ sessionId: SESSION, browserId: original });
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(view.container.querySelector<HTMLElement>(".browser-panel")!.dataset.browserId).not.toBe(original);
	});

	it("retains each session's browser and tool tabs when switching between sessions", async () => {
		const view = mount();
		await view.render();
		const terminalId = await view.addTerminal();
		await view.render({ chatSessionId: OTHER, chatCwd: "/work/two" });
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(button(view.toolsSlot, "New tab")).toBeDefined();
		await view.render({ chatSessionId: SESSION, chatCwd: "/work/one" });
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(view.container.querySelector<HTMLElement>(".terminal-panel")!.dataset.terminalId).toBe(terminalId);
		expect(view.api.closeTerminal).not.toHaveBeenCalled();
	});

	it("cycles the tools strip when keyboard focus is in the sidebar", async () => {
		const view = mount();
		await view.render();
		await view.addTerminal();
		await act(async () => button(view.toolsSlot, "Terminal").focus());
		await act(async () =>
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true })),
		);
		expect(button(view.toolsSlot, "New tab").getAttribute("aria-selected")).toBe("true");
		await act(async () =>
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey: true, bubbles: true }),
			),
		);
		expect(button(view.toolsSlot, "Terminal").getAttribute("aria-selected")).toBe("true");
	});
	it("closes the tool selected with keyboard focus in the titlebar", async () => {
		const view = mount();
		await view.render();
		const terminalId = await view.addTerminal();
		await act(async () => button(view.chatSlot, "One").focus());
		await act(async () => button(view.toolsSlot, "Terminal").focus());
		await view.render({ closeTabRequest: 1 });
		expect(view.api.closeTerminal).toHaveBeenCalledWith({ terminalId });
		expect(view.chatSlot.querySelector('[role="tab"][aria-label="One"]')).not.toBeNull();
	});

	it("closes the chat after returning from a tool to its titlebar tab", async () => {
		const view = mount();
		await view.render();
		await view.addTerminal();
		await act(async () =>
			view.container
				.querySelector(".tool-sidebar")!
				.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
		);
		await act(async () => button(view.chatSlot, "One").click());
		await view.render({ closeTabRequest: 1 });
		expect(view.api.closeTerminal).not.toHaveBeenCalled();
		expect(view.container.querySelector(".terminal-panel")).not.toBeNull();
	});

	it("does not close a hidden tool after the sidebar is collapsed", async () => {
		const view = mount();
		await view.render();
		await view.addTerminal();
		await act(async () =>
			view.container
				.querySelector(".tool-sidebar")!
				.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
		);
		await view.render({ toolsSidebarOpen: false });
		await view.render({ closeTabRequest: 1 });
		expect(view.api.closeTerminal).not.toHaveBeenCalled();
	});

	it("reveals an existing preview again without creating another tab", async () => {
		const view = mount();
		const preview = { source: "delivered" as const, sessionId: SESSION, fileId: "file-1", name: "Report.pdf" };
		await view.render({ previewRequest: preview });
		view.onToolsSidebarOpenChange.mockClear();
		await view.render({ toolsSidebarOpen: false, previewRequest: { ...preview } });
		expect(view.onToolsSidebarOpenChange).toHaveBeenLastCalledWith(true);
		expect(view.container.querySelectorAll(".preview-panel")).toHaveLength(1);
	});

	it("reveals an existing knowledge tab on an explicit request", async () => {
		const view = mount();
		await view.render({ knowledgeRequest: { id: 1, sessionId: SESSION } });
		view.onToolsSidebarOpenChange.mockClear();
		await view.render({ toolsSidebarOpen: false, knowledgeRequest: { id: 2, sessionId: SESSION } });
		expect(view.onToolsSidebarOpenChange).toHaveBeenLastCalledWith(true);
		expect(view.container.textContent?.match(/Knowledge content/g)).toHaveLength(1);
	});

	it("updates and reveals a revised plan in its existing tool tab", async () => {
		const view = mount();
		await view.render({ planPreviewRequest: { sessionId: SESSION, plan } });
		view.onToolsSidebarOpenChange.mockClear();
		await view.render({
			toolsSidebarOpen: false,
			planPreviewRequest: {
				sessionId: SESSION,
				plan: { ...plan, revision: 2, title: "Revised plan", markdown: "Revised content" },
			},
		});
		expect(view.onToolsSidebarOpenChange).toHaveBeenLastCalledWith(true);
		expect(view.container.textContent).toContain("Revised content");
		expect(view.container.textContent).not.toContain("Original content");
		await view.render({ toolsSidebarOpen: true });
		expect(view.toolsSlot.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(button(view.toolsSlot, "Revised plan")).toBeDefined();
	});

	it("retains terminal state across closing and reopening the sidebar", async () => {
		const view = mount();
		await view.render();
		await view.addTerminal();
		const terminal = view.container.querySelector(".terminal-panel");
		await view.render({ toolsSidebarOpen: false });
		expect(view.container.querySelector(".terminal-panel")).toBe(terminal);
		expect(view.container.querySelector<HTMLElement>(".tool-sidebar")?.hidden).toBe(true);
		await view.render({ toolsSidebarOpen: true });
		expect(view.container.querySelector(".terminal-panel")).toBe(terminal);
		expect(view.api.closeTerminal).not.toHaveBeenCalled();
	});

	it("keeps the current terminal visible behind its tab context menu", async () => {
		const view = mount();
		await view.render();
		await view.addTerminal();
		await act(async () =>
			button(view.toolsSlot, "Terminal").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
		);
		expect(document.querySelector(".workspace-tab-menu")).not.toBeNull();
		expect(
			view.container.querySelector<HTMLElement>(".terminal-panel")?.closest<HTMLElement>(".tool-sidebar-panel")
				?.hidden,
		).toBe(false);
		expect(view.container.querySelector(".terminal-panel.is-visible")).not.toBeNull();
	});
});
