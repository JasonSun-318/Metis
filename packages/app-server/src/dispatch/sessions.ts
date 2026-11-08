import { createHash } from "node:crypto";
import type { ClientRpcRequest } from "@metis/app-protocol";
import { type ScheduleManager, SessionManager } from "@metis/coding-agent/host";
import { openAgentDeliveredFile, readAgentDeliveredFile, readAgentImage } from "../agent-assets.ts";
import type { ArchivedConversationCatalog } from "../archived-conversations.ts";
import type { DurableSessionMutation, PreparedSessionMutation } from "../durable-mutation.ts";
import type { InteractionBroker, InteractionPeer } from "../interactions.ts";
import type { KnowledgeService } from "../knowledge.ts";
import type { SessionCatalog } from "../session-catalog.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { AppServerError, type SessionRef } from "../session-runtime-host.ts";
import type { ConnectionSubscriptions, SessionSubscriptions } from "../subscriptions.ts";

export interface SessionsDispatchContext {
	readonly catalog: SessionCatalog;
	readonly registry: SessionRegistry;
	readonly subscriptionHub: SessionSubscriptions;
	readonly interactions: InteractionBroker;
	readonly knowledge: KnowledgeService;
	readonly archivedConversations: ArchivedConversationCatalog;
	readonly scheduleManager: ScheduleManager;
	readonly connectionSubscriptions: ConnectionSubscriptions;
	readonly interactionPeer: InteractionPeer;
	allSessionRefs(): readonly SessionRef[];
	runtimeRef(sessionId: string): SessionRef;
	hydrateScheduledSession(sessionId: string): Promise<SessionRef>;
	assertMutableSession(sessionId: string): void;
	allowRetainedScheduledDelete(sessionId: string): Promise<boolean>;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isSessionsRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("session/");
}

