import type { DesktopApiEvent, MetisDesktopApi } from "../../shared/desktop-api.ts";

type CatalogApi = Pick<MetisDesktopApi, "subscribe">;
type Listener = (event: DesktopApiEvent) => void;

const hubs = new WeakMap<CatalogApi, AgentCatalogEvents>();

/** One validated IPC subscription per API; unrelated message deltas never reach catalog stores. */
class AgentCatalogEvents {
	private readonly api: CatalogApi;
	private readonly listeners = new Map<string, Listener>();
	private epochEvent: DesktopApiEvent | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(api: CatalogApi) {
		this.api = api;
	}

	subscribe(sessionId: string, listener: Listener): () => void {
		this.listeners.set(sessionId, listener);
		if (this.epochEvent) listener(this.epochEvent);
		this.unsubscribe ??= this.api.subscribe((event) => this.receive(event));
		return () => {
			if (this.listeners.get(sessionId) !== listener) return;
			this.listeners.delete(sessionId);
			if (this.listeners.size > 0) return;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			hubs.delete(this.api);
		};
	}

	private receive(event: DesktopApiEvent): void {
		if (event.type === "supervisor") {
			for (const listener of this.listeners.values()) listener(event);
			return;
		}
		if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
		const batch = event.envelope.params;
		const previous = this.epochEvent;
		const epochChanged =
			!previous ||
			(previous.type === "app-server" &&
				previous.envelope.method === "connection/events" &&
				previous.envelope.params.serverEpoch !== batch.serverEpoch);
		const grouped = new Map<string, (typeof batch.events)[number][]>();
		for (const change of batch.events) {
			if (change.type !== "agent/updated" && change.type !== "agent/deleted") continue;
			const events = grouped.get(change.sessionId) ?? [];
			events.push(change);
			grouped.set(change.sessionId, events);
		}
		for (const [sessionId, events] of grouped) {
			this.listeners.get(sessionId)?.({ ...event, envelope: { ...event.envelope, params: { ...batch, events } } });
		}
		if (epochChanged) {
			this.epochEvent = { ...event, envelope: { ...event.envelope, params: { ...batch, events: [] } } };
			for (const listener of this.listeners.values()) listener(this.epochEvent);
		}
	}
}

export function subscribeAgentCatalogEvents(api: CatalogApi, sessionId: string, listener: Listener): () => void {
	let hub = hubs.get(api);
	if (!hub) {
		hub = new AgentCatalogEvents(api);
		hubs.set(api, hub);
	}
	return hub.subscribe(sessionId, listener);
}
