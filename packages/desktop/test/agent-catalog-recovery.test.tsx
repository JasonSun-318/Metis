// @vitest-environment jsdom
import type { AgentSummaryView } from "@metis/app-protocol";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentCatalog } from "../src/renderer/hooks/use-agent-catalog.ts";
import { acquireAgentCatalog } from "../src/renderer/store/agent-catalog-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const OTHER_ROOT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const DATE = "2026-10-26T00:00:00.000Z";
const EPOCH = "epoch-1";

function agent(id = CHILD, root = ROOT, status: AgentSummaryView["status"] = "running"): AgentSummaryView {
	return {
		agentId: id,
		name: id,
		parentSessionId: root,
		rootSessionId: root,
		agentPath: [id],
		depth: 1,
		agentType: "worker",
		status,
		archived: false,
		tasks: [],
		createdAt: DATE,
		updatedAt: status === "running" ? DATE : "2026-10-26T00:00:01.000Z",
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
		listAgents: vi.fn().mockResolvedValue({ agents: [agent()], nextAfterAgentId: null }),
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

type CatalogResult = ReturnType<typeof useAgentCatalog>;
const observed = new Map<string, CatalogResult>();
function Probe({
	api,
	label,
	sessionId = ROOT,
}: {
	readonly api: Pick<MetisDesktopApi, "listAgents" | "subscribe">;
	readonly label: string;
	readonly sessionId?: string;
}) {
	const catalog = useAgentCatalog(api, sessionId);
	observed.set(label, catalog);
	return (
		<div data-probe={label}>
			{catalog.loading
				? "loading"
				: catalog.error
					? "error"
					: catalog.agents.map((entry) => `${entry.agentId}:${entry.status}`).join(",")}
		</div>
	);
}

const roots: Root[] = [];
function mount(
	api: Pick<MetisDesktopApi, "listAgents" | "subscribe">,
	probes: readonly { label: string; sessionId?: string }[] = [{ label: "body" }],
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
							<Probe api={api} key={probe.label} label={probe.label} sessionId={probe.sessionId} />
						))}
					</StrictMode>
				) : (
					next.map((probe) => (
						<Probe api={api} key={probe.label} label={probe.label} sessionId={probe.sessionId} />
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

describe("useAgentCatalog recovery", () => {
	it("shares one catalog between consumers and converges both on reload", async () => {
		const { api } = setup();
		const mounted = await mount(api, [{ label: "body" }, { label: "sidebar" }]);
		const { container } = mounted;
		await mounted.render();
		await settle();
		expect(container.textContent).toContain(`${CHILD}:running`);
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		expect(observed.get("body")?.reload).toBe(observed.get("sidebar")?.reload);

		api.listAgents.mockResolvedValue({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
		await act(async () => observed.get("body")?.reload());
		await settle();
		expect(observed.get("body")?.agents[0]?.status).toBe("done");
		expect(observed.get("sidebar")?.agents[0]?.status).toBe("done");
		expect(api.listAgents).toHaveBeenCalledTimes(2);
		const stableAgents = observed.get("body")?.agents;
		expect(observed.get("sidebar")?.agents).toBe(stableAgents);
		await mounted.render();
		expect(observed.get("body")?.agents).toBe(stableAgents);
	});

	it("recovers completion during a same-epoch supervisor reconnect", async () => {
		const { api, emit } = setup();
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		api.listAgents.mockResolvedValue({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
		await act(async () => emit(supervisor("restarting")));
		await act(async () => emit(supervisor("ready")));
		await settle();
		expect(observed.get("body")?.agents[0]?.status).toBe("done");
	});

	it("recovers completion after the server epoch changes", async () => {
		const { api, emit } = setup();
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		await act(async () => emit(supervisor("ready", EPOCH)));
		await settle();
		api.listAgents.mockResolvedValue({ agents: [agent(CHILD, ROOT, "failed")], nextAfterAgentId: null });
		await act(async () => emit(supervisor("ready", "epoch-2")));
		await settle();
		expect(observed.get("body")?.agents[0]?.status).toBe("failed");
	});

	it("does not let a stale cold read resurrect an agent deleted while it was in flight", async () => {
		const { api, emit } = setup();
		const pending = deferred<{ agents: AgentSummaryView[]; nextAfterAgentId: null }>();
		api.listAgents.mockReturnValue(pending.promise);
		const mounted = await mount(api);
		await mounted.render();
		await vi.waitFor(() => expect(api.listAgents).toHaveBeenCalledOnce());
		await act(async () =>
			emit(connection([{ type: "agent/deleted", sessionId: ROOT, agentId: CHILD, deletedAgentIds: [CHILD] }])),
		);
		pending.resolve({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
		await settle();
		expect(observed.get("body")?.agents).toEqual([]);
	});

	it("retries a failed load through the stable reload", async () => {
		const { api } = setup();
		api.listAgents.mockRejectedValueOnce(new Error("catalog unavailable"));
		const mounted = await mount(api);
		await mounted.render();
		await settle();
		expect(observed.get("body")?.error).toBeInstanceOf(Error);
		api.listAgents.mockResolvedValue({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
		await act(async () => observed.get("body")?.reload());
		await settle();
		expect(observed.get("body")?.error).toBeUndefined();
		expect(observed.get("body")?.agents[0]?.status).toBe("done");
	});

	it("is StrictMode-safe and releases its shared subscription", async () => {
		const { api, emit, listeners } = setup();
		const mounted = await mount(api, [{ label: "body" }, { label: "sidebar" }], true);
		await mounted.render();
		await settle();
		expect(observed.get("body")?.agents[0]?.status).toBe("running");
		expect(observed.get("sidebar")?.agents[0]?.status).toBe("running");
		expect(api.listAgents).toHaveBeenCalledTimes(1);
		await act(async () => mounted.root.unmount());
		await settle();
		expect(listeners.size).toBe(0);
		const calls = api.listAgents.mock.calls.length;
		await act(async () => emit(supervisor("ready", "epoch-2")));
		expect(api.listAgents).toHaveBeenCalledTimes(calls);
	});

	it("exposes one stable handle that does not start until retained or subscribed", async () => {
		const { api, listeners } = setup();
		const handle = acquireAgentCatalog(api, ROOT);
		const store = handle.store;
		expect(acquireAgentCatalog(api, ROOT)).toBe(handle);
		expect(store.getSnapshot()).toBe(store.getSnapshot());
		expect(api.listAgents).not.toHaveBeenCalled();
		expect(listeners.size).toBe(0);
		handle.retain();
		let notifications = 0;
		const unsubscribe = store.subscribe(() => {
			notifications += 1;
		});
		await settle();
		expect(store.getSnapshot().agents[0]?.status).toBe("running");
		expect(notifications).toBeGreaterThan(0);
		expect(listeners.size).toBe(1);
		unsubscribe();
		await settle();
		expect(listeners.size).toBe(0);
		expect(acquireAgentCatalog(api, ROOT)).toBe(handle);
		const reads = api.listAgents.mock.calls.length;
		api.listAgents.mockResolvedValue({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
		const unsubscribeAgain = store.subscribe(() => undefined);
		await settle();
		expect(store.getSnapshot().agents[0]?.status).toBe("done");
		expect(api.listAgents.mock.calls.length).toBeGreaterThan(reads);
		expect(listeners.size).toBe(1);
		unsubscribeAgain();
		handle.release();
		await settle();
		expect(listeners.size).toBe(0);
		expect(acquireAgentCatalog(api, ROOT)).not.toBe(handle);
	});

	it("isolates catalogs when the root changes", async () => {
		const { api } = setup();
		api.listAgents.mockImplementation(({ sessionId }: { sessionId: string }) =>
			Promise.resolve({ agents: [agent(CHILD, sessionId, "done")], nextAfterAgentId: null }),
		);
		const mounted = await mount(api, [{ label: "body", sessionId: ROOT }]);
		await mounted.render();
		await settle();
		expect(observed.get("body")?.agents[0]?.rootSessionId).toBe(ROOT);
		await mounted.render([{ label: "body", sessionId: OTHER_ROOT }]);
		await settle();
		expect(observed.get("body")?.agents[0]?.rootSessionId).toBe(OTHER_ROOT);
	});
});

it("retries a queued reconnect refresh after an old in-flight catalog request rejects", async () => {
	const { api, emit } = setup();
	const pending = deferred<Awaited<ReturnType<MetisDesktopApi["listAgents"]>>>();
	api.listAgents
		.mockImplementationOnce(() => pending.promise)
		.mockResolvedValue({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
	const view = mount(api);
	await view.render();
	await act(async () => {
		emit(supervisor("restarting"));
		emit(supervisor("ready", "epoch-2"));
		pending.reject(new Error("old connection closed"));
	});
	await settle();
	expect(api.listAgents).toHaveBeenCalledTimes(2);
	expect(observed.get("body")?.agents[0]?.status).toBe("done");
	expect(observed.get("body")?.error).toBeUndefined();
});

it("keeps known activity when a recovery catalog contains unreadable entries", async () => {
	const { api } = setup();
	const view = mount(api);
	await view.render();
	api.listAgents.mockResolvedValueOnce({ agents: [], nextAfterAgentId: null, unreadableAgentCount: 1 });
	await act(async () => observed.get("body")?.reload());
	await settle();
	expect(observed.get("body")?.agents[0]?.status).toBe("running");
	expect(observed.get("body")?.unreadableAgentCount).toBe(1);
	api.listAgents.mockResolvedValueOnce({ agents: [agent(CHILD, ROOT, "done")], nextAfterAgentId: null });
	await act(async () => observed.get("body")?.reload());
	await settle();
	expect(observed.get("body")?.agents[0]?.status).toBe("done");
});
