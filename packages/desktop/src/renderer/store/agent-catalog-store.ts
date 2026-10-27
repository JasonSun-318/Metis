import type { AgentSummaryView } from "@metis/app-protocol";
import type { DesktopApiEvent, MetisDesktopApi } from "../../shared/desktop-api.ts";

export interface AgentCatalogSnapshot {
	readonly version: number;
	readonly agents: readonly AgentSummaryView[];
	readonly loading: boolean;
	readonly error: unknown;
	readonly unreadableAgentCount: number;
}

export interface AgentCatalogStore {
	readonly getSnapshot: () => AgentCatalogSnapshot;
	readonly subscribe: (listener: () => void) => () => void;
	readonly reload: () => void;
}

type AgentCatalogApi = Pick<MetisDesktopApi, "listAgents" | "subscribe">;

export function mergeAgentCatalog(
	current: readonly AgentSummaryView[],
	incoming: readonly AgentSummaryView[],
): AgentSummaryView[] {
	const agents = new Map(current.map((agent) => [agent.agentId, agent]));
	for (const agent of incoming) {
		const previous = agents.get(agent.agentId);
		if (!previous || previous.updatedAt <= agent.updatedAt) agents.set(agent.agentId, agent);
	}
	return [...agents.values()]
		.filter((agent) => !agent.archived)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentId.localeCompare(b.agentId));
}

function sameAgents(left: readonly AgentSummaryView[], right: readonly AgentSummaryView[]): boolean {
	return left.length === right.length && left.every((agent, index) => agent === right[index]);
}

/**
 * Durable catalog facts for one API/root pair. The instance survives subscriber
 * churn, but its API subscription exists only while at least one view listens.
 */
class SharedAgentCatalogStore implements AgentCatalogStore {
	private readonly snapshotListeners = new Map<() => void, number>();
	private agents: readonly AgentSummaryView[] = [];
	private loading = true;
	private error: unknown;
	private unreadableAgentCount = 0;
	private version = 0;
	private snapshot: AgentCatalogSnapshot = this.createSnapshot();
	private started = false;
	private references = 0;
	private disposed = false;
	private settleScheduled = false;
	private generation = 0;
	private reading = false;
	private requested = false;
	private activeLiveUpdates: Map<string, AgentSummaryView> | undefined;
	private readonly deleted = new Set<string>();
	private knownEpoch: string | null | undefined;
	private supervisorState: "stopped" | "starting" | "ready" | "restarting" | "failed" | "shuttingDown" | undefined;
	private unsubscribe: (() => void) | undefined;
	private readonly api: AgentCatalogApi;
	private readonly sessionId: string;
	private readonly onDispose: (store: SharedAgentCatalogStore) => void;

	constructor(api: AgentCatalogApi, sessionId: string, onDispose: (store: SharedAgentCatalogStore) => void) {
		this.api = api;
		this.sessionId = sessionId;
		this.onDispose = onDispose;
	}

	retain = (): void => {
		if (this.disposed) return;
		this.references += 1;
		this.settleScheduled = false;
	};

	release = (): void => {
		if (this.disposed) return;
		this.references = Math.max(0, this.references - 1);
		this.scheduleSettle();
	};

