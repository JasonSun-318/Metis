import type { DomainEvent, ScheduleSnapshotView, SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import type { OutboundQueue, OutboundStage } from "./outbound-queue.ts";
import { AppServerError, type OpenedSessionRuntime } from "./session-runtime-host.ts";

interface PublishedEvent {
	readonly cursor: number;
	readonly event: DomainEvent;
}

interface Subscriber {
	readonly outbound: OutboundQueue;
	readonly stage: OutboundStage;
	readonly invalidate: () => void;
	active: boolean;
	buffering: boolean;
}

interface SessionChannel {
	readonly runtime: OpenedSessionRuntime;
	readonly subscribers: Set<Subscriber>;
	readonly unsubscribeRuntime: () => void;
}

export interface PendingSessionSubscription {
	readonly snapshot: Promise<SessionSnapshot>;
	unsubscribe(): void;
}

interface PendingScheduleSubscription {
	readonly snapshot: Promise<ScheduleSnapshotView>;
	unsubscribe(): void;
}

/** Owns the one global event sequence and listener-first snapshot handoff. */
export class SessionSubscriptions {
	readonly serverEpoch: string;
	private readonly channels = new Map<string, SessionChannel>();
	private readonly connectionOutbounds = new Set<OutboundQueue>();
	private readonly scheduleSubscribers = new Set<Subscriber>();
	private readonly onSessionUpdated?: (session: SessionSummary) => void;
	private cursor = 0;

	constructor(serverEpoch: string, onSessionUpdated?: (session: SessionSummary) => void) {
		this.serverEpoch = serverEpoch;
		this.onSessionUpdated = onSessionUpdated;
	}

	currentCursor(): number {
		return this.cursor;
	}

	private channelFor(runtime: OpenedSessionRuntime): SessionChannel {
		const existing = this.channels.get(runtime.sessionId);
		if (existing) {
			if (existing.runtime !== runtime) {
				throw new AppServerError("SESSION_IN_USE", { sessionId: runtime.sessionId });
			}
			return existing;
		}

		const subscribers = new Set<Subscriber>();
		const channel: SessionChannel = {
			runtime,
			subscribers,
			unsubscribeRuntime: runtime.subscribe((event) => {
				if (event.type === "session/updated") this.onSessionUpdated?.(event.session);
				this.publish(subscribers, event);
			}),
		};
		this.channels.set(runtime.sessionId, channel);
		return channel;
	}

	private publish(subscribers: ReadonlySet<Subscriber>, event: DomainEvent): void {
		this.cursor += 1;
		const published: PublishedEvent = { cursor: this.cursor, event: structuredClone(event) };
		const delivered = new Set<OutboundQueue>();
		for (const subscriber of subscribers) {
			if (!subscriber.active) continue;
			delivered.add(subscriber.outbound);
			if (subscriber.buffering) subscriber.stage.enqueue(published.cursor, published.event);
			else subscriber.outbound.enqueue(published.cursor, published.event);
		}
		if (event.type === "session/updated") {
			for (const outbound of this.connectionOutbounds) {
				if (!delivered.has(outbound)) outbound.enqueue(published.cursor, structuredClone(published.event));
			}
		}
	}

	publishSessionUpdated(session: SessionSummary): void {
		this.publish(new Set(), { type: "session/updated", session });
	}

	publishSchedule(event: DomainEvent): void {
		this.publish(this.scheduleSubscribers, event);
	}

	registerConnection(outbound: OutboundQueue): () => void {
		this.connectionOutbounds.add(outbound);
		return () => this.connectionOutbounds.delete(outbound);
	}

	private publishToConnections(event: DomainEvent): void {
		this.cursor += 1;
		for (const outbound of this.connectionOutbounds) outbound.enqueue(this.cursor, structuredClone(event));
	}

	invalidateProject(event: Extract<DomainEvent, { type: "project/invalidated" }>): void {
		this.publishToConnections(event);
	}

	subscribeSchedule(
		outbound: OutboundQueue,
		invalidate: () => void,
		loadSnapshot: (cursor: number) => Promise<ScheduleSnapshotView>,
	): PendingScheduleSubscription {
		const subscriber: Subscriber = {
			outbound,
			stage: outbound.createStage(),
			invalidate,
			active: true,
			buffering: true,
		};
		this.scheduleSubscribers.add(subscriber);
		const unsubscribe = () => {
			if (!subscriber.active) return;
			subscriber.active = false;
			subscriber.stage.abort();
			this.scheduleSubscribers.delete(subscriber);
		};
		const snapshot = loadSnapshot(this.cursor)
			.then((value) => {
				if (!subscriber.active) throw new AppServerError("BUSY");
				subscriber.buffering = false;
				subscriber.stage.commit(value.cursor);
				return value;
			})
			.catch((error) => {
				unsubscribe();
				throw error;
			});
		return { snapshot, unsubscribe };
	}

	subscribe(
		runtime: OpenedSessionRuntime,
		outbound: OutboundQueue,
		invalidate: () => void,
	): PendingSessionSubscription {
		const channel = this.channelFor(runtime);
		const subscriber: Subscriber = {
			outbound,
			stage: outbound.createStage(),
			invalidate,
			active: true,
			buffering: true,
		};
		channel.subscribers.add(subscriber);

		const unsubscribe = () => {
			if (!subscriber.active) return;
			subscriber.active = false;
			subscriber.stage.abort();
			channel.subscribers.delete(subscriber);
		};

		const snapshot = runtime
			.snapshot(this.serverEpoch, () => this.cursor)
			.then((value) => {
				if (!subscriber.active) throw new AppServerError("BUSY", { sessionId: runtime.sessionId });
				subscriber.buffering = false;
				subscriber.stage.commit(value.cursor);
				return value;
			})
			.catch((error) => {
				unsubscribe();
				throw error;
			});

		return { snapshot, unsubscribe };
	}

	removeSession(sessionId: string, event?: Extract<DomainEvent, { type: "session/invalidated" }>): void {
		if (event) this.publishToConnections(event);
		const channel = this.channels.get(sessionId);
		if (!channel) return;
		this.channels.delete(sessionId);
		channel.unsubscribeRuntime();
		for (const subscriber of channel.subscribers) {
			subscriber.active = false;
			subscriber.stage.abort();
			subscriber.invalidate();
		}
		channel.subscribers.clear();
	}

	close(): void {
		for (const sessionId of [...this.channels.keys()]) this.removeSession(sessionId);
		this.connectionOutbounds.clear();
		for (const subscriber of this.scheduleSubscribers) {
			subscriber.active = false;
			subscriber.stage.abort();
			subscriber.invalidate();
		}
		this.scheduleSubscribers.clear();
	}
}

interface ConnectionSubscription {
	readonly token: object;
	readonly unsubscribe: () => void;
}

/** Connection-local view of session subscriptions and acknowledgements. */
export class ConnectionSubscriptions {
	private readonly hub: SessionSubscriptions;
	private readonly outbound: OutboundQueue;
	private readonly sessions = new Map<string, ConnectionSubscription>();
	private readonly unregisterConnection: () => void;
	private schedule?: ConnectionSubscription;
	private closed = false;

	constructor(hub: SessionSubscriptions, outbound: OutboundQueue) {
		this.hub = hub;
		this.outbound = outbound;
		this.unregisterConnection = hub.registerConnection(outbound);
	}

	async subscribe(runtime: OpenedSessionRuntime): Promise<SessionSnapshot> {
		if (this.closed) throw new AppServerError("BUSY", { sessionId: runtime.sessionId });
		this.unsubscribe(runtime.sessionId);
		const token = {};
		const pending = this.hub.subscribe(runtime, this.outbound, () => {
			if (this.sessions.get(runtime.sessionId)?.token === token) this.sessions.delete(runtime.sessionId);
		});
		const entry = { token, unsubscribe: pending.unsubscribe };
		this.sessions.set(runtime.sessionId, entry);
		try {
			const snapshot = await pending.snapshot;
			if (this.closed || this.sessions.get(runtime.sessionId) !== entry) {
				pending.unsubscribe();
				throw new AppServerError("BUSY", { sessionId: runtime.sessionId });
			}
			return snapshot;
		} catch (error) {
			if (this.sessions.get(runtime.sessionId) === entry) this.sessions.delete(runtime.sessionId);
			pending.unsubscribe();
			throw error;
		}
	}

	async subscribeSchedule(
		loadSnapshot: (cursor: number) => Promise<ScheduleSnapshotView>,
	): Promise<ScheduleSnapshotView> {
		if (this.closed) throw new AppServerError("BUSY");
		this.unsubscribeSchedule();
		const token = {};
		const pending = this.hub.subscribeSchedule(
			this.outbound,
			() => {
				if (this.schedule?.token === token) this.schedule = undefined;
			},
			loadSnapshot,
		);
		const entry = { token, unsubscribe: pending.unsubscribe };
		this.schedule = entry;
		try {
			const snapshot = await pending.snapshot;
			if (this.closed || this.schedule !== entry) {
				pending.unsubscribe();
				throw new AppServerError("BUSY");
			}
			return snapshot;
		} catch (error) {
			if (this.schedule === entry) this.schedule = undefined;
			pending.unsubscribe();
			throw error;
		}
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	unsubscribe(sessionId: string): boolean {
		const subscription = this.sessions.get(sessionId);
		if (!subscription) return false;
		this.sessions.delete(sessionId);
		subscription.unsubscribe();
		return true;
	}

	unsubscribeSchedule(): boolean {
		if (!this.schedule) return false;
		const subscription = this.schedule;
		this.schedule = undefined;
		subscription.unsubscribe();
		return true;
	}

	acknowledge(serverEpoch: string, cursor: number): number {
		return this.outbound.acknowledge(serverEpoch, cursor);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unregisterConnection();
		for (const sessionId of [...this.sessions.keys()]) this.unsubscribe(sessionId);
		this.unsubscribeSchedule();
	}
}
