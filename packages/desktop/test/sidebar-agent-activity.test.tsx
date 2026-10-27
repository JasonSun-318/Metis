// @vitest-environment jsdom
import type { AgentSummaryView, SessionSummary } from "@metis/app-protocol";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionSidebar } from "../src/renderer/components/SessionSidebar.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

vi.mock("../src/renderer/components/AccountMenu.tsx", () => ({ AccountMenu: () => null }));
const DATE = "2026-10-26T08:00:00Z";
const session: SessionSummary = {
	sessionId: "root",
	mode: "code",
	cwdOrigin: "managed",
	cwd: "/tmp/work",
	name: "Parent task",
	createdAt: DATE,
	updatedAt: DATE,
	state: "idle",
	archived: false,
	unread: true,
	lastTurnOutcome: "completed",
	useMemory: true,
	contributeMemory: true,
};
function child(status: AgentSummaryView["status"]): AgentSummaryView {
	return {
		agentId: "child",
		rootSessionId: "root",
		parentSessionId: "root",
		agentPath: ["child"],
		name: "Child task",
		agentType: "worker",
		depth: 1,
		status,
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: status === "done" ? "2026-10-26T08:00:09Z" : DATE,
	};
}
const roots: Root[] = [];
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	localStorage.setItem("metis.session-grouping.v1", JSON.stringify({ chat: "date", code: "status" }));
	await setLocale("en");
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
});

it("keeps parent activity and status grouping aligned while rows move, without changing execution state", async () => {
	const listeners = new Set<(event: DesktopApiEvent) => void>();
	const api = {
		listAgents: vi.fn().mockResolvedValue({ agents: [child("running")], nextAfterAgentId: null }),
		subscribe: (listener: (event: DesktopApiEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as MetisDesktopApi;
	const store = new AppStore();
	store.setSessions({ sessions: [session], nextAfterSessionId: null });
	const workspace: ComponentProps<typeof SessionSidebar>["workspace"] = {
		busy: false,
		mode: "code",
		newTaskOpen: false,
		onModeChange: vi.fn(),
		onNewTask: vi.fn(),
		onOpen: vi.fn(),
		onDeleteSession: vi.fn(),
		onPinSession: vi.fn(),
		onRenameSession: vi.fn(),
		onCopySessionTitle: vi.fn(),
		onCreateProjectSession: vi.fn(),
		onDeleteProject: vi.fn(),
		onPinProject: vi.fn(),
		onPreviewProjectDelete: vi.fn(),
		onRenameProject: vi.fn(),
		projectBusy: () => false,
		preferences: new Map(),
		pinnedSessionIds: new Set(),
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<SessionSidebar
				state={store.getSnapshot()}
				agentNavigation={{ api, active: null, onOpen: vi.fn() }}
				destination="tasks"
				onSettings={vi.fn()}
				onUpdate={vi.fn()}
				onSkills={vi.fn()}
				onSchedules={vi.fn()}
				onOpenSchedule={vi.fn()}
				onDeleteSchedule={vi.fn()}
				onWidthChange={vi.fn()}
				scheduleTasks={[]}
				selectedScheduleTaskId={null}
				updateState={{ status: "unavailable" }}
				width={302}
				workspace={workspace}
			/>,
		),
	);
	let parent = host.querySelector<HTMLButtonElement>('.session-button[aria-label="Parent task"]')!;
	expect(parent.getAttribute("aria-busy")).toBe("true");
	expect(parent.querySelector("i.running")).not.toBeNull();
	expect(parent.closest("section")?.getAttribute("data-sidebar-motion-key")).toBe("code:status:running");
	expect(api.listAgents).toHaveBeenCalledTimes(1);
	expect(store.getSnapshot().sessionsById.get("root")?.state).toBe("idle");
	expect(store.getSnapshot().activeTurnId).toBeNull();
	const event: DesktopApiEvent = {
		type: "app-server",
		envelope: {
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: "epoch",
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "agent/updated", sessionId: "root", agent: child("done") }],
			},
		},
	};
	await act(async () => {
		for (const listener of listeners) listener(event);
	});
	parent = host.querySelector<HTMLButtonElement>('.session-button[aria-label="Parent task"]')!;
	expect(parent.hasAttribute("aria-busy")).toBe(false);
	expect(parent.querySelector("i.completed")).not.toBeNull();
	expect(parent.closest("section")?.getAttribute("data-sidebar-motion-key")).toBe("code:status:completed");
	expect(api.listAgents).toHaveBeenCalledTimes(1);
	await act(async () => root.unmount());
	roots.pop();
	await Promise.resolve();
	expect(listeners.size).toBe(0);
});
