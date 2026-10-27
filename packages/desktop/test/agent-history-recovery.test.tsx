// @vitest-environment jsdom
import type { AgentSummaryView, ItemView } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentHistory } from "../src/renderer/hooks/use-agent-history.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD_A = "22222222-2222-4222-8222-222222222222";
const CHILD_B = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-10-26T00:00:00.000Z";
const EPOCH = "epoch-1";

function child(id: string, status: AgentSummaryView["status"] = "running"): AgentSummaryView {
	return {
		agentId: id,
		name: id,
		parentSessionId: ROOT,
		rootSessionId: ROOT,
		agentPath: [id],
		depth: 1,
		agentType: "worker",
		status,
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: status === "running" ? DATE : "2026-10-26T00:00:02.000Z",
	};
}

function item(id: string, text: string, sessionId = CHILD_A, createdAt = DATE): ItemView {
	return {
		sessionId,
		itemId: id,
		role: "assistant",
		state: "completed",
		content: [{ type: "text", text }],
		createdAt,
	};
}

function connection(events: readonly unknown[], serverEpoch = EPOCH): DesktopApiEvent {
	return {
		type: "app-server",
		envelope: {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch, fromCursor: 1, toCursor: 1, events },
		},
	} as DesktopApiEvent;
}

function supervisor(state: "starting" | "ready" | "restarting", serverEpoch = EPOCH): DesktopApiEvent {
	return {
		type: "supervisor",
		view: { state, serverEpoch, restartAttempt: state === "restarting" ? 1 : 0, failure: null },
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function setup() {
	const listeners = new Set<(event: DesktopApiEvent) => void>();
	const api = {
		readAgentItems: vi.fn().mockResolvedValue({ items: [item("first", "old answer")], nextBeforeItemId: null }),
		subscribe: vi.fn((listener: (event: DesktopApiEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies Partial<MetisDesktopApi>;
	const emit = (event: DesktopApiEvent) => {
		for (const listener of listeners) listener(event);
	};
	return { api, emit, listeners };
}

type HistoryResult = ReturnType<typeof useAgentHistory>;
const observed = new Map<string, HistoryResult>();
function Probe({
	api,
	label,
	agentId,
	sessionId = ROOT,
}: {
	readonly api: Pick<MetisDesktopApi, "readAgentItems" | "subscribe">;
	readonly label: string;
	readonly agentId: string;
	readonly sessionId?: string;
}) {
	const history = useAgentHistory(api, sessionId, agentId);
	observed.set(label, history);
	return (
		<div data-probe={label}>
			{history.loading
				? "loading"
				: history.error
					? "error"
					: history.items
							.map((entry) => entry.content.map((block) => (block.type === "text" ? block.text : "")).join(""))
							.join("|")}
		</div>
	);
}

const roots: Root[] = [];
function mount(
	api: Pick<MetisDesktopApi, "readAgentItems" | "subscribe">,
	probes: readonly { label: string; agentId: string; sessionId?: string }[] = [{ label: "a", agentId: CHILD_A }],
	strict = false,
) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (next = probes) => {
		await act(async () =>
			root.render(
				strict ? (
					<StrictMode>
						{next.map((probe) => (
							<Probe
								api={api}
								key={probe.label}
								label={probe.label}
								agentId={probe.agentId}
								sessionId={probe.sessionId}
							/>
						))}
					</StrictMode>
				) : (
					next.map((probe) => (
						<Probe
							api={api}
							key={probe.label}
							label={probe.label}
							agentId={probe.agentId}
							sessionId={probe.sessionId}
						/>
					))
				),
			),
		);
	};
	return { container, render, root };
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	observed.clear();
});
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("useAgentHistory recovery", () => {
	it("refreshes the tail on a terminal agent update even without itemsChanged", async () => {
		const { api, emit } = setup();
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["first"]);
		api.readAgentItems.mockResolvedValue({
			items: [item("saved", "recovered answer", CHILD_A, "2026-10-26T00:00:01.000Z")],
			nextBeforeItemId: null,
		});
		await act(async () =>
			emit(connection([{ type: "agent/updated", sessionId: ROOT, agent: child(CHILD_A, "done") }])),
		);
		await settle();
		expect(observed.get("a")?.items.some((entry) => entry.role === "assistant")).toBe(true);
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["first", "saved"]);
		expect(api.readAgentItems).toHaveBeenCalledTimes(2);
	});

	it("refreshes after a same-epoch reconnect and after an epoch change", async () => {
		const { api, emit } = setup();
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		api.readAgentItems.mockResolvedValue({
			items: [item("after-reconnect", "after reconnect", CHILD_A, "2026-10-26T00:00:01.000Z")],
			nextBeforeItemId: null,
		});
		await act(async () => emit(supervisor("restarting")));
		await act(async () => emit(supervisor("ready")));
		await settle();
		expect(observed.get("a")?.items.at(-1)?.itemId).toBe("after-reconnect");
		api.readAgentItems.mockResolvedValue({
			items: [item("after-epoch", "after epoch", CHILD_A, "2026-10-26T00:00:02.000Z")],
			nextBeforeItemId: null,
		});
		await act(async () => emit(supervisor("ready", "epoch-2")));
		await settle();
		expect(observed.get("a")?.items.at(-1)?.itemId).toBe("after-epoch");
	});

	it("coalesces a terminal refresh that arrives during an in-flight cold read", async () => {
		const { api, emit } = setup();
		const pending = deferred<{ items: ItemView[]; nextBeforeItemId: null }>();
		api.readAgentItems.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
			items: [item("saved", "durable answer", CHILD_A, "2026-10-26T00:00:01.000Z")],
			nextBeforeItemId: null,
		});
		const mounted = await mount(api);
		await mounted.render();
		await vi.waitFor(() => expect(api.readAgentItems).toHaveBeenCalledOnce());
		await act(async () =>
			emit(connection([{ type: "agent/updated", sessionId: ROOT, agent: child(CHILD_A, "done") }])),
		);
		pending.resolve({ items: [item("stale", "stale answer")], nextBeforeItemId: null });
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["stale", "saved"]);
		expect(api.readAgentItems).toHaveBeenCalledTimes(2);
	});

	it("keeps child histories independent and refreshes only the terminal child", async () => {
		const { api, emit } = setup();
		api.readAgentItems.mockImplementation(({ agentId }: { agentId: string }) =>
			Promise.resolve({ items: [item(`${agentId}-old`, `${agentId} old`, agentId)], nextBeforeItemId: null }),
		);
		const mounted = await mount(api, [
			{ label: "a", agentId: CHILD_A },
			{ label: "b", agentId: CHILD_B },
		]);
		await mounted.render();
		await settle();
		expect(observed.get("a")?.items[0]?.itemId).toBe(`${CHILD_A}-old`);
		expect(observed.get("b")?.items[0]?.itemId).toBe(`${CHILD_B}-old`);
		const bReads = api.readAgentItems.mock.calls.filter(([input]) => input.agentId === CHILD_B).length;
		api.readAgentItems.mockImplementation(({ agentId }: { agentId: string }) =>
			Promise.resolve({
				items: [item(`${agentId}-new`, `${agentId} new`, agentId, "2026-10-26T00:00:02.000Z")],
				nextBeforeItemId: null,
			}),
		);
		await act(async () =>
			emit(connection([{ type: "agent/updated", sessionId: ROOT, agent: child(CHILD_A, "done") }])),
		);
		await settle();
		expect(observed.get("a")?.items.at(-1)?.itemId).toBe(`${CHILD_A}-new`);
		expect(observed.get("b")?.items[0]?.itemId).toBe(`${CHILD_B}-old`);
		expect(api.readAgentItems.mock.calls.filter(([input]) => input.agentId === CHILD_B)).toHaveLength(bReads);
	});

	it("preserves older pages and cursor across terminal refresh, then replaces live IDs", async () => {
		const { api, emit } = setup();
		const older = item("older", "older page", CHILD_A, "2026-10-25T00:00:00.000Z");
		const boundary = item("boundary", "boundary", CHILD_A, DATE);
		api.readAgentItems.mockImplementation(({ beforeItemId }: { beforeItemId: string | null }) =>
			Promise.resolve(
				beforeItemId
					? { items: [older, boundary], nextBeforeItemId: null }
					: { items: [boundary], nextBeforeItemId: "cursor-1" },
			),
		);
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		await act(async () => observed.get("a")?.loadOlder());
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["older", "boundary"]);
		const cursor = observed.get("a")?.cursor;
		expect(cursor).toBeNull();
		await act(async () =>
			emit(
				connection([
					{
						type: "agent/item/started",
						sessionId: ROOT,
						agentId: CHILD_A,
						item: item("agent-live:answer", "live", CHILD_A, "2026-10-26T00:00:01.000Z"),
					},
				]),
			),
		);
		api.readAgentItems.mockResolvedValue({
			items: [boundary, item("saved", "durable", CHILD_A, "2026-10-26T00:00:01.000Z")],
			nextBeforeItemId: null,
		});
		await act(async () =>
			emit(connection([{ type: "agent/itemsChanged", sessionId: ROOT, agentId: CHILD_A, taskId: ROOT }])),
		);
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["older", "boundary", "saved"]);
		expect(observed.get("a")?.cursor).toBeNull();
	});

	it("keeps loaded older pages when a tail refresh returns an empty page", async () => {
		const { api, emit } = setup();
		const older = item("older", "older page", CHILD_A, "2026-10-25T00:00:00.000Z");
		const boundary = item("boundary", "boundary", CHILD_A, DATE);
		api.readAgentItems.mockImplementation(({ beforeItemId }: { beforeItemId: string | null }) =>
			Promise.resolve(
				beforeItemId
					? { items: [older], nextBeforeItemId: null }
					: { items: [boundary], nextBeforeItemId: "cursor-1" },
			),
		);
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		await act(async () => observed.get("a")?.loadOlder());
		await settle();
		api.readAgentItems.mockResolvedValue({ items: [], nextBeforeItemId: null });
		await act(async () =>
			emit(connection([{ type: "agent/itemsChanged", sessionId: ROOT, agentId: CHILD_A, taskId: ROOT }])),
		);
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["older", "boundary"]);
	});

	it("switches roots without leaking the previous child history", async () => {
		const { api } = setup();
		const otherRoot = "44444444-4444-4444-8444-444444444444";
		api.readAgentItems.mockImplementation(({ sessionId }: { sessionId: string }) =>
			Promise.resolve({
				items: [item(sessionId === ROOT ? "root-a" : "root-b", sessionId, CHILD_A)],
				nextBeforeItemId: null,
			}),
		);
		const mounted = await mount(api, [{ label: "a", agentId: CHILD_A }]);
		await mounted.render();
		await settle();
		expect(observed.get("a")?.items[0]?.itemId).toBe("root-a");
		await mounted.render([{ label: "a", agentId: CHILD_A, sessionId: otherRoot }]);
		await settle();
		expect(observed.get("a")?.items.map((entry) => entry.itemId)).toEqual(["root-b"]);
	});

	it("retries a failed load through the stable reload", async () => {
		const { api } = setup();
		api.readAgentItems.mockRejectedValueOnce(new Error("history unavailable"));
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		expect(observed.get("a")?.error).toBeInstanceOf(Error);
		const reload = observed.get("a")?.reload;
		api.readAgentItems.mockResolvedValue({ items: [item("saved", "recovered", CHILD_A)], nextBeforeItemId: null });
		await act(async () => reload?.());
		await settle();
		expect(observed.get("a")?.error).toBeUndefined();
		expect(observed.get("a")?.items[0]?.itemId).toBe("saved");
		expect(observed.get("a")?.reload).toBe(reload);
	});

	it("is StrictMode-safe and stops refreshing after unmount", async () => {
		const { api, emit, listeners } = setup();
		const mounted = await mount(api, [{ label: "a", agentId: CHILD_A }], true);
		await mounted.render();
		await settle();
		expect(observed.get("a")?.items[0]?.itemId).toBe("first");
		await act(async () => mounted.root.unmount());
		await settle();
		expect(listeners.size).toBe(0);
		const reads = api.readAgentItems.mock.calls.length;
		await act(async () =>
			emit(connection([{ type: "agent/updated", sessionId: ROOT, agent: child(CHILD_A, "done") }])),
		);
		expect(api.readAgentItems).toHaveBeenCalledTimes(reads);
	});
});

it("retries a queued reconnect refresh after an old in-flight history request rejects", async () => {
	const { api, emit } = setup();
	const pending = deferred<Awaited<ReturnType<MetisDesktopApi["readAgentItems"]>>>();
	api.readAgentItems
		.mockImplementationOnce(() => pending.promise)
		.mockResolvedValue({ items: [item("terminal", "durable final reply")], nextBeforeItemId: null });
	const view = mount(api);
	await view.render();
	await act(async () => {
		emit(supervisor("restarting"));
		emit(supervisor("ready", "epoch-2"));
		pending.reject(new Error("old connection closed"));
	});
	await settle();
	expect(api.readAgentItems).toHaveBeenCalledTimes(2);
	expect(observed.get("a")?.items[0]?.itemId).toBe("terminal");
	expect(observed.get("a")?.error).toBeUndefined();
});
