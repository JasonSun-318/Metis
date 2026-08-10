// @vitest-environment jsdom

import type { ItemView, SessionSnapshot, SubagentSummaryView } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentPanel } from "../src/renderer/components/SubagentPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-08-06T00:00:00.000Z";
type ActiveSubagent = Exclude<SubagentSummaryView, { status: "closed" }>;

function subagent(
	agentId: string,
	taskSummary: string,
	status: ActiveSubagent["status"],
	usage?: ActiveSubagent["usage"],
	name = taskSummary,
): ActiveSubagent {
	return {
		agentId,
		name,
		taskSummary,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		status,
		background: true,
		configuration: {
			mode: "code",
			tools: ["Bash"],
			permissionMode: "ask",
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			cwd: "/work/project",
			forkTurns: "all",
			timeoutSeconds: 300,
		},
		...(usage ? { usage } : {}),
	};
}

function closedSubagent(
	agentId: string,
	taskSummary: string,
	finalSummary?: string,
	name = taskSummary,
): SubagentSummaryView {
	return {
		agentId,
		name,
		taskSummary,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		status: "closed",
		...(finalSummary ? { finalSummary } : {}),
	};
}

function snapshot(sessionId: string, subagents: readonly SubagentSummaryView[], cursor = 0): SessionSnapshot {
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
		permissionMode: "ask",
		turns: [],
		recentItems: [],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		tasks: [],
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		subagents,
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
	void act(() => root.render(<SubagentPanel api={api} onError={onError} sessionId="parent" store={store} visible />));
	return { container, onError, root };
}

function api(readSubagentItems = vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null })) {
	return {
		readSubagentItems,
		interruptSubagent: vi.fn().mockResolvedValue({}),
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

describe("SubagentPanel", () => {
	it("uses the assigned name instead of the first task text as the visible title", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [
			subagent("child", "你能创建 skill 吗", "running", undefined, "Skill creation"),
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
			subagent("running-1", "Analyze code", "running"),
			subagent("queued-1", "Find tests", "queued"),
			subagent("done-1", "Summarize project", "done", {
				model: { provider: "test", modelId: "model" },
				input: 10,
				output: 20,
				cacheRead: 3,
				cacheWrite: 2,
				elapsedMs: 65_000,
				toolCalls: 4,
			}),
		]));
		const interval = vi.spyOn(window, "setInterval");
		const rendered = renderPanel(store, api());
		roots.push(rendered.root);
		await flush();

		expect(rendered.container.textContent).toContain("Running");
		expect(rendered.container.textContent).toContain("Finished");
		expect(button(rendered.container, "View transcript for Analyze code")).toBeTruthy();
		expect(rendered.container.textContent).toContain("35 tokens");
		expect(rendered.container.textContent).toContain("4 tool uses");
		expect(rendered.container.textContent).not.toContain("Clear");
		expect(interval).toHaveBeenCalledTimes(1);
	});

	it("coalesces a burst during one pending latest read into one trailing read", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "running")]));
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
					type: "subagent/itemsChanged" as const,
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
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "running")]));
		const stop = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptSubagent = vi.fn().mockReturnValue(stop.promise) as MetisDesktopApi["interruptSubagent"];
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);
		const card = button(rendered.container, "View transcript for Analyze code");
		await act(async () => card.click());
		await flush();
		expect(desktopApi.readSubagentItems).toHaveBeenCalledTimes(1);
		await act(async () => vi.advanceTimersByTime(60_000));
		expect(desktopApi.readSubagentItems).toHaveBeenCalledTimes(1);

		const stopButton = button(rendered.container, "Stop Analyze code");
		await act(async () => stopButton.click());
		expect(desktopApi.interruptSubagent).toHaveBeenCalledTimes(1);
		expect(stopButton.disabled).toBe(true);
		expect(desktopApi.interruptSubagent).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "parent",
			agentId: "child",
			requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
		}));
		await act(async () => button(rendered.container, "Back to background tasks").click());
		expect(document.activeElement?.getAttribute("aria-label")).toBe("View transcript for Analyze code");
		await act(async () => stop.resolve({}));
	});

	it("shows a closed subagent summary without reading its deleted transcript", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [closedSubagent("child", "Analyze code", "## Result\n\nFound **three issues**.")]));
		const desktopApi = api();
		const rendered = renderPanel(store, desktopApi);
		roots.push(rendered.root);

		await act(async () => button(rendered.container, "View summary for Analyze code").click());
		await flush();

		expect(desktopApi.readSubagentItems).not.toHaveBeenCalled();
		expect(rendered.container.querySelector(".subagent-closed-summary h2")?.textContent).toBe("Result");
		expect(rendered.container.querySelector(".subagent-closed-summary strong")?.textContent).toBe("three issues");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("ignores a stale child read after the active session changes", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "done")]));
		const pending = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		const rendered = renderPanel(store, api(vi.fn().mockReturnValue(pending.promise)));
		roots.push(rendered.root);
		await act(async () => button(rendered.container, "View transcript for Analyze code").click());
		await act(async () => store.applySnapshot(snapshot("other", [])));
		await act(async () => pending.resolve({ items: [item("child", "stale")], nextBeforeItemId: null }));
		await flush();
		expect(store.getSnapshot().subagentTranscript.agentId).toBeNull();
		expect(rendered.container.textContent).not.toContain("stale");
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("restores mounted state across React StrictMode's effect replay", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "running")]));
		const pending = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptSubagent = vi.fn().mockReturnValue(pending.promise) as MetisDesktopApi["interruptSubagent"];
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		await act(async () => root.render(
			<StrictMode>
				<SubagentPanel api={desktopApi} onError={vi.fn()} sessionId="parent" store={store} visible />
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
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "running")]));
		const pending = deferred<unknown>();
		const desktopApi = api();
		desktopApi.interruptSubagent = vi.fn().mockReturnValue(pending.promise) as MetisDesktopApi["interruptSubagent"];
		const rendered = renderPanel(store, desktopApi);
		await act(async () => button(rendered.container, "Stop Analyze code").click());
		await act(async () => rendered.root.unmount());
		await act(async () => pending.reject(new Error("late failure")));
		expect(rendered.onError).not.toHaveBeenCalled();
	});

	it("keeps the current transcript visible when a refresh fails", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "done")]));
		store.selectSubagentTranscript("child");
		store.replaceSubagentItems("child", { items: [item("child", "retained activity")], nextBeforeItemId: null });
		const rendered = renderPanel(store, api(vi.fn().mockRejectedValue(new Error("read failed"))));
		roots.push(rendered.root);
		await flush();

		expect(rendered.container.textContent).toContain("retained activity");
		expect(rendered.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "read failed" }));
	});

	it("re-enables stop and preserves the server-owned status after a failure", async () => {
		const store = new AppStore();
		store.applySnapshot(snapshot("parent", [subagent("child", "Analyze code", "running")]));
		const desktopApi = api();
		desktopApi.interruptSubagent = vi.fn().mockRejectedValue(new Error("stop failed")) as MetisDesktopApi["interruptSubagent"];
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
		expect(rendered.container.textContent).toContain("后台任务");
		expect(rendered.container.textContent).not.toContain("运行中");
		expect(rendered.container.textContent).not.toContain("暂无运行中的任务");
		expect(rendered.container.textContent).toContain("暂无已完成的任务");
	});
});