export async function dispatchSessionsRequest(
	request: ClientRpcRequest,
	context: SessionsDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "session/list": {
			const page = context.catalog.list(request.params);
			return {
				...page,
				sessions: await Promise.all(
					page.sessions.map(async (session) => {
						try {
							return (await context.hydrateScheduledSession(session.sessionId)).summary;
						} catch {
							return session;
						}
					}),
				),
			};
		}
		case "session/archived/list":
			return await context.archivedConversations.list(context.allSessionRefs(), request.params);
		case "session/knowledge/get": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.getKnowledgeLinks?.() ?? { libraries: [] });
		}
		case "session/knowledge/set":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => {
					if (!runtime.setKnowledgeLinks)
						throw new AppServerError("READ_ONLY_SESSION", { sessionId: request.params.sessionId });
					const libraries = context.knowledge.libraries(request.params.libraryIds);
					return runtime.setKnowledgeLinks(libraries);
				});
			});
		case "session/create":
			return await context.replayMutation(request, async () => ({
				session: await context.catalog.create(request.params),
			}));
		case "session/open": {
			await context.hydrateScheduledSession(request.params.sessionId);
			const ref = context.runtimeRef(request.params.sessionId);
			context.interactions.assign(request.params.sessionId, context.interactionPeer);
			try {
				const runtime = await context.registry.open(ref);
				const session = context.catalog.updateSummary(request.params.sessionId, runtime.getSummary());
				return { session };
			} catch (error) {
				context.interactions.release(request.params.sessionId, context.interactionPeer);
				if (error instanceof AppServerError && error.code === "SESSION_CORRUPT") {
					context.catalog.markCorrupt(request.params.sessionId);
				}
				throw error;
			}
		}
		case "session/markRead": {
			const ref = await context.hydrateScheduledSession(request.params.sessionId);
			if (ref.scheduled) {
				const run = await context.scheduleManager.markRunRead(ref.scheduled.taskId, ref.scheduled.runId);
				const registered = await context.catalog.registerScheduledRun(run);
				const session = registered?.session ?? context.catalog.get(request.params.sessionId).summary;
				if (registered?.changed) context.subscriptionHub.publishSessionUpdated(session);
				return { session };
			}
			const result = context.registry.has(request.params.sessionId)
				? {
						session: await context.registry.run(ref, (runtime) => runtime.markRead()),
						changed: ref.summary.unread,
					}
				: await context.catalog.markClosedSessionRead(request.params.sessionId);
			const session = context.catalog.updateSummary(request.params.sessionId, result.session);
			if (result.changed && !context.registry.has(request.params.sessionId)) {
				context.subscriptionHub.publishSessionUpdated(session);
			}
			return { session };
		}
		case "session/readProcess": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.readProcess(request.params));
		}
		case "session/readItems": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.readItems(request.params));
		}
		case "session/readImage": {
			if (request.params.rootSessionId && request.params.rootSessionId !== request.params.sessionId) {
				return await readAgentImage(
					context.runtimeRef(request.params.rootSessionId),
					context.catalog.agentDir,
					request.params,
				);
			}
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.readImage(request.params));
		}
		case "session/openDeliveredFile": {
			if (request.params.rootSessionId && request.params.rootSessionId !== request.params.sessionId) {
				const rootRef = context.runtimeRef(request.params.rootSessionId);
				const live = await context.registry.withOpenRuntime(request.params.rootSessionId, async (runtime) =>
					runtime.resolveAgentDeliveredFile?.(request.params.sessionId, request.params.fileId),
				);
				return await openAgentDeliveredFile(rootRef, context.catalog.agentDir, request.params, undefined, () =>
					live.open ? live.result : undefined,
				);
			}
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.openDeliveredFile(request.params));
		}
		case "session/readDeliveredFile": {
			if (request.params.rootSessionId && request.params.rootSessionId !== request.params.sessionId) {
				const rootRef = context.runtimeRef(request.params.rootSessionId);
				const live = await context.registry.withOpenRuntime(request.params.rootSessionId, async (runtime) =>
					runtime.resolveAgentDeliveredFile?.(request.params.sessionId, request.params.fileId),
				);
				return await readAgentDeliveredFile(rootRef, context.catalog.agentDir, request.params, () =>
					live.open ? live.result : undefined,
				);
			}
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.readDeliveredFile(request.params));
		}
		case "session/status": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.getStatus(request.params));
		}
		case "session/compact":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.compact(request.params));
			});
		case "session/goal/get": {
			const ref = context.runtimeRef(request.params.sessionId);
			return await context.registry.run(ref, (runtime) => runtime.getGoal(request.params));
		}
		case "session/goal/set":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setGoal(request.params));
			});
		case "session/goal/clear":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.clearGoal(request.params));
			});
		case "session/setThinkingSelection":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setThinkingSelection(request.params));
			});
		case "session/setPermissionPreset":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setPermissionPreset(request.params));
			});
		case "session/setCollaborationMode":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setCollaborationMode(request.params));
			});
		case "session/setMemoryFlags":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setMemoryFlags(request.params));
			});
		case "session/setModel":
			return await context.replayMutation(request, async () => {
				const ref = context.runtimeRef(request.params.sessionId);
				return await context.registry.run(ref, (runtime) => runtime.setModel(request.params));
			});
		case "session/rename":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				return await context.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
					if (ref.summary.state === "unsupported") {
						throw new AppServerError("SESSION_VERSION_UNSUPPORTED", {
							sessionId: request.params.sessionId,
						});
					}
					if (ref.summary.state === "corrupt") {
						throw new AppServerError("SESSION_CORRUPT", {
							sessionId: request.params.sessionId,
						});
					}
					const session = context.registry.has(request.params.sessionId)
						? await context.registry.run(ref, (runtime) => runtime.renameSession(request.params.name))
						: await context.catalog.renameClosedSession(request.params.sessionId, request.params.name);
					return {
						session: context.catalog.updateSummary(request.params.sessionId, session),
					};
				});
			});
		case "session/fork":
			return await context.replayMutation(request, async () => {
				const targetSessionId = forkedSessionId(request.params.sessionId, request.params.requestId);
				await context.catalog.refresh();
				let persisted: SessionRef | undefined;
				try {
					persisted = context.catalog.get(targetSessionId);
				} catch (cause) {
					if (!(cause instanceof AppServerError) || cause.code !== "NOT_FOUND") throw cause;
				}
				if (persisted) {
					validatePersistedFork(persisted, request.params);
					return { session: persisted.summary, entryId: request.params.entryId };
				}
				context.assertMutableSession(request.params.sessionId);
				const ref = context.catalog.get(request.params.sessionId);
				if (ref.summary.state === "corrupt") {
					throw new AppServerError("SESSION_CORRUPT", {
						sessionId: request.params.sessionId,
					});
				}
				const originalName = ref.summary.name ?? `Metis session ${ref.summary.sessionId.slice(0, 8)}`;
				const createdSessionId = await context.registry.run(ref, (runtime) =>
					runtime.fork({
						entryId: request.params.entryId,
						name: `fork ${originalName}`,
						requestId: request.params.requestId,
						targetSessionId,
					}),
				);
				if (createdSessionId !== targetSessionId) throw new AppServerError("SESSION_CORRUPT");
				await context.catalog.refresh();
				const session = context.catalog.get(createdSessionId).summary;
				return { session, entryId: request.params.entryId };
			});
		case "session/delete": {
			let quiesced = false;
			let result: unknown;
			try {
				result = await context.replayMutation(request, async () => {
					const allowRetainedScheduled = await context.allowRetainedScheduledDelete(request.params.sessionId);
					return await context.catalog.withSessionProjectMutable(request.params.sessionId, async (ref) => {
						if (ref.summary.state === "unsupported") {
							throw new AppServerError("SESSION_VERSION_UNSUPPORTED", {
								sessionId: request.params.sessionId,
							});
						}
						if (ref.summary.state === "corrupt") {
							throw new AppServerError("SESSION_CORRUPT", {
								sessionId: request.params.sessionId,
							});
						}
						return await context.registry.withSessionsQuiesced(
							[request.params.sessionId],
							async () => {
								quiesced = true;
								const deleted = await SessionManager.deleteSession(ref.path, {
									agentDir: context.catalog.agentDir,
									allowRetainedScheduled,
									sessionsRoot: context.catalog.sessionsRoot,
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
								await context.catalog.removeDeletedSession(request.params.sessionId, ref.path);
								context.subscriptionHub.removeSession(request.params.sessionId, {
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
								context.interactions.releaseSession(request.params.sessionId);
							},
						);
					});
				});
			} catch (error) {
				if (quiesced) {
					context.subscriptionHub.removeSession(request.params.sessionId, {
						type: "session/invalidated",
						sessionId: request.params.sessionId,
						reason: "reload_required",
					});
				}
				throw error;
			}
			context.connectionSubscriptions.unsubscribe(request.params.sessionId);
			context.interactions.release(request.params.sessionId, context.interactionPeer);
			return result;
		}
		case "session/close": {
			const ref = context.catalog.get(request.params.sessionId);
			if (ref.scheduled) {
				const result = await context.replayMutation(request, async () => {
					await context.registry.close(request.params.sessionId);
					context.subscriptionHub.removeSession(request.params.sessionId);
					return { sessionId: request.params.sessionId, closed: true };
				});
				context.connectionSubscriptions.unsubscribe(request.params.sessionId);
				context.interactions.release(request.params.sessionId, context.interactionPeer);
				return result;
			}
			const result = await context.replayMutation(request, () =>
				context.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
					const mutation: DurableSessionMutation = {
						method: "session/close",
						kind: "session_close",
						requestId: request.params.requestId,
						params: { sessionId: request.params.sessionId },
					};
					let prepared: PreparedSessionMutation | undefined;
					let closedRuntime = false;
					if (context.registry.has(request.params.sessionId)) {
						await context.registry.close(request.params.sessionId, async (runtime) => {
							prepared = await runtime.prepareMutation(mutation);
							closedRuntime = prepared.state !== "completed";
							return closedRuntime;
						});
					} else {
						prepared = context.catalog.prepareDurableMutation(request.params.sessionId, mutation);
					}
					if (closedRuntime) context.subscriptionHub.removeSession(request.params.sessionId);
					if (prepared?.state === "completed") return prepared.result;
					const response = {
						sessionId: request.params.sessionId,
						closed: true,
					};
					return context.catalog.completeDurableMutation(request.params.sessionId, mutation, response);
				}),
			);
			context.connectionSubscriptions.unsubscribe(request.params.sessionId);
			context.interactions.release(request.params.sessionId, context.interactionPeer);
			return result;
		}
		case "session/archive":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				return await context.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
					context.registry.assertClosed(request.params.sessionId);
					return {
						session: await context.catalog.archive(request.params.sessionId, request.params.requestId),
					};
				});
			});
		case "session/unarchive":
			return await context.replayMutation(request, async () => {
				context.assertMutableSession(request.params.sessionId);
				return await context.catalog.withSessionProjectMutable(request.params.sessionId, async () => {
					context.registry.assertClosed(request.params.sessionId);
					return {
						session: await context.catalog.unarchive(request.params.sessionId, request.params.requestId),
					};
				});
			});
		case "session/subscribe": {
			const ref = context.runtimeRef(request.params.sessionId);
			context.interactions.assign(request.params.sessionId, context.interactionPeer);
			try {
				const snapshot = await context.registry.run(ref, (runtime) =>
					context.connectionSubscriptions.subscribe(runtime),
				);
				context.catalog.updateSummary(request.params.sessionId, snapshot.session);
				return { snapshot };
			} catch (error) {
				context.interactions.release(request.params.sessionId, context.interactionPeer);
				throw error;
			}
		}
		case "session/unsubscribe":
			context.connectionSubscriptions.unsubscribe(request.params.sessionId);
			context.interactions.release(request.params.sessionId, context.interactionPeer);
			return { sessionId: request.params.sessionId, unsubscribed: true };
		default:
			throw new Error(`Unhandled session request: ${request.method}`);
	}
}

function forkedSessionId(sourceSessionId: string, requestId: string): string {
	const digest = createHash("sha256").update(sourceSessionId).update("\0").update(requestId).digest("hex");
	return `fork-${digest}`;
}

function validatePersistedFork(
	ref: SessionRef,
	input: { readonly requestId: string; readonly sessionId: string; readonly entryId: string },
): void {
	const manager = SessionManager.openReadOnly(ref.path);
	const markers = manager.getDurableJournalSnapshot().filter((raw) => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
		const entry = raw as unknown as Record<string, unknown>;
		if (entry.type !== "custom" || entry.customType !== "metis.app-server.session-fork.v1") return false;
		const data = entry.data as Record<string, unknown> | undefined;
		return (
			data?.requestId === input.requestId &&
			data.sourceSessionId === input.sessionId &&
			data.entryId === input.entryId
		);
	});
	if (markers.length !== 1) throw new AppServerError("REQUEST_ID_REUSED", { requestId: input.requestId });
}
