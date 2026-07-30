import { createHash } from "node:crypto";
import type { ClientRpcRequest } from "@arcmind/app-protocol";
import {
	resolveScheduleCreateTarget,
	type ScheduleCreateTarget,
	type ScheduleManager,
	SessionManager,
} from "@arcmind/coding-agent";
import type { DurableSessionMutation, PreparedSessionMutation } from "./durable-mutation.ts";
import type { InteractionBroker, InteractionPeer } from "./interactions.ts";
import { scheduleRunView, scheduleTaskView } from "./schedule-projection.ts";
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
	private readonly scheduleManager: ScheduleManager;

	constructor(
		catalog: SessionCatalog,
		registry: SessionRegistry,
		subscriptionHub: SessionSubscriptions,
		interactions: InteractionBroker,
		scheduleManager: ScheduleManager,
	) {
		this.catalog = catalog;
		this.registry = registry;
		this.subscriptionHub = subscriptionHub;
		this.interactions = interactions;
		this.scheduleManager = scheduleManager;
	}

	private scheduleTarget(sourceSessionId?: string): { target: ScheduleCreateTarget } {
		if (!sourceSessionId) return { target: { kind: "general", workspace: "task" } };
		const ref = this.catalog.get(sourceSessionId);
		if (ref.scheduled || ref.summary.archived || ref.summary.state === "corrupt" || !ref.summary.cwd) {
			throw new AppServerError("NOT_FOUND", { sessionId: sourceSessionId });
		}
		const target = resolveScheduleCreateTarget({
			mode: ref.summary.mode,
			cwdOrigin: ref.summary.cwdOrigin,
			cwd: ref.summary.cwd,
		});
		if (!target) throw new AppServerError("INVALID_REQUEST", { sessionId: sourceSessionId });
		return { target };
	}

	private async scheduleSnapshot(cursor: number) {
		const page = await this.scheduleManager.list({ limit: 200 });
		return {
			tasks: page.tasks.map(scheduleTaskView),
			unreadCount: this.scheduleManager.unreadCount(),
			cursor,
		};
	}

	private async closeScheduledTaskSessions(taskId: string): Promise<void> {
		for (const sessionId of this.catalog.scheduledSessionIds(taskId)) {
			this.subscriptionHub.removeSession(sessionId);
			if (this.registry.has(sessionId)) await this.registry.close(sessionId);
		}
	}

	private runtimeRef(sessionId: string): SessionRef {
		const ref = this.catalog.get(sessionId);
		if (ref.summary.archived) throw new AppServerError("NOT_FOUND", { sessionId });
		if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
		return ref;
	}

	private assertMutableSession(sessionId: string): void {
		if (this.catalog.get(sessionId).scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
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

	private async deleteModeProject(request: Extract<ClientRpcRequest, { method: "project/delete" }>): Promise<unknown> {
		return await this.replayMutation(request, () =>
			this.catalog.withModeProjectBlocked(request.params, async (snapshot) => {
				const deleteSessions = () =>
					this.registry.withSessionsQuiesced(
						snapshot.refs.map((ref) => ref.summary.sessionId),
						async () => {
							const result = await SessionManager.trashModeProjectData({
								agentDir: this.catalog.agentDir,
								sessionsRoot: this.catalog.sessionsRoot,
								mode: snapshot.mode,
								cwd: snapshot.cwd,
								sessions: snapshot.refs.map((ref) => ({
									sessionId: ref.summary.sessionId,
									path: ref.path,
									relativePath: ref.relativePath,
									archived: ref.summary.archived,
									updatedAt: ref.summary.updatedAt,
								})),
							});
							if (!result.ok) {
								if (result.code === "PROJECT_CHANGED") {
									throw new AppServerError("BUSY");
								}
								if (result.code === "SESSION_IN_USE") throw new AppServerError("SESSION_IN_USE");
								if (result.code === "SESSION_CORRUPT") throw new AppServerError("SESSION_CORRUPT");
								throw new AppServerError("OPERATION_FAILED");
							}
							return {
								mode: snapshot.mode,
								cwd: snapshot.cwd,
								deletedSessionCount: result.deletedSessionCount,
							};
						},
						() => {
							for (const ref of snapshot.refs) {
								const sessionId = ref.summary.sessionId;
								this.subscriptionHub.removeSession(sessionId);
								this.interactions.releaseSession(sessionId);
							}
						},
					);
				return snapshot.mode === "chat"
					? this.scheduleManager.withNoFixedWorkspaceTasks(snapshot.cwd, deleteSessions)
					: deleteSessions();
			}),
		);
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
			case "project/deletePreview": {
				const cwd = await this.catalog.refreshModeProjectStorage(request.params.cwd);
				const snapshot = this.catalog.modeProjectSnapshot(request.params.mode, cwd);
				return {
					mode: snapshot.mode,
					cwd: snapshot.cwd,
					sessionCount: snapshot.refs.length,
					blockingScheduleCount:
						snapshot.mode === "chat" ? this.scheduleManager.countFixedWorkspaceTasks(snapshot.cwd) : 0,
					revision: snapshot.revision,
				};
			}
			case "project/delete":
				return await this.deleteModeProject(request);
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
			case "session/setPermissionMode":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setPermissionMode(request.params));
				});
			case "session/setModel":
				return await this.replayMutation(request, async () => {
					const ref = this.runtimeRef(request.params.sessionId);
					return await this.registry.run(ref, (runtime) => runtime.setModel(request.params));
				});
			case "session/rename":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
						if (ref.summary.state === "corrupt") {
							throw new AppServerError("SESSION_CORRUPT", {
								sessionId: request.params.sessionId,
							});
						}
						const session = this.registry.has(request.params.sessionId)
							? await this.registry.run(ref, (runtime) => runtime.renameSession(request.params.name))
							: await this.catalog.renameClosedSession(request.params.sessionId, request.params.name);
						return {
							session: this.catalog.updateSummary(request.params.sessionId, session),
						};
					});
				});
			case "session/delete": {
				let quiesced = false;
				let result: unknown;
				try {
					result = await this.replayMutation(request, async () => {
						this.assertMutableSession(request.params.sessionId);
						return await this.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
							if (ref.summary.state === "corrupt") {
								throw new AppServerError("SESSION_CORRUPT", {
									sessionId: request.params.sessionId,
								});
							}
							return await this.registry.withSessionsQuiesced(
								[request.params.sessionId],
								async () => {
									quiesced = true;
									const deleted = await SessionManager.deleteSession(ref.path, {
										agentDir: this.catalog.agentDir,
										sessionsRoot: this.catalog.sessionsRoot,
									});
									if (!deleted.ok) {
										throw new AppServerError(
											deleted.code === "SESSION_IN_USE" ? "SESSION_IN_USE" : "OPERATION_FAILED",
											{
												sessionId: request.params.sessionId,
												requestId: request.params.requestId,
											},
										);
									}
									await this.catalog.removeDeletedSession(request.params.sessionId, ref.path);
									this.subscriptionHub.removeSession(request.params.sessionId, {
										type: "session/invalidated",
										sessionId: request.params.sessionId,
										reason: "deleted",
									});
									return {
										sessionId: request.params.sessionId,
										deleted: true as const,
										method: deleted.method,
										...(deleted.warning
											? {
													warning: "Some session-owned files could not be removed.",
												}
											: {}),
									};
								},
								() => {
									this.interactions.releaseSession(request.params.sessionId);
								},
							);
						});
					});
				} catch (error) {
					if (quiesced) {
						this.subscriptionHub.removeSession(request.params.sessionId, {
							type: "session/invalidated",
							sessionId: request.params.sessionId,
							reason: "reload_required",
						});
					}
					throw error;
				}
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return result;
			}
			case "session/close": {
				const ref = this.catalog.get(request.params.sessionId);
				if (ref.scheduled) {
					const result = await this.replayMutation(request, async () => {
						await this.registry.close(request.params.sessionId);
						this.subscriptionHub.removeSession(request.params.sessionId);
						return { sessionId: request.params.sessionId, closed: true };
					});
					connection.subscriptions.unsubscribe(request.params.sessionId);
					this.interactions.release(request.params.sessionId, connection.interactionPeer);
					return result;
				}
				const result = await this.replayMutation(request, () =>
					this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
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
						const response = {
							sessionId: request.params.sessionId,
							closed: true,
						};
						return this.catalog.completeDurableMutation(request.params.sessionId, mutation, response);
					}),
				);
				connection.subscriptions.unsubscribe(request.params.sessionId);
				this.interactions.release(request.params.sessionId, connection.interactionPeer);
				return result;
			}
			case "session/archive":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
						this.registry.assertClosed(request.params.sessionId);
						return {
							session: await this.catalog.archive(request.params.sessionId, request.params.requestId),
						};
					});
				});
			case "session/unarchive":
				return await this.replayMutation(request, async () => {
					this.assertMutableSession(request.params.sessionId);
					return await this.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
						this.registry.assertClosed(request.params.sessionId);
						return {
							session: await this.catalog.unarchive(request.params.sessionId, request.params.requestId),
						};
					});
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
			case "schedule/create":
				return await this.replayMutation(request, async () => {
					const source = this.scheduleTarget(request.params.sourceSessionId);
					return {
						task: scheduleTaskView(
							await this.scheduleManager.create({
								id: request.params.requestId,
								instruction: request.params.instruction,
								schedule: request.params.schedule,
								timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
								...source,
							}),
						),
					};
				});
			case "schedule/list": {
				const page = await this.scheduleManager.list({
					...(request.params.afterTaskId ? { afterTaskId: request.params.afterTaskId } : {}),
					...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
					...(request.params.unreadOnly === undefined ? {} : { unreadOnly: request.params.unreadOnly }),
				});
				return {
					tasks: page.tasks.map(scheduleTaskView),
					nextAfterTaskId: page.nextAfterTaskId,
					unreadCount: this.scheduleManager.unreadCount(),
				};
			}
			case "schedule/get":
				return { task: scheduleTaskView(await this.scheduleManager.get(request.params.taskId)) };
			case "schedule/update":
				return await this.replayMutation(request, async () => ({
					task: scheduleTaskView(
						await this.scheduleManager.update(request.params.taskId, {
							...(request.params.instruction === undefined ? {} : { instruction: request.params.instruction }),
							...(request.params.schedule === undefined ? {} : { schedule: request.params.schedule }),
						}),
					),
				}));
			case "schedule/pause":
				return await this.replayMutation(request, async () => ({
					task: scheduleTaskView(await this.scheduleManager.pause(request.params.taskId)),
				}));
			case "schedule/resume":
				return await this.replayMutation(request, async () => ({
					task: scheduleTaskView(await this.scheduleManager.resume(request.params.taskId)),
				}));
			case "schedule/delete":
				return await this.replayMutation(request, async () => {
					await this.closeScheduledTaskSessions(request.params.taskId);
					const result = await this.scheduleManager.delete(request.params.taskId);
					for (const sessionId of await this.catalog.removeScheduledTask(request.params.taskId)) {
						this.subscriptionHub.removeSession(sessionId);
						await this.registry.close(sessionId);
					}
					return result;
				});
			case "schedule/run-now":
				return await this.replayMutation(request, async () => ({
					run: scheduleRunView(await this.scheduleManager.runNow(request.params.taskId, request.params.requestId)),
				}));
			case "schedule/run/list": {
				const page = await this.scheduleManager.listRuns(request.params.taskId, {
					...(request.params.beforeRunId ? { beforeRunId: request.params.beforeRunId } : {}),
					...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
				});
				return { runs: page.runs.map(scheduleRunView), nextBeforeRunId: page.nextBeforeRunId };
			}
			case "schedule/run/get": {
				const run = await this.scheduleManager.getRun(request.params.taskId, request.params.runId);
				await this.catalog.registerScheduledRun(run);
				return { run: scheduleRunView(run) };
			}
			case "schedule/run/mark-read":
				return await this.replayMutation(request, async () => {
					const run = await this.scheduleManager.markRunRead(request.params.taskId, request.params.runId);
					const task = await this.scheduleManager.get(request.params.taskId);
					return { run: scheduleRunView(run), unreadCount: task.unreadCount };
				});
			case "schedule/subscribe":
				return {
					snapshot: await connection.subscriptions.subscribeSchedule((cursor) => this.scheduleSnapshot(cursor)),
				};
			case "schedule/unsubscribe":
				connection.subscriptions.unsubscribeSchedule();
				return { unsubscribed: true };
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
