import type { ClientRpcRequest } from "@metis/app-protocol";
import { type ScheduleManager, SessionManager } from "@metis/coding-agent/host";
import type { InteractionBroker } from "../interactions.ts";
import type { SessionCatalog } from "../session-catalog.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { AppServerError } from "../session-runtime-host.ts";
import type { SessionSubscriptions } from "../subscriptions.ts";

export interface ProjectDispatchContext {
	readonly catalog: SessionCatalog;
	readonly registry: SessionRegistry;
	readonly subscriptionHub: SessionSubscriptions;
	readonly interactions: InteractionBroker;
	readonly scheduleManager: ScheduleManager;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export function isProjectRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("project/");
}

async function deleteModeProject(
	request: Extract<ClientRpcRequest, { method: "project/delete" }>,
	context: ProjectDispatchContext,
): Promise<unknown> {
	let invalidation: { mode: "chat" | "code"; cwd: string; reason: "deleted" | "reload_required" } | undefined;
	const publishInvalidation = () => {
		const event = invalidation;
		invalidation = undefined;
		if (event) context.subscriptionHub.invalidateProject({ type: "project/invalidated", ...event });
	};
	try {
		const result = await context.replayMutation(request, () =>
			context.catalog.withModeProjectBlocked(request.params, async (snapshot) => {
				const deleteSessions = async () => {
					let quiesced = false;
					try {
						return await context.registry.withSessionsQuiesced(
							snapshot.refs.map((ref) => ref.summary.sessionId),
							async () => {
								quiesced = true;
								const result = await SessionManager.trashModeProjectData({
									agentDir: context.catalog.agentDir,
									sessionsRoot: context.catalog.sessionsRoot,
									mode: snapshot.mode,
									cwd: snapshot.cwd,
									sessions: snapshot.refs.map((ref) => ({
										sessionId: ref.summary.sessionId,
										path: ref.path,
										relativePath: ref.relativePath,
										archived: ref.summary.archived,
										updatedAt: ref.storageUpdatedAt ?? ref.summary.updatedAt,
									})),
								});
								if (!result.ok) {
									if (result.code === "PROJECT_CHANGED") {
										throw new AppServerError("BUSY");
									}
									if (result.code === "SESSION_IN_USE") throw new AppServerError("SESSION_IN_USE");
									if (result.code === "SESSION_CORRUPT") throw new AppServerError("SESSION_CORRUPT");
									console.error(`project/delete failed for ${snapshot.cwd}: ${result.error}`);
									throw new AppServerError("OPERATION_FAILED");
								}
								for (const ref of snapshot.refs) {
									context.subscriptionHub.removeSession(ref.summary.sessionId);
								}
								invalidation = { mode: snapshot.mode, cwd: snapshot.cwd, reason: "deleted" };
								return {
									mode: snapshot.mode,
									cwd: snapshot.cwd,
									deletedSessionCount: result.deletedSessionCount,
								};
							},
							() => {
								for (const ref of snapshot.refs) {
									context.interactions.releaseSession(ref.summary.sessionId);
								}
							},
						);
					} catch (error) {
						if (quiesced) {
							for (const ref of snapshot.refs) {
								context.subscriptionHub.removeSession(ref.summary.sessionId);
							}
							invalidation = { mode: snapshot.mode, cwd: snapshot.cwd, reason: "reload_required" };
						}
						throw error;
					}
				};
				return snapshot.mode === "chat"
					? context.scheduleManager.withNoFixedWorkspaceTasks(snapshot.cwd, deleteSessions)
					: deleteSessions();
			}),
		);
		publishInvalidation();
		return result;
	} catch (error) {
		publishInvalidation();
		throw error;
	}
}

export async function dispatchProjectRequest(
	request: ClientRpcRequest,
	context: ProjectDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "project/deletePreview": {
			const cwd = await context.catalog.refreshModeProjectStorage(request.params.cwd);
			const snapshot = context.catalog.modeProjectSnapshot(request.params.mode, cwd);
			return {
				mode: snapshot.mode,
				cwd: snapshot.cwd,
				sessionCount: snapshot.refs.length,
				blockingScheduleCount:
					snapshot.mode === "chat" ? context.scheduleManager.countFixedWorkspaceTasks(snapshot.cwd) : 0,
				revision: snapshot.revision,
			};
		}
		case "project/delete":
			return await deleteModeProject(request, context);
		default:
			throw new Error(`Unhandled project request: ${request.method}`);
	}
}
