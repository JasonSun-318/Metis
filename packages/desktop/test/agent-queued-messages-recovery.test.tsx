// @vitest-environment jsdom
import type { AgentSummaryView, ClientResult, QueuedTurnView } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentQueuedMessages } from "../src/renderer/hooks/use-agent-queued-messages.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "44444444-4444-4444-8444-444444444444";
const CHILD_A = "22222222-2222-4222-8222-222222222222";
const CHILD_B = "33333333-3333-4333-8333-333333333333";
const EPOCH = "epoch-1";
const DATE = "2026-10-26T00:00:00.000Z";
type QueueResult = ClientResult<"agent/queue/read">;
type QueueApi = Pick<MetisDesktopApi, "readAgentQueuedMessages" | "subscribe">;
type QueueSnapshot = ReturnType<typeof useAgentQueuedMessages>;

function queued(id: string): QueuedTurnView {
	return { queueItemId: id, revision: `${id}-revision`, state: "queued", text: id, attachments: [] };
}

function result(...ids: string[]): QueueResult {
	return { queuedTurns: ids.map(queued) };
}

function child(agentId = CHILD_A): AgentSummaryView {
	return {
		agentId,
		name: agentId,
		parentSessionId: SESSION,
		rootSessionId: SESSION,
		agentPath: [agentId],
		depth: 1,
		agentType: "worker",
		status: "running",
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: DATE,
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

function supervisor(state: "ready" | "restarting", serverEpoch = EPOCH): DesktopApiEvent {
	return {
		type: "supervisor",
		view: { state, serverEpoch, restartAttempt: state === "restarting" ? 1 : 0, failure: null },
	};
}

function updated(agentId = CHILD_A, sessionId = SESSION): DesktopApiEvent {
	return connection([{ type: "agent/updated", sessionId, agent: child(agentId) }]);
}

function deleted(agentId = CHILD_A, sessionId = SESSION): DesktopApiEvent {
	return connection([{ type: "agent/deleted", sessionId, deletedAgentIds: [agentId] }]);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function setup() {
	const listeners = new Set<(event: DesktopApiEvent) => void>();
	const api = {
		readAgentQueuedMessages: vi.fn<QueueApi["readAgentQueuedMessages"]>().mockResolvedValue(result("initial")),
		subscribe: vi.fn((listener: (event: DesktopApiEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}),
	} satisfies QueueApi;
	const emit = (event: DesktopApiEvent) => {
		for (const listener of listeners) listener(event);
	};
	return { api, listeners, emit };
}

interface ProbeIdentity {
	readonly label: string;
	readonly agentId: string;
	readonly sessionId?: string;
}

const observed = new Map<string, QueueSnapshot>();
const renders = new Map<string, QueueSnapshot[]>();
function Probe({ api, label, agentId, sessionId = SESSION }: ProbeIdentity & { readonly api: QueueApi }) {
	const snapshot = useAgentQueuedMessages(api, sessionId, agentId);
	observed.set(label, snapshot);
	const history = renders.get(label) ?? [];
	history.push(snapshot);
	renders.set(label, history);
	return <output data-probe={label}>{snapshot.turns.map((turn) => turn.queueItemId).join("|")}</output>;
}

const roots = new Set<Root>();
function mount(api: QueueApi, probes: readonly ProbeIdentity[] = [{ label: "a", agentId: CHILD_A }], strict = false) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.add(root);
	const render = async (next = probes) => {
		const children = next.map((probe) => <Probe api={api} key={probe.label} {...probe} />);
		await act(async () => root.render(strict ? <StrictMode>{children}</StrictMode> : children));
	};
	const unmount = async () => {
		await act(async () => root.unmount());
		roots.delete(root);
	};
	return { container, render, unmount };
}

function ids(label = "a"): string[] {
	return observed.get(label)?.turns.map((turn) => turn.queueItemId) ?? [];
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	observed.clear();
	renders.clear();
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.clear();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("useAgentQueuedMessages recovery", () => {
	it("isolates sibling queues and the same child identity under a different root", async () => {
		const { api, emit } = setup();
		api.readAgentQueuedMessages.mockImplementation(async ({ sessionId, agentId }) =>
			result(`${sessionId}-${agentId}`),
		);
		const mounted = mount(api, [
			{ label: "a", agentId: CHILD_A },
			{ label: "b", agentId: CHILD_B },
			{ label: "other-root", agentId: CHILD_A, sessionId: OTHER_SESSION },
		]);
		await mounted.render();
		await settle();
		expect(ids("a")).toEqual([`${SESSION}-${CHILD_A}`]);
		expect(ids("b")).toEqual([`${SESSION}-${CHILD_B}`]);
		expect(ids("other-root")).toEqual([`${OTHER_SESSION}-${CHILD_A}`]);
		api.readAgentQueuedMessages.mockClear().mockResolvedValue(result("updated-a"));
		await act(async () => emit(updated()));
		await settle();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, agentId: CHILD_A });
		expect(ids("a")).toEqual(["updated-a"]);
		expect(ids("b")).toEqual([`${SESSION}-${CHILD_B}`]);
		expect(ids("other-root")).toEqual([`${OTHER_SESSION}-${CHILD_A}`]);
	});

	it("never exposes an old child's pending response after navigation", async () => {
		const { api, listeners } = setup();
		const old = deferred<QueueResult>();
		const current = deferred<QueueResult>();
		api.readAgentQueuedMessages.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		const mounted = mount(api);
		await mounted.render();
		await mounted.render([{ label: "a", agentId: CHILD_B }]);
		expect(ids()).toEqual([]);
		expect(observed.get("a")?.loading).toBe(true);
		expect(listeners.size).toBe(1);
		await act(async () => current.resolve(result("child-b")));
		await act(async () => old.resolve(result("stale-child-a")));
		await settle();
		expect(ids()).toEqual(["child-b"]);
		expect(renders.get("a")?.some((entry) => entry.turns.some((turn) => turn.queueItemId === "stale-child-a"))).toBe(
			false,
		);
	});

	it("recovers after same-epoch reconnect and new-epoch ready without repeated ready reads", async () => {
		const { api, emit } = setup();
		const mounted = mount(api);
		await mounted.render();
		await act(async () => emit(supervisor("ready")));
		await settle();
		api.readAgentQueuedMessages.mockClear().mockResolvedValue(result("same-epoch"));
		await act(async () => {
			emit(supervisor("restarting"));
			emit(supervisor("ready"));
		});
		await settle();
		expect(ids()).toEqual(["same-epoch"]);
		expect(api.readAgentQueuedMessages).toHaveBeenCalledOnce();
		api.readAgentQueuedMessages.mockResolvedValue(result("new-epoch"));
		await act(async () => emit(supervisor("ready", "epoch-2")));
		await settle();
		expect(ids()).toEqual(["new-epoch"]);
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
		await act(async () => emit(supervisor("ready", "epoch-2")));
		await settle();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
	});

	it("refreshes on an event epoch change even when the event concerns another child", async () => {
		const { api, emit } = setup();
		const mounted = mount(api);
		await mounted.render();
		await act(async () => emit(supervisor("ready")));
		await settle();
		api.readAgentQueuedMessages.mockClear().mockResolvedValue(result("new-server-queue"));
		await act(async () =>
			emit(connection([{ type: "agent/itemsChanged", sessionId: SESSION, agentId: CHILD_B }], "epoch-2")),
		);
		await settle();
		expect(ids()).toEqual(["new-server-queue"]);
		expect(api.readAgentQueuedMessages).toHaveBeenCalledOnce();
	});

	it("coalesces cold-read updates and withholds the stale result until reconciliation completes", async () => {
		const { api, emit } = setup();
		const cold = deferred<QueueResult>();
		const fresh = deferred<QueueResult>();
		api.readAgentQueuedMessages.mockReturnValueOnce(cold.promise).mockReturnValueOnce(fresh.promise);
		const mounted = mount(api);
		await mounted.render();
		await act(async () => {
			for (let index = 0; index < 8; index++) emit(updated());
			emit(connection([{ type: "agent/itemsChanged", sessionId: SESSION, agentId: CHILD_A }]));
		});
		expect(api.readAgentQueuedMessages).toHaveBeenCalledOnce();
		await act(async () => cold.resolve(result("stale-pending-message")));
		await settle();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
		expect(ids()).toEqual([]);
		expect(observed.get("a")?.loading).toBe(true);
		expect(
			renders.get("a")?.some((entry) => entry.turns.some((turn) => turn.queueItemId === "stale-pending-message")),
		).toBe(false);
		await act(async () => fresh.resolve(result("current-message")));
		await settle();
		expect(ids()).toEqual(["current-message"]);
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
	});

	it("does not lose a queued refresh when the pre-reconnect request rejects", async () => {
		const { api, emit } = setup();
		const cold = deferred<QueueResult>();
		const fresh = deferred<QueueResult>();
		api.readAgentQueuedMessages.mockReturnValueOnce(cold.promise).mockReturnValueOnce(fresh.promise);
		const mounted = mount(api);
		await mounted.render();
		await act(async () => {
			emit(supervisor("restarting"));
			emit(supervisor("ready"));
		});
		await act(async () => cold.reject(new Error("old transport closed")));
		await settle();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
		await act(async () => fresh.resolve(result("recovered-message")));
		await settle();
		expect(ids()).toEqual(["recovered-message"]);
		expect(observed.get("a")?.error).toBeUndefined();
	});

	it("retains the last durable queue on refresh failure and recovers through the stable reload callback", async () => {
		const { api, emit } = setup();
		const mounted = mount(api);
		await mounted.render();
		await settle();
		const reload = observed.get("a")!.reload;
		const error = new Error("temporarily offline");
		api.readAgentQueuedMessages.mockRejectedValueOnce(error);
		await act(async () => emit(updated()));
		await settle();
		expect(ids()).toEqual(["initial"]);
		expect(observed.get("a")?.error).toBe(error);
		expect(observed.get("a")?.loading).toBe(false);
		expect(observed.get("a")?.reload).toBe(reload);
		api.readAgentQueuedMessages.mockResolvedValueOnce(result("recovered"));
		await act(async () => reload());
		await settle();
		expect(ids()).toEqual(["recovered"]);
		expect(observed.get("a")?.error).toBeUndefined();
	});

	it.each(["resolve", "reject"] as const)(
		"a deletion clears the queue and dominates a later in-flight %s",
		async (outcome) => {
			const { api, emit } = setup();
			const mounted = mount(api);
			await mounted.render();
			await settle();
			const pending = deferred<QueueResult>();
			api.readAgentQueuedMessages.mockReturnValueOnce(pending.promise);
			await act(async () => observed.get("a")?.reload());
			await act(async () => emit(deleted()));
			expect(ids()).toEqual([]);
			expect(observed.get("a")?.loading).toBe(false);
			if (outcome === "resolve") await act(async () => pending.resolve(result("deleted-agent-queue")));
			else await act(async () => pending.reject(new Error("deleted agent read was cancelled")));
			await settle();
			expect(ids()).toEqual([]);
			expect(observed.get("a")?.error).toBeUndefined();
			const reads = api.readAgentQueuedMessages.mock.calls.length;
			await act(async () => {
				emit(updated());
				emit(supervisor("ready", "epoch-2"));
				observed.get("a")?.reload();
			});
			await settle();
			expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(reads);
		},
	);

	it("ignores deletion events for sibling children and other roots", async () => {
		const { api, emit } = setup();
		const mounted = mount(api);
		await mounted.render();
		await settle();
		api.readAgentQueuedMessages.mockClear();
		await act(async () => {
			emit(deleted(CHILD_B));
			emit(deleted(CHILD_A, OTHER_SESSION));
		});
		await settle();
		expect(ids()).toEqual(["initial"]);
		expect(api.readAgentQueuedMessages).not.toHaveBeenCalled();
	});

	it("cleans StrictMode subscriptions and ignores old responses and reloads after unmount", async () => {
		const { api, listeners, emit } = setup();
		const abandoned = deferred<QueueResult>();
		const current = deferred<QueueResult>();
		api.readAgentQueuedMessages.mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(current.promise);
		const mounted = mount(api, undefined, true);
		await mounted.render();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
		expect(listeners.size).toBe(1);
		await act(async () => current.resolve(result("strict-current")));
		await act(async () => abandoned.resolve(result("strict-abandoned")));
		await settle();
		expect(ids()).toEqual(["strict-current"]);
		const reload = observed.get("a")!.reload;
		const renderCount = renders.get("a")!.length;
		await mounted.unmount();
		expect(listeners.size).toBe(0);
		await act(async () => {
			emit(updated());
			reload();
		});
		await settle();
		expect(api.readAgentQueuedMessages).toHaveBeenCalledTimes(2);
		expect(renders.get("a")).toHaveLength(renderCount);
	});
});
