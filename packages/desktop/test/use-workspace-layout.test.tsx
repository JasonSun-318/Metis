// @vitest-environment jsdom

import type { SessionSummary } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "../src/renderer/store/app-store.ts";
import { useWorkspaceLayout } from "../src/renderer/use-workspace-layout.ts";
import {
	restoreWorkspaceLayout,
	serializeWorkspaceLayout,
	WORKSPACE_LAYOUT_STORAGE_KEY,
} from "../src/renderer/workspace-layout-storage.ts";
import { type ChatTab, type SessionWorkspace, setPaneWeights, type ToolStrip } from "../src/renderer/workspace-tabs.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const DATE = "2026-10-25T00:00:00.000Z";
function session(sessionId: string): SessionSummary {
	return {
		sessionId,
		mode: "chat",
		cwdOrigin: "managed",
		cwd: `/fixture/${sessionId}`,
		createdAt: DATE,
		updatedAt: DATE,
		state: "idle",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
	};
}
function layout(...sessionIds: string[]): SessionWorkspace {
	return {
		panes: sessionIds.map((sessionId, index) => {
			const tab: ChatTab = { kind: "chat", id: `tab-${index}`, sessionId };
			return { id: `pane-${index + 1}`, row: 0, weight: index + 1, tabs: [tab], activeId: tab.id };
		}),
		activePaneId: "pane-1",
		nextNumber: sessionIds.length,
		tools: new Map(),
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function saved(workspace: SessionWorkspace) {
	const raw = serializeWorkspaceLayout(workspace);
	localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, raw);
	return raw;
}
function references(workspace: SessionWorkspace) {
	return workspace.panes.flatMap((pane) => pane.tabs.map((tab) => tab.sessionId));
}
const roots: Root[] = [];
const hosts: HTMLElement[] = [];
type HookOptions = Parameters<typeof useWorkspaceLayout>[0];
type HookState = ReturnType<typeof useWorkspaceLayout>;
async function mount(options: Partial<HookOptions> = {}) {
	const upsertSession = vi.fn();
	const metadataCalls: string[] = [];
	const metadataApi = new Proxy(options.api ?? {}, {
		get(target, name, receiver) {
			metadataCalls.push(String(name));
			if (name !== "listSessions" && name !== "listAgents")
				throw new Error(`Unexpected runtime API: ${String(name)}`);
			return Reflect.get(target, name, receiver);
		},
	}) as MetisDesktopApi;
	let props: HookOptions = {
		sessionsById: new Map([["current", session("current")]]),
		chatSessionId: "current",
		store: { upsertSession } as unknown as AppStore,
		...options,
		api: metadataApi,
	};
	let current!: HookState;
	function Harness() {
		current = useWorkspaceLayout(props);
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => root.render(<Harness />));
	return {
		get state() {
			return current;
		},
		upsertSession,
		metadataCalls,
		async change(action: (state: HookState) => void) {
			await act(async () => action(current));
		},
		async rerender(change: Partial<HookOptions>) {
			props = { ...props, ...change };
			await act(async () => root.render(<Harness />));
		},
	};
}
beforeEach(() => localStorage.clear());
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	for (const host of hosts.splice(0)) host.remove();
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("useWorkspaceLayout", () => {
	it("seeds the projected conversation without metadata or runtime actions", async () => {
		const result = await mount();
		expect(references(result.state.workspace)).toEqual(["current"]);
		expect(result.metadataCalls).toEqual([]);
		expect(result.upsertSession).not.toHaveBeenCalled();
		expect(
			restoreWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), () => true)?.panes,
		).toHaveLength(1);
	});
	it("restores known roots immediately and focuses the current conversation", async () => {
		saved(layout("first", "current"));
		const result = await mount({
			sessionsById: new Map([session("first"), session("current")].map((value) => [value.sessionId, value])),
		});
		expect(result.state.workspace.panes.map((pane) => pane.weight)).toEqual([1, 2]);
		expect(result.state.workspace.activePaneId).toBe("pane-2");
		expect(references(result.state.workspace)).toEqual(["first", "current"]);
		expect(result.metadataCalls).toEqual([]);
	});
	it("adds the current draft in a populated pane and preserves an intentional empty pane", async () => {
		const original = layout("first");
		saved({
			...original,
			panes: [...original.panes, { id: "empty", row: 0, tabs: [], activeId: "", placeholder: true }],
		});
		const result = await mount({ sessionsById: new Map([["first", session("first")]]), chatSessionId: null });
		expect(references(result.state.workspace)).toEqual(["first", null]);
		expect(result.state.workspace.panes[1]).toMatchObject({ id: "empty", tabs: [], placeholder: true });
		const stored = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!;
		expect(stored).not.toContain('"sessionId":null');
		expect(restoreWorkspaceLayout(stored, () => true)?.panes).toHaveLength(2);
	});
	it("validates unknown roots before restoration and preserves newly opened tools", async () => {
		const pending = deferred<Awaited<ReturnType<MetisDesktopApi["listSessions"]>>>();
		const raw = saved(layout("older", "current"));
		const result = await mount({
			api: { listSessions: vi.fn().mockReturnValue(pending.promise) } as unknown as MetisDesktopApi,
		});
		expect(references(result.state.workspace)).toEqual(["current"]);
		expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);
		const tools = new Map<string, ToolStrip>([
			[
				"current",
				{
					tabs: [{ kind: "terminal", id: "shell", sessionId: "current", cwd: "/", title: "Shell" }],
					activeId: "shell",
				},
			],
		]);
		await result.change((state) => state.setWorkspace((current) => ({ ...current, tools })));
		await act(async () => pending.resolve({ sessions: [session("older")], nextAfterSessionId: null }));
		expect(references(result.state.workspace)).toEqual(["older", "current"]);
		expect(result.state.workspace.tools).toBe(tools);
		expect(result.upsertSession).toHaveBeenCalledExactlyOnceWith(session("older"));
		expect(result.metadataCalls.every((name) => name === "listSessions")).toBe(true);
		expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).not.toContain("shell");
	});
	it("waits for agent metadata without opening the agent runtime", async () => {
		const original = layout("current");
		const pane = original.panes[0]!;
		saved({
			...original,
			panes: [{ ...pane, tabs: [{ ...pane.tabs[0]!, agentId: "worker", agentName: "Helper" } as ChatTab] }],
		});
		const pending = deferred<Awaited<ReturnType<MetisDesktopApi["listAgents"]>>>();
		const result = await mount({
			api: { listAgents: vi.fn().mockReturnValue(pending.promise) } as unknown as MetisDesktopApi,
		});
		expect(result.state.workspace.panes[0]!.tabs[0]).not.toHaveProperty("agentId");
		await act(async () =>
			pending.resolve({
				agents: [
					{
						agentId: "worker",
						rootSessionId: "current",
						parentSessionId: "current",
						agentPath: ["worker"],
						name: "Helper",
						agentType: "worker",
						depth: 1,
						status: "done",
						archived: false,
						tasks: [],
						createdAt: DATE,
						updatedAt: DATE,
					},
				],
				nextAfterAgentId: null,
				unreadableAgentCount: 0,
			}),
		);
		expect(result.state.workspace.panes[0]!.tabs.some((tab) => tab.kind === "chat" && tab.agentId === "worker")).toBe(
			true,
		);
		expect(result.metadataCalls.every((name) => name === "listAgents")).toBe(true);
		expect(result.upsertSession).not.toHaveBeenCalled();
	});
	it("uses the latest projected conversation when metadata resolves", async () => {
		saved(layout("older"));
		const pending = deferred<Awaited<ReturnType<MetisDesktopApi["listSessions"]>>>();
		const result = await mount({
			api: { listSessions: vi.fn().mockReturnValue(pending.promise) } as unknown as MetisDesktopApi,
		});
		await result.rerender({ chatSessionId: "latest" });
		await act(async () => pending.resolve({ sessions: [session("older")], nextAfterSessionId: null }));
		expect(references(result.state.workspace)).toEqual(["older", "latest"]);
		const active = result.state.workspace.panes.find((pane) => pane.id === result.state.workspace.activePaneId)!;
		expect(active.tabs.find((tab) => tab.id === active.activeId)?.sessionId).toBe("latest");
	});
	it.each(["cancelRestore", "markLayoutIntent"] as const)("ignores late metadata after %s", async (action) => {
		const raw = saved(layout("older"));
		const pending = deferred<Awaited<ReturnType<MetisDesktopApi["listSessions"]>>>();
		const result = await mount({
			api: { listSessions: vi.fn().mockReturnValue(pending.promise) } as unknown as MetisDesktopApi,
		});
		await result.change((state) => {
			state[action]();
			state.setWorkspace((current) => ({ ...current, nextNumber: 5 }));
		});
		await act(async () => pending.resolve({ sessions: [session("older")], nextAfterSessionId: null }));
		expect(references(result.state.workspace)).toEqual(["current"]);
		expect(result.state.workspace.nextNumber).toBe(5);
		expect(result.upsertSession).not.toHaveBeenCalled();
		if (action === "cancelRestore") expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);
		else
			expect(
				restoreWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), () => true)?.nextNumber,
			).toBe(5);
	});
	it("preserves the saved layout when metadata cannot prove references invalid", async () => {
		const raw = saved(layout("older"));
		const result = await mount({
			api: { listSessions: vi.fn().mockRejectedValue(new Error("offline")) } as unknown as MetisDesktopApi,
		});
		expect(references(result.state.workspace)).toEqual(["current"]);
		expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);
		await result.change((state) => state.setWorkspace((current) => ({ ...current, nextNumber: 8 })));
		expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(raw);
		expect(result.upsertSession).not.toHaveBeenCalled();
	});
	it("persists preferred weights only after resizing ends", async () => {
		saved(layout("current", "other"));
		const result = await mount({
			sessionsById: new Map([session("current"), session("other")].map((value) => [value.sessionId, value])),
		});
		const before = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
		await result.change((state) => state.setLayoutResizing(true));
		await result.change((state) =>
			state.setWorkspace((current) =>
				setPaneWeights(
					current,
					0,
					new Map([
						["pane-1", 3],
						["pane-2", 1],
					]),
				),
			),
		);
		expect(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(before);
		await result.change((state) => state.setLayoutResizing(false));
		expect(
			restoreWorkspaceLayout(localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY), () => true)!.panes.map(
				(pane) => pane.weight,
			),
		).toEqual([0.75, 0.25]);
	});
});
