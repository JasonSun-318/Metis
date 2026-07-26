import { createHash } from "node:crypto";
import type { ClientRpcRequest } from "@arcmind/app-protocol";
import type { DurableSessionMutation, PreparedSessionMutation } from "./durable-mutation.ts";
import type { InteractionBroker, InteractionPeer } from "./interactions.ts";
import type { SessionCatalog } from "./session-catalog.ts";
import type { SessionRegistry } from "./session-registry.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";
import type { ConnectionSubscriptions, SessionSubscriptions } from "./subscriptions.ts";

const MAX_REPLAY_ENTRIES = 10_000;

export interface ConnectionState {
	readonly subscriptions: ConnectionSubscriptions;
	readonly interactionPeer: InteractionPeer;
}

interface ReplayEntry {
	readonly fingerprint: string;
	readonly result: Promise<unknown>;
	settled: boolean;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function fingerprint(request: ClientRpcRequest): string {
	return createHash("sha256").update(request.method).update("\0").update(canonicalJson(request.params)).digest("hex");
}

function requestId(request: ClientRpcRequest): string | undefined {
	return "requestId" in request.params ? request.params.requestId : undefined;
}

function replayKey(request: ClientRpcRequest, id: string): string {
	if (request.method === "session/create") return `create\0${id}`;
	const sessionId = "sessionId" in request.params ? request.params.sessionId : undefined;
	return sessionId === undefined ? `global\0${id}` : `session\0${sessionId}\0${id}`;
}

export class Dispatcher {
	private readonly replay = new Map<string, ReplayEntry>();
	private readonly catalog: SessionCatalog;
	private readonly registry: SessionRegistry;
	private readonly subscriptionHub: SessionSubscriptions;
	private readonly interactions: InteractionBroker;

	constructor(
		catalog: SessionCatalog,
		registry: SessionRegistry,
		subscriptionHub: SessionSubscriptions,
		interactions: InteractionBroker,
	) {
		this.catalog = catalog;
		this.registry = registry;
		this.subscriptionHub = subscriptionHub;
		this.interactions = interactions;
	}

	private runtimeRef(sessionId: string): SessionRef {
		const ref = this.catalog.get(sessionId);
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId });
		if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
		return ref;
	}

	private replayMutation(request: ClientRpcRequest, operation: () => Promise<unknown>): Promise<unknown> {
		const id = requestId(request);
		if (!id) return operation();
		const key = replayKey(request, id);
		const digest = fingerprint(request);
		const existing = this.replay.get(key);
		if (existing) {
			if (existing.fingerprint !== digest) throw new AppServerError("REQUEST_ID_REUSED", { requestId: id });
			return existing.result;
		}

		if (this.replay.size >= MAX_REPLAY_ENTRIES) {
			const evictable = [...this.replay].find(([, entry]) => entry.settled);
			if (!evictable) throw new AppServerError("OVERLOADED", { requestId: id });
			this.replay.delete(evictable[0]);
		}
		const entry: ReplayEntry = { fingerprint: digest, result: Promise.resolve().then(operation), settled: false };
		this.replay.set(key, entry);
		void entry.result.then(
			() => {
				entry.settled = true;
			},
			() => {
				entry.settled = true;
			},
		);
		return entry.result;
	}

	async dispatch(request: ClientRpcRequest, connection: ConnectionState): Promise<unknown> {
		switch (request.method) {
			case "initialize":
				throw new AppServerError("INVALID_REQUEST");
			case "session/list":
				return this.catalog.list(request.params);
			case "skill/list":
				if ("sessionId" in request.params) {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.listSkills());
				}
				return await this.registry.listDraftSkills(request.params.cwd);
			case "session/create":
				return await this.replayMutation(request, async () => ({
					session: await this.catalog.create(request.params),
				}));
			case "session/open": {
				const ref = this.runtimeRef(request.params.sessionId);
				this.interactions.assign(request.params.sessionId, connection.interactionPeer);
				try {
					const runtime = await this.registry.open(ref);
					const session = this.catalog.updateSummary(request.params.sessionId, runtime.getSummary());
					return { session };
				} catch (error) {
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					if (error instanceof AppServerError && error.code === "SESSION_CORRUPT") {
						this.catalog.markCorrupt(request.params.sessionId);
					}
					throw error;
				}
			}
			case "session/readItems": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readItems(request.params));
			}
			case "subagent/readItems": {
				const ref = this.runtimeRef(request.params.sessionId);
				return await this.registry.run(ref, (runtime) => runtime.readSubagentItems(request.params));
			}
			case "session/setThinkingSelection":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setThinkingSelection(request.params));
				});
			case "session/close": {
				this.catalog.get(request.params.sessionId);
				const result = await this.replayMutation(request, async () => {
					const mutation: DurableSessionMutation = {
						method: "session/close",
						kind: "session_close",
						requestId: request.params.requestId,
						params: { sessionId: request.params.sessionId },
					};
					let prepared: PreparedSessionMutation | undefined;
					let closedRuntime = false;
					if (this.registry.has(request.params.sessionId)) {
						await this.registry.close(request.params.sessionId, async (runtime) => {
							prepared = await runtime.prepareMutation(mutation);
							closedRuntime = prepared.state !== "completed";
							return closedRuntime;
						});
					} else {
						prepared = this.catalog.prepareDurableMutation(request.params.sessionId, mutation);
					}
					if (closedRuntime) this.subscriptionHub.removeSession(request.params.sessionId);
					if (prepared?.state === "completed") return prepared.result;
					const response = { sessionId: request.params.sessionId, closed: true };
					return this.catalog.completeDurableMutation(request.params.sessionId, mutation, response);
				});
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return result;
			}
			case "session/archive":
				return await this.replayMutation(request, async () => {
					this.registry.assertClosed(request.params.sessionId);
					return { session: await this.catalog.archive(request.params.sessionId, request.params.requestId) };
				});
			case "session/unarchive":
				return await this.replayMutation(request, async () => {
					this.registry.assertClosed(request.params.sessionId);
					return { session: await this.catalog.unarchive(request.params.sessionId, request.params.requestId) };
				});
			case "session/subscribe": {
				const ref = this.runtimeRef(request.params.sessionId);
				this.interactions.assign(request.params.sessionId, connection.interactionPeer);
				try {
					const snapshot = await this.registry.run(ref, (runtime) => connection.subscriptions.subscribe(runtime));
					this.catalog.updateSummary(request.params.sessionId, snapshot.session);
					return { snapshot };
				} catch (error) {
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					throw error;
				}
			}
			case "session/unsubscribe":
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return { sessionId: request.params.sessionId, unsubscribed: true };
			case "turn/start":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.startTurn(request.params));
				});
			case "turn/steer":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.steer(request.params));
				});
			case "turn/interrupt":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.interrupt(request.params));
				});
			case "connection/ack":
				return {
					acknowledgedCursor: connection.subscriptions.acknowledge(
						request.params.serverEpoch,
						request.params.cursor,
					),
				};
		}
	}
}