	subscribe = (listener: () => void): (() => void) => {
		if (this.disposed) return () => undefined;
		this.snapshotListeners.set(listener, (this.snapshotListeners.get(listener) ?? 0) + 1);
		this.settleScheduled = false;
		this.start();
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			const count = this.snapshotListeners.get(listener) ?? 0;
			if (count <= 1) this.snapshotListeners.delete(listener);
			else this.snapshotListeners.set(listener, count - 1);
			if (this.snapshotListeners.size === 0) this.scheduleSettle();
		};
	};

	getSnapshot = (): AgentCatalogSnapshot => this.snapshot;

	reload = (): void => {
		if (this.started) this.request();
	};

	private start(): void {
		if (this.disposed || this.started || this.snapshotListeners.size === 0) return;
		this.started = true;
		this.unsubscribe = this.api.subscribe((event) => this.handleEvent(event));
		this.request();
	}

	private stop(): void {
		if (!this.started) return;
		this.started = false;
		this.generation += 1;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.reading = false;
		this.requested = false;
		this.activeLiveUpdates = undefined;
	}

	private scheduleSettle(): void {
		if (this.settleScheduled || this.disposed) return;
		this.settleScheduled = true;
		queueMicrotask(() => {
			if (this.disposed) return;
			this.settleScheduled = false;
			if (this.snapshotListeners.size === 0) this.stop();
			if (this.snapshotListeners.size === 0 && this.references === 0) this.dispose();
		});
	}

	private dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
		this.snapshotListeners.clear();
		this.onDispose(this);
	}

	private handleEvent(event: DesktopApiEvent): void {
		if (!this.started) return;
		if (event.type === "supervisor") {
			const previousState = this.supervisorState;
			const previousEpoch = this.knownEpoch;
			const epochChanged = previousEpoch !== undefined && event.view.serverEpoch !== previousEpoch;
			this.supervisorState = event.view.state;
			this.knownEpoch = event.view.serverEpoch;
			if (event.view.state === "ready" && (previousState !== "ready" || epochChanged)) this.request();
			return;
		}
		if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
		const batch = event.envelope.params;
		const epochChanged = this.knownEpoch !== undefined && batch.serverEpoch !== this.knownEpoch;
		this.knownEpoch = batch.serverEpoch;
		for (const change of batch.events) {
			if (!("sessionId" in change) || change.sessionId !== this.sessionId) continue;
			if (change.type === "agent/updated") {
				this.activeLiveUpdates?.set(change.agent.agentId, change.agent);
				this.applyAgents(mergeAgentCatalog(this.agents, [change.agent]));
			} else if (change.type === "agent/deleted") {
				for (const id of change.deletedAgentIds) {
					this.deleted.add(id);
					this.activeLiveUpdates?.delete(id);
				}
				this.applyAgents(this.agents.filter((agent) => !this.deleted.has(agent.agentId)));
			}
		}
		if (epochChanged) this.request();
	}

	private applyAgents(agents: readonly AgentSummaryView[]): void {
		if (sameAgents(this.agents, agents)) return;
		this.agents = agents;
		this.commit();
	}

	private request(): void {
		if (!this.started) return;
		if (this.reading) {
			this.requested = true;
			return;
		}
		this.reading = true;
		this.requested = true;
		const generation = this.generation;
		if (!this.loading || this.error !== undefined) {
			this.loading = true;
			this.error = undefined;
			this.commit();
		}
		void (async () => {
			try {
				while (this.requested && this.generation === generation) {
					this.requested = false;
					const liveUpdates = new Map<string, AgentSummaryView>();
					this.activeLiveUpdates = liveUpdates;
					const collected: AgentSummaryView[] = [];
					const cursors = new Set<string>();
					let afterAgentId: string | undefined;
					let unreadableAgentCount = this.unreadableAgentCount;
					do {
						const page = await this.api.listAgents({
							sessionId: this.sessionId,
							limit: 100,
							...(afterAgentId ? { afterAgentId } : {}),
						});
						if (this.generation !== generation) return;
						collected.push(...page.agents);
						unreadableAgentCount = page.unreadableAgentCount ?? 0;
						afterAgentId = page.nextAfterAgentId ?? undefined;
						if (afterAgentId && cursors.has(afterAgentId)) throw new Error("Repeated agent catalog cursor");
						if (afterAgentId) cursors.add(afterAgentId);
					} while (afterAgentId);
					this.activeLiveUpdates = undefined;
					const readable = unreadableAgentCount > 0 ? mergeAgentCatalog(this.agents, collected) : collected;
					this.agents = mergeAgentCatalog(readable, [...liveUpdates.values()]).filter(
						(agent) => !this.deleted.has(agent.agentId),
					);
					this.unreadableAgentCount = unreadableAgentCount;
					this.error = undefined;
					this.loading = false;
					this.commit();
				}
			} catch (cause) {
				if (this.generation !== generation) return;
				this.activeLiveUpdates = undefined;
				this.error = cause;
				this.loading = false;
				this.commit();
			} finally {
				if (this.generation === generation) {
					this.reading = false;
					if (this.requested) this.request();
				}
			}
		})();
	}

	private commit(): void {
		this.version += 1;
		this.snapshot = this.createSnapshot();
		for (const listener of this.snapshotListeners.keys()) listener();
	}

	private createSnapshot(): AgentCatalogSnapshot {
		return {
			version: this.version,
			agents: this.agents,
			loading: this.loading,
			error: this.error,
			unreadableAgentCount: this.unreadableAgentCount,
		};
	}
}

const stores = new WeakMap<AgentCatalogApi, Map<string, SharedAgentCatalogStore>>();
const handles = new WeakMap<SharedAgentCatalogStore, AgentCatalogHandle>();

export interface AgentCatalogHandle {
	readonly store: AgentCatalogStore;
	/** Keeps the store instance alive; the API listener is still owned by subscriptions. */
	retain(): void;
	release(): void;
}

/**
 * Stable handle for one API/root pair. Acquisition only allocates the shared
 * instance; it never retains, starts I/O, or installs an API listener in render.
 */
export function acquireAgentCatalog(api: AgentCatalogApi, sessionId: string): AgentCatalogHandle {
	let bySession = stores.get(api);
	if (!bySession) {
		bySession = new Map();
		stores.set(api, bySession);
	}
	const existing = bySession.get(sessionId);
	if (existing) {
		const handle = handles.get(existing);
		if (handle) return handle;
	}
	const store = new SharedAgentCatalogStore(api, sessionId, (disposed) => {
		if (bySession.get(sessionId) !== disposed) return;
		bySession.delete(sessionId);
		if (bySession.size === 0) stores.delete(api);
	});
	const handle: AgentCatalogHandle = { store, retain: store.retain, release: store.release };
	handles.set(store, handle);
	bySession.set(sessionId, store);
	return handle;
}
