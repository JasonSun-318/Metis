// @vitest-environment jsdom

import type { ItemView, SessionSnapshot, AgentSummaryView } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTreePanel } from "../src/renderer/components/AgentTreePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-06T00:00:00.000Z";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function taskSummary(taskSummary: string, status: AgentSummaryView["status"], finalMessage?: string) {
	return {
		taskId: TASK_ID,
		status,
		taskSummary,
		...(finalMessage ? { finalMessage } : {}),
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
	};
}

function agentSummary(
	agentId: string,
	taskText: string,
	status: AgentSummaryView["status"],
	name = taskText,
	overrides: Partial<AgentSummaryView> = {},
): AgentSummaryView {
	const task = taskSummary(taskText, status);
	return {
		agentId,
		name,
		agentType: "worker",
		depth: 1,
		status,
		archived: false,
		parentSessionId: "parent",
		rootSessionId: "parent",
		agentPath: [agentId],
		tasks: [task],
		currentTask: status === "running" || status === "queued" ? task : undefined,
		latestTask: task,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		...overrides,
	};
}

function archivedAgent(
	agentId: string,
	taskText: string,
	finalMessage?: string,
	name = taskText,
): AgentSummaryView {
	return agentSummary(agentId, taskText, "done", name, {
		archived: true,
		currentTask: undefined,
		latestTask: taskSummary(taskText, "done", finalMessage),
	});
}

function snapshot(sessionId: string, agents: readonly AgentSummaryView[], cursor = 0): SessionSnapshot {
	return {
		session: {
			sessionId,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd: "/work/project",
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
			state: "running",
			archived: false,
			unread: false,
		},
		collaborationMode: "default",
		permissionMode: "ask",
		turns: [],
		recentItems: [],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		queuedTurns: [],
		tasks: [],
		deliveredFiles: [],
		goal: null,
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		agents,
		serverEpoch: EPOCH,
		cursor,
	};
}

function item(agentId: string, text: string): ItemView {
	return {
		itemId: `item-${text}`,
		sessionId: agentId,
		role: "assistant",
		state: "completed",
		content: [{ type: "text", text }],
		createdAt: CREATED_AT,
		completedAt: CREATED_AT,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause?: unknown) => void;
	const promise = new Promise<T>((fulfill, fail) => {
		resolve = fulfill;
		reject = fail;
	});
	return { promise, reject, resolve };
}

function button(container: ParentNode, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
		candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function flush() {
	await act(async () => { await Promise.resolve(); });
}

function renderPanel(store: AppStore, api: MetisDesktopApi, onError = vi.fn()) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	void act(() => root.render(<AgentTreePanel api={api} onError={onError} sessionId="parent" store={store} visible />));
	return { container, onError, root };
}

function api(readAgentItems = vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null })) {
	return {
		readAgentItems,
		listAgents: vi.fn().mockResolvedValue({ agents: [], nextAfterAgentId: null }),
		interruptAgent: vi.fn().mockResolvedValue({}),
		archiveAgent: vi.fn().mockImplementation(async ({ agentId, archived }) => ({
			agent: agentSummary(agentId, "task", "done", agentId, { archived }),
		})),
		deleteAgent: vi.fn().mockImplementation(async ({ agentId }) => ({ agentId, status: "deleted" })),
	} as unknown as MetisDesktopApi;
}

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
	vi.restoreAllMocks();
});

