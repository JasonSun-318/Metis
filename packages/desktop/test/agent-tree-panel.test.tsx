// @vitest-environment jsdom

import type { AgentSummaryView, ItemView, SessionSnapshot } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTreePanel } from "../src/renderer/components/AgentTreePanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";

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

function archivedAgent(agentId: string, taskText: string, finalMessage?: string, name = taskText): AgentSummaryView {
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
			useMemory: true,
			contributeMemory: true,
		},
		collaborationMode: "default",
		permissionPreset: "ask",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
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
		agents: [...agents],
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
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

function renderPanel(
	store: AppStore,
	api: Parameters<typeof AgentTreePanel>[0]["api"],
	onError = vi.fn(),
	sessionId = "parent",
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	void act(() =>
		root.render(<AgentTreePanel api={api} onError={onError} sessionId={sessionId} store={store} visible />),
	);
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
	} satisfies Parameters<typeof AgentTreePanel>[0]["api"];
}

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	globalThis.ResizeObserver ??= class ResizeObserver {
		disconnect() {}
		observe() {}
		unobserve() {}
	};
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
		store.applySnapshot(
			snapshot("parent", [agentSummary("child", "你能创建 skill 吗", "running", "Skill creation")]),
		);
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
		store.applySnapshot(
			snapshot("parent", [
				agentSummary("running-1", "Analyze code", "running"),
				agentSummary("queued-1", "Find tests", "queued"),
				agentSummary("done-1", "Summarize project", "done"),
			]),
		);
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

	it("measures active elapsed time from the current follow-up task", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
		const currentTask = {
			...taskSummary("Follow up", "running"),
			taskId: "follow-up",
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T23:59:55.000Z",
		};
		const store = new AppStore();
		store.applySnapshot(
			snapshot("parent", [
				agentSummary("child", "Follow up", "running", "Worker", {
					tasks: [currentTask],
					currentTask,
					latestTask: currentTask,
					createdAt: "2026-08-06T00:00:00.000Z",
				}),
			]),
		);
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);
		await flush();
		expect(rendered.container.textContent).toContain("5s");
		expect(rendered.container.textContent).not.toContain("24h");
	});

	it("coalesces a burst during one pending latest read into one trailing read", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const first = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		const read = vi
			.fn()
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
					taskId: "task-1",
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
		desktopApi.interruptAgent = vi.fn().mockReturnValue(stop.promise);
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
		expect(desktopApi.interruptAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "parent",
				agentId: "child",
				requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
			}),
		);
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
		expect(vi.mocked(desktopApi.readAgentItems).mock.calls.at(-1)?.[0]).toMatchObject({ taskId: TASK_ID });
		expect(rendered.container.textContent).toContain("Found three issues.");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("automatically pages past active rows until archived history is found", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", []));
		const activePage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`active-${index}`, `Task ${index}`, "done", `Active ${index}`),
		);
		const archived = archivedAgent("archived-child", "Archived task", "Archived result", "Archived worker");
		const desktopApi = api();
		desktopApi.listAgents = vi
			.fn()
			.mockResolvedValueOnce({ agents: activePage, nextAfterAgentId: "active-99" })
			.mockResolvedValueOnce({ agents: [archived], nextAfterAgentId: null });
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "Show archived").click());
		await flush();
		expect(desktopApi.listAgents).toHaveBeenCalledTimes(2);
		expect(desktopApi.listAgents).toHaveBeenLastCalledWith(
			expect.objectContaining({ includeArchived: true, afterAgentId: "active-99" }),
		);
		expect(button(rendered.container, "View summary for Archived worker")).toBeTruthy();
	});

	it("renders nested ownership and disables archiving a parent with active descendants", async () => {
		const store = new AppStore();
		const parentTask = {
			...taskSummary("Coordinate review", "done"),
			usage: {
				model: { provider: "fixture", modelId: "worker" },
				input: 12,
				output: 8,
				cacheRead: 4,
				cacheWrite: 6,
				elapsedMs: 100,
				cost: 0.01,
				toolCalls: 3,
			},
		};
		const parent = agentSummary("root-agent", "Coordinate review", "done", "Coordinator", {
			tasks: [parentTask],
			latestTask: parentTask,
		});
		const child = agentSummary("child-agent", "Inspect code", "running", "Explorer", {
			depth: 2,
			parentSessionId: parent.agentId,
			agentPath: [parent.agentId, "child-agent"],
		});
		store.applySnapshot(snapshot("parent", [parent, child]));
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);

		const tree = rendered.container.querySelector('[role="tree"]');
		const treeItems = rendered.container.querySelectorAll('[role="treeitem"]');
		expect(tree?.getAttribute("aria-label")).toBe("Agent tree");
		expect(treeItems[0]?.getAttribute("aria-level")).toBe("1");
		expect(treeItems[0]?.getAttribute("aria-expanded")).toBe("true");
		expect(treeItems[1]?.getAttribute("aria-level")).toBe("2");
		await act(async () => {
			(treeItems[0] as HTMLElement).focus();
			treeItems[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		expect(document.activeElement).toBe(treeItems[1]);
		await act(async () => {
			treeItems[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		});
		expect(document.activeElement).toBe(treeItems[0]);
		await act(async () => {
			treeItems[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		expect(document.activeElement).toBe(treeItems[1]);
		expect(rendered.container.textContent).toContain("30 tokens");
		expect(rendered.container.textContent).toContain("3 tool uses");
		expect(rendered.container.querySelectorAll(".subagent-tree-children .subagent-card")).toHaveLength(1);
		await act(async () => button(rendered.container, "Collapse Coordinator").click());
		expect(rendered.container.querySelector('[aria-label="View transcript for Explorer"]')).toBeNull();
		expect(treeItems[0]?.getAttribute("aria-expanded")).toBe("false");
		expect((treeItems[0] as HTMLElement).tabIndex).toBe(0);
		await act(async () => button(rendered.container, "Expand Coordinator").click());
		expect(button(rendered.container, "View transcript for Explorer")).toBeTruthy();
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
		expect(desktopApi.readAgentItems).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-new" }));

		const chooseOption = async (text: string) => {
			await act(async () => button(rendered.container, "Task").click());
			await flush();
			const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
				candidate.textContent?.includes(text),
			);
			expect(option).toBeTruthy();
			await act(async () => option!.click());
			await flush();
		};
		await chooseOption("task-old");
		expect(desktopApi.readAgentItems).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-old" }));
		await chooseOption("Latest task");
		expect(desktopApi.readAgentItems).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "task-new" }));
	});

	it("hides the task selector for single-task agents and truncates long option labels", async () => {
		const longSummary = `${"这是一段非常长的任务摘要".repeat(19)}唯一结尾哨兵唯一结尾`;
		const longTask = { ...taskSummary(longSummary, "done"), taskId: "tasklong1" };
		const firstTask = { ...taskSummary("First task", "done"), taskId: "task-old" };
		const store = new AppStore();
		store.applySnapshot(
			snapshot("parent", [
				agentSummary("solo", "Only task", "done", "Solo"),
				agentSummary("child", longSummary, "done", "Historian", {
					tasks: [firstTask, longTask],
					latestTask: longTask,
				}),
			]),
		);
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "View transcript for Solo").click());
		await flush();
		expect(rendered.container.querySelector(".subagent-task-selector")).toBeNull();

		await act(async () => button(rendered.container, "Back to agents").click());
		await act(async () => button(rendered.container, "View transcript for Historian").click());
		await flush();
		await act(async () => button(rendered.container, "Task").click());
		await flush();
		const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
			candidate.textContent?.includes("tasklong"),
		);
		expect(option?.textContent).toContain("…");
		expect(option?.textContent).not.toContain(longSummary.slice(-12));
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

	it("uses a byte-budgeted snapshot cursor even when fewer than 100 agents are present", async () => {
		const store = new AppStore();
		store.applySnapshot({
			...snapshot("parent", [agentSummary("agent-0", "Task 0", "done", "Agent 0")]),
			nextAgentAfterId: "agent-0",
		});
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({ agents: [], nextAfterAgentId: null });
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Load older agents").click());
		expect(desktopApi.listAgents).toHaveBeenCalledWith(
			expect.objectContaining({ afterAgentId: "agent-0", includeArchived: false }),
		);
	});

	it("recovers pagination when the server cursor agent was deleted", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const invalidCursor = Object.assign(new Error("invalid cursor"), { code: -32015 });
		const desktopApi = api();
		desktopApi.listAgents = vi
			.fn()
			.mockRejectedValueOnce(invalidCursor)
			.mockResolvedValueOnce({
				agents: [agentSummary("agent-100", "Task 100", "done", "Agent 100")],
				nextAfterAgentId: null,
			});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Load older agents").click());
		await flush();
		expect(desktopApi.listAgents).toHaveBeenNthCalledWith(1, expect.objectContaining({ afterAgentId: "agent-99" }));
		expect(desktopApi.listAgents).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterAgentId: "agent-98" }));
		expect(rendered.onError).not.toHaveBeenCalled();
		expect(button(rendered.container, "View transcript for Agent 100")).toBeTruthy();
	});

	it("lets a live summary replace a stale copy loaded from an older page", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({
			agents: [agentSummary("returning", "Resume work", "done", "Returning")],
			nextAfterAgentId: null,
		});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Load older agents").click());
		await flush();

		await act(async () => {
			store.applyBatch({
				serverEpoch: EPOCH,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "agent/updated",
						sessionId: "parent",
						agent: agentSummary("returning", "Resume work", "running", "Returning"),
					},
				],
			});
		});

		expect(button(rendered.container, "Stop Returning")).toBeTruthy();
		expect(rendered.container.textContent).toContain("Running");
	});

	it("drops paged agents and their selection on a same-session resnapshot", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({
			agents: [agentSummary("paged", "Paged task", "done", "Paged worker")],
			nextAfterAgentId: null,
		});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Load older agents").click());
		await flush();
		await act(async () => button(rendered.container, "View transcript for Paged worker").click());
		expect(store.getSnapshot().agentTranscript.agentId).toBe("paged");

		await act(async () => store.applySnapshot(snapshot("parent", [firstPage[0]!], 10)));
		await flush();
		expect(rendered.container.textContent).not.toContain("Paged worker");
		expect(store.getSnapshot().agentTranscript.agentId).toBeNull();
	});

	it("removes a paged agent when a live delete event arrives", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockResolvedValue({
			agents: [agentSummary("paged", "Paged task", "done", "Paged worker")],
			nextAfterAgentId: null,
		});
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Load older agents").click());
		await flush();
		expect(button(rendered.container, "View transcript for Paged worker")).toBeTruthy();

		await act(async () => {
			store.applyBatch({
				serverEpoch: EPOCH,
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "agent/deleted", sessionId: "parent", agentId: "paged", deletedAgentIds: ["paged"] }],
			});
		});
		await flush();
		expect(rendered.container.textContent).not.toContain("Paged worker");
	});

	it("requires permanent-delete confirmation and reports mutation failures without hiding the agent", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done", "Disposable")]));
		const desktopApi = api();
		desktopApi.deleteAgent = vi.fn().mockRejectedValue(new Error("delete failed"));
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
	it("keeps its own transcript live after the active session changes", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done")]));
		const pending = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		const rendered = renderPanel(store, api(vi.fn().mockReturnValue(pending.promise)));
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "View transcript for Analyze code").click());
		await act(async () => store.applySnapshot(snapshot("other", [])));
		await act(async () => pending.resolve({ items: [item("child", "stale")], nextBeforeItemId: null }));
		await flush();
		// The compat mirror tracks the focused session; the parent bucket keeps
		// its own selection and received the page for its own transcript.
		expect(store.getSnapshot().agentTranscript.agentId).toBeNull();
		expect(store.getSnapshot().sessions.get("parent")?.agentTranscript.agentId).toBe("child");
		expect(rendered.container.textContent).toContain("stale");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("renders the tree and transcript from a non-focused session bucket", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child-a", "Focused task", "done")]));
		store.beginSubscription("other", { focus: false });
		store.applySnapshot(snapshot("other", [agentSummary("child-b", "Background task", "done")]));
		const read = vi.fn().mockResolvedValue({
			items: [item("child-b", "background activity")],
			nextBeforeItemId: null,
		});
		const rendered = renderPanel(store, api(read), vi.fn(), "other");
		roots.push(rendered.root);
		await flush();

		expect(rendered.container.textContent).toContain("Background task");
		expect(rendered.container.textContent).not.toContain("Focused task");
		await act(async () => button(rendered.container, "View transcript for Background task").click());
		await flush();
		expect(read).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "other", agentId: "child-b" }));
		expect(rendered.container.textContent).toContain("background activity");
		expect(store.getSnapshot().sessions.get("other")?.agentTranscript.agentId).toBe("child-b");
		// The focused session's own transcript selection is untouched.
		expect(store.getSnapshot().sessions.get("parent")?.agentTranscript.agentId).toBeNull();
		expect(store.getSnapshot().agentTranscript.agentId).toBeNull();
	});

	it("ignores stale list and archive responses after switching sessions", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			agentSummary(`agent-${index}`, `Task ${index}`, "done", `Agent ${index}`),
		);
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", firstPage));
		const listed = deferred<{ agents: AgentSummaryView[]; nextAfterAgentId: null }>();
		const archived = deferred<{ agent: AgentSummaryView }>();
		const desktopApi = api();
		desktopApi.listAgents = vi.fn().mockReturnValue(listed.promise);
		desktopApi.archiveAgent = vi.fn().mockReturnValue(archived.promise);
		const onError = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () =>
			root.render(<AgentTreePanel api={desktopApi} onError={onError} sessionId="parent" store={store} visible />),
		);
		await act(async () => button(container, "Load older agents").click());
		await act(async () => button(container, "Archive agent").click());
		await act(async () => {
			store.applySnapshot(snapshot("other", []));
			root.render(<AgentTreePanel api={desktopApi} onError={onError} sessionId="other" store={store} visible />);
		});
		await act(async () => {
			listed.resolve({
				agents: [agentSummary("stale-list", "Stale", "done", "Stale list")],
				nextAfterAgentId: null,
			});
			archived.resolve({ agent: archivedAgent("agent-0", "Task 0", undefined, "Agent 0") });
		});
		await flush();
		expect(container.textContent).not.toContain("Stale list");
		expect(container.textContent).not.toContain("Agent 0");
		expect(onError).not.toHaveBeenCalled();
	});

	it("restores mounted state across React StrictMode's effect replay", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "running")]));
		const pending = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptAgent = vi.fn().mockReturnValue(pending.promise);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () =>
			root.render(
				<StrictMode>
					<AgentTreePanel api={desktopApi} onError={vi.fn()} sessionId="parent" store={store} visible />
				</StrictMode>,
			),
		);
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
		desktopApi.interruptAgent = vi.fn().mockReturnValue(pending.promise);
		const rendered = renderPanel(store, desktopApi);
		await act(async () => button(rendered.container, "Stop Analyze code").click());
		await act(async () => rendered.root.unmount());
		await act(async () => pending.reject(new Error("late failure")));
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("keeps the current transcript visible when a refresh fails", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [agentSummary("child", "Analyze code", "done")]));
		store.selectAgentTranscript("parent", "child");
		store.replaceAgentItems("parent", "child", null, {
			items: [item("child", "retained activity")],
			nextBeforeItemId: null,
		});
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
		desktopApi.interruptAgent = vi.fn().mockRejectedValue(new Error("stop failed"));
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "Stop Analyze code").click());

		expect(button(rendered.container, "Stop Analyze code").disabled).toBe(false);
		expect(rendered.container.textContent).toContain("Running");
		expect(rendered.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "stop failed" }));
	});

	it("uses localized labels from i18n", async () => {
		await setLocale("zh-CN");
		const localizedTask = {
			...taskSummary("检查代理", "done"),
			usage: {
				model: { provider: "fixture", modelId: "worker" },
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				elapsedMs: 10,
				toolCalls: 1,
			},
		};
		const store = new AppStore();
		store.applySnapshot(
			snapshot("parent", [
				agentSummary("child", "检查代理", "done", "检查员", {
					tasks: [localizedTask],
					latestTask: localizedTask,
				}),
			]),
		);
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);
		await flush();
		expect(rendered.container.textContent).toContain("代理");
		expect(rendered.container.querySelector('[role="tree"]')?.getAttribute("aria-label")).toBe("代理树");
		expect(rendered.container.textContent).toContain("1 次工具调用");
		await act(async () => button(rendered.container, "查看 检查员 的记录").click());
		expect(button(rendered.container, "归档")).toBeTruthy();
	});
});