describe("AgentTreePanel", () => {
	it("uses the assigned name instead of the first task text as the visible title", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [
			agentSummary("child", "你能创建 skill 吗", "running", "Skill creation"),
		]));
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);

		const card = button(rendered.container, "View transcript for Skill creation");
		expect(card.querySelector(".subagent-card-title")?.textContent).toBe("Skill creation");
		expect(card.querySelector(".subagent-card-meta")?.textContent).toContain("你能创建 skill 吗");

		await act(async () => card.click());
		expect(rendered.container.querySelector(".subagent-detail-title strong")?.textContent).toBe("Skill creation");
		expect(button(rendered.container, "Stop Skill creation")).toBeTruthy();
	});

	it("groups real summaries, uses one elapsed timer, and omits excluded controls", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [
			agentSummary("running-1", "Analyze code", "running"),
			agentSummary("queued-1", "Find tests", "queued"),
			agentSummary("done-1", "Summarize project", "done"),
		]));
		const interval = vi.spyOn(window, "setInterval");
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);
		await flush();

		expect(rendered.container.textContent).toContain("Running");
		expect(rendered.container.textContent).toContain("Done");
		expect(button(rendered.container, "View transcript for Analyze code")).toBeTruthy();
		expect(rendered.container.textContent).toContain("worker");
		expect(rendered.container.textContent).not.toContain("Clear");
		expect(interval).toHaveBeenCalledTimes(1);
	});

	it("coalesces a burst during one pending latest read into one trailing read", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const first = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		const read = vi.fn()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ items: [item("child", "latest")], nextBeforeItemId: null });
		const rendered = renderPanel(store, api(read));
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "View transcript for Analyze code").click());
		expect(read).toHaveBeenCalledTimes(1);

		await act(async () => {
			store.applyBatch({
				serverEpoch: EPOCH,
				fromCursor: 1,
				toCursor: 20,
				events: Array.from({ length: 20 }, () => ({
					type: "agent/itemsChanged" as const,
					sessionId: "parent",
					agentId: "child",
				})),
			});
		});
		expect(read).toHaveBeenCalledTimes(1);
		await act(async () => first.resolve({ items: [], nextBeforeItemId: null }));
		await flush();
		expect(read).toHaveBeenCalledTimes(2);
		expect(rendered.container.textContent).toContain("latest");
	});

	it("does not poll, stops once per click, and restores focus after returning", async () => {
		vi.useFakeTimers();
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const stop = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptAgent = vi.fn().mockReturnValue(stop.promise) as MetisDesktopApi["interruptAgent"];
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		const card = button(rendered.container, "View transcript for Analyze code");
		await act(async () => card.click());
		await flush();
		expect(desktopApi.readAgentItems).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTime(60_000));
		expect(desktopApi.readAgentItems).toHaveBeenCalledTimes(1);

		const stopButton = button(rendered.container, "Stop Analyze code");
		await act(async () => stopButton.click());
		expect(desktopApi.interruptAgent).toHaveBeenCalledTimes(1);
		expect(stopButton.disabled).toBe(true);
		expect(desktopApi.interruptAgent).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "parent",
			agentId: "child",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
		}));
		await act(async () => button(rendered.container, "Back to agents").click());
		expect(document.activeElement?.getAttribute("aria-label")).toBe("View transcript for Analyze code");
		await act(async () => stop.resolve({}));
	});

	it("loads an archived agent transcript from persistent history", async () => {
		const store = new AppStore();
		const archived = archivedAgent("child", "Analyze code", "Found three issues.");
		store.applySnapshot(snapshot("parent", []));
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({ agents: [archived], nextAfterAgentId: null });
		desktopApi.readAgentItems = vi.fn().mockResolvedValue({
			items: [item("child", "Found three issues.")],
			nextBeforeItemId: null,
		});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "Show archived").click());
		await flush();
		await act(async () => button(rendered.container, "View summary for Analyze code").click());
		await flush();

		expect(desktopApi.readAgentItems).toHaveBeenCalledWith(expect.objectContaining({ agentId: "child" }));
		expect(vi.mocked(desktopApi.readAgentItems).mock.calls.at(-1)?.[0]).not.toHaveProperty("taskId");
		expect(rendered.container.textContent).toContain("Found three issues.");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("renders nested ownership and disables archiving a parent with active descendants", async () => {
		const store = new AppStore();
		const parent = agentSummary("root-agent", "Coordinate review", "done", "Coordinator");
		const child = agentSummary("child-agent", "Inspect code", "running", "Explorer", {
			depth: 2,
			parentSessionId: parent.agentId,
			agentPath: [parent.agentId, "child-agent"],
		});
		store.applySnapshot(snapshot("parent", [parent, child]));
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);

		expect(rendered.container.querySelectorAll(".subagent-tree-children .subagent-card")).toHaveLength(1);
		await act(async () => button(rendered.container, "View transcript for Coordinator").click());
		expect(button(rendered.container, "Archive agent").disabled).toBe(true);
	});

	it("selects historical tasks and forwards the task id to the server", async () => {
		const oldTask = { ...taskSummary("First task", "done"), taskId: "task-old" };
		const latestTask = { ...taskSummary("Second task", "done"), taskId: "task-new" };
		const agent = agentSummary("child", "Second task", "done", "Historian", {
			tasks: [oldTask, latestTask],
			latestTask,
		});
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agent]));
		const desktopApi = api();
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "View transcript for Historian").click());
		await flush();

		const select = rendered.container.querySelector<HTMLSelectElement>(".subagent-task-selector select")!;
		await act(async () => {
			select.value = "task-old";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await flush();
		expect(desktopApi.readAgentItems).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-old" }));
	});

	it("loads the next 100-agent page from the snapshot cursor", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({
			agents: [agentSummary("agent-100", "Task 100", "done", "Agent 100")],
			nextAfterAgentId: null,
		});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "Load older agents").click());
		await flush();
		expect(desktopApi.listAgents).toHaveBeenCalledWith({
			sessionId: "parent",
			includeArchived: false,
			afterAgentId: "agent-99",
			limit: 100,
		});
		expect(button(rendered.container, "View transcript for Agent 100")).toBeTruthy();
	});

	it("requires permanent-delete confirmation and reports mutation failures without hiding the agent", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done", "Disposable")]));
		const desktopApi = api();
		desktopApi.deleteAgent = vi.fn().mockRejectedValue(new Error("delete failed")) as MetisDesktopApi["deleteAgent"];
		const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "Delete").click());
		expect(desktopApi.deleteAgent).not.toHaveBeenCalled();
		await act(async () => button(rendered.container, "Delete").click());
		await flush();
		expect(confirm).toHaveBeenLastCalledWith(
			"Permanently delete Disposable and all descendant agent history? Project files are not deleted.",
		);
		expect(rendered.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "delete failed" }));
		expect(button(rendered.container, "View transcript for Disposable")).toBeTruthy();
	});
	it("ignores a stale child read after the active session changes", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done")]));
		const pending = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		const rendered = renderPanel(store, api(vi.fn().mockReturnValue(pending.promise)));
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "View transcript for Analyze code").click());
		await act(async () => store.applySnapshot(snapshot("other", [])));
		await act(async () => pending.resolve({ items: [item("child", "stale")], nextBeforeItemId: null }));
		await flush();
		expect(store.getSnapshot().agentTranscript.agentId).toBeNull();
		expect(rendered.container.textContent).not.toContain("stale");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("restores mounted state across React StrictMode's effect replay", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const pending = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptAgent = vi.fn().mockReturnValue(pending.promise) as MetisDesktopApi["interruptAgent"];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => root.render(
			<StrictMode>
				<AgentTreePanel api={desktopApi} onError={vi.fn()} sessionId="parent" store={store} visible />
			</StrictMode>,
		));
		const stopButton = button(container, "Stop Analyze code");
		await act(async () => stopButton.click());
		expect(stopButton.disabled).toBe(true);
		await act(async () => pending.resolve({}));
		expect(button(container, "Stop Analyze code").disabled).toBe(false);
	});

	it("does not surface a late stop failure after the panel unmounts", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const pending = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptAgent = vi.fn().mockReturnValue(pending.promise) as MetisDesktopApi["interruptAgent"];
		const rendered = renderPanel(store, desktopApi);
		await act(async () => button(rendered.container, "Stop Analyze code").click());
		await act(async () => rendered.root.unmount());
		await act(async () => pending.reject(new Error("late failure")));
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("keeps the current transcript visible when a refresh fails", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done")]));
		store.selectAgentTranscript("child");
		store.replaceAgentItems("child", null, { items: [item("child", "retained activity")], nextBeforeItemId: null });
		const rendered = renderPanel(store, api(vi.fn().mockRejectedValue(new Error("read failed"))));
		roots.push(rendered.root);
		await flush();

		expect(rendered.container.textContent).toContain("retained activity");
		expect(rendered.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "read failed" }));
	});

	it("re-enables stop and preserves the server-owned status after a failure", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const desktopApi = api();
		desktopApi.interruptAgent = vi.fn().mockRejectedValue(new Error("stop failed")) as MetisDesktopApi["interruptAgent"];
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Stop Analyze code").click());

		expect(button(rendered.container, "Stop Analyze code").disabled).toBe(false);
		expect(rendered.container.textContent).toContain("Running");
		expect(rendered.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stop failed" }));
	});

	it("uses localized labels from i18n", async () => {
		await setLocale("zh-CN");
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", []));
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);
		await flush();
		expect(rendered.container.textContent).toContain("代理");
		expect(rendered.container.textContent).toContain("暂无代理");
	});
});
