import type { ClientRpcRequest } from "@metis/app-protocol";
import {
	type ModelRegistry,
	resolveScheduleCreateTarget,
	type ScheduleCreateTarget,
	ScheduleError,
	type ScheduleManager,
} from "@metis/coding-agent/host";
import { scheduleRunView, scheduleTaskView } from "../schedule-projection.ts";
import type { SessionCatalog } from "../session-catalog.ts";
import type { SessionRegistry } from "../session-registry.ts";
import { AppServerError } from "../session-runtime-host.ts";
import type { ConnectionSubscriptions, SessionSubscriptions } from "../subscriptions.ts";

export interface ScheduleCoreContext {
	readonly scheduleManager: ScheduleManager;
	readonly modelRegistry: ModelRegistry;
	readonly catalog: SessionCatalog;
	readonly registry: SessionRegistry;
	readonly subscriptionHub: SessionSubscriptions;
	replayMutation(request: ClientRpcRequest, run: () => Promise<unknown>): Promise<unknown>;
}

export interface ScheduleDispatchContext extends ScheduleCoreContext {
	readonly subscriptions: ConnectionSubscriptions;
}

export function isScheduleRequest(request: ClientRpcRequest): boolean {
	return request.method.startsWith("schedule/");
}

function availableModel(context: ScheduleCoreContext, model: { provider: string; modelId: string }): void {
	context.modelRegistry.refresh();
	const found = context.modelRegistry.find(model.provider, model.modelId);
	if (!found || !context.modelRegistry.hasConfiguredAuth(found)) {
		throw new ScheduleError(
			"MODEL_UNAVAILABLE",
			`Configured model is unavailable: ${model.provider}/${model.modelId}`,
		);
	}
}

function scheduleTarget(
	context: ScheduleCoreContext,
	sourceSessionId?: string,
	additionalWorkspaceCwd?: string,
): { target: ScheduleCreateTarget } {
	if (!sourceSessionId) {
		return {
			target: {
				kind: "general",
				workspace: "task",
				...(additionalWorkspaceCwd === undefined ? {} : { additionalWorkspaceCwd }),
			},
		};
	}
	if (additionalWorkspaceCwd !== undefined) throw new AppServerError("INVALID_REQUEST");
	const ref = context.catalog.get(sourceSessionId);
	if (
		ref.scheduled ||
		ref.summary.archived ||
		ref.summary.state === "corrupt" ||
		ref.summary.state === "unsupported" ||
		!ref.summary.cwd
	) {
		throw new AppServerError("NOT_FOUND", { sessionId: sourceSessionId });
	}
	const target = resolveScheduleCreateTarget({
		cwdOrigin: ref.summary.cwdOrigin,
		cwd: ref.summary.cwd,
	});
	return { target };
}

async function scheduleSnapshot(context: ScheduleCoreContext, cursor: number) {
	const page = await context.scheduleManager.list({ limit: 200 });
	return {
		serverEpoch: context.subscriptionHub.serverEpoch,
		tasks: page.tasks.map(scheduleTaskView),
		unreadCount: context.scheduleManager.unreadCount(),
		cursor,
	};
}

async function closeScheduledTaskSessions(context: ScheduleCoreContext, taskId: string): Promise<void> {
	for (const sessionId of context.catalog.scheduledSessionIds(taskId)) {
		context.subscriptionHub.removeSession(sessionId);
		if (context.registry.has(sessionId)) await context.registry.close(sessionId);
	}
}

export async function reconcileScheduledTaskSessions(context: ScheduleCoreContext, taskId: string): Promise<void> {
	const previous = context.catalog.scheduledSessionIds(taskId);
	await context.catalog.refresh();
	const retained = new Set(context.catalog.scheduledSessionIds(taskId));
	for (const sessionId of previous) {
		if (retained.has(sessionId)) continue;
		context.subscriptionHub.removeSession(sessionId, {
			type: "session/invalidated",
			sessionId,
			reason: "deleted",
		});
		await context.registry.close(sessionId);
	}
}

export async function dispatchScheduleRequest(
	request: ClientRpcRequest,
	context: ScheduleDispatchContext,
): Promise<unknown> {
	switch (request.method) {
		case "schedule/create":
			return await context.replayMutation(request, async () => {
				availableModel(context, request.params.model);
				const source = scheduleTarget(
					context,
					request.params.sourceSessionId,
					request.params.additionalWorkspaceCwd,
				);
				return {
					task: scheduleTaskView(
						await context.scheduleManager.create({
							id: request.params.requestId,
							name: request.params.name,
							...(request.params.description === undefined ? {} : { description: request.params.description }),
							instruction: request.params.instruction,
							model: request.params.model,
							schedule: request.params.schedule,
							timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
							...source,
						}),
					),
				};
			});
		case "schedule/list": {
			const page = await context.scheduleManager.list({
				...(request.params.afterTaskId ? { afterTaskId: request.params.afterTaskId } : {}),
				...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
				...(request.params.unreadOnly === undefined ? {} : { unreadOnly: request.params.unreadOnly }),
				...(request.params.query === undefined ? {} : { query: request.params.query }),
				...(request.params.sort === undefined ? {} : { sort: request.params.sort }),
			});
			return {
				tasks: page.tasks.map(scheduleTaskView),
				nextAfterTaskId: page.nextAfterTaskId,
				unreadCount: context.scheduleManager.unreadCount(),
			};
		}
		case "schedule/get":
			return {
				task: scheduleTaskView(await context.scheduleManager.get(request.params.taskId)),
			};
		case "schedule/update":
			return await context.replayMutation(request, async () => {
				if (request.params.model) availableModel(context, request.params.model);
				let target: ScheduleCreateTarget | undefined;
				if (request.params.sourceSessionId !== undefined) {
					target =
						request.params.sourceSessionId === null
							? scheduleTarget(context, undefined, request.params.additionalWorkspaceCwd ?? undefined).target
							: scheduleTarget(context, request.params.sourceSessionId).target;
				} else if (request.params.additionalWorkspaceCwd !== undefined) {
					const current = await context.scheduleManager.get(request.params.taskId);
					if (current.target.workspace !== "task") throw new AppServerError("INVALID_REQUEST");
					target = scheduleTarget(context, undefined, request.params.additionalWorkspaceCwd ?? undefined).target;
				}
				return {
					task: scheduleTaskView(
						await context.scheduleManager.update(request.params.taskId, {
							...(request.params.name === undefined ? {} : { name: request.params.name }),
							...(request.params.description === undefined ? {} : { description: request.params.description }),
							...(request.params.instruction === undefined ? {} : { instruction: request.params.instruction }),
							...(request.params.model === undefined ? {} : { model: request.params.model }),
							...(request.params.schedule === undefined ? {} : { schedule: request.params.schedule }),
							...(target === undefined ? {} : { target }),
						}),
					),
				};
			});
		case "schedule/pause":
			return await context.replayMutation(request, async () => ({
				task: scheduleTaskView(await context.scheduleManager.pause(request.params.taskId)),
			}));
		case "schedule/resume":
			return await context.replayMutation(request, async () => ({
				task: scheduleTaskView(await context.scheduleManager.resume(request.params.taskId)),
			}));
		case "schedule/delete":
			return await context.replayMutation(request, async () => {
				if (request.params.deleteSessions) await closeScheduledTaskSessions(context, request.params.taskId);
				const result = await context.scheduleManager.delete(request.params.taskId, {
					deleteSessions: request.params.deleteSessions,
				});
				await reconcileScheduledTaskSessions(context, request.params.taskId);
				return result;
			});
		case "schedule/run-now":
			return await context.replayMutation(request, async () => ({
				run: scheduleRunView(await context.scheduleManager.runNow(request.params.taskId, request.params.requestId)),
			}));
		case "schedule/run/list": {
			const page = await context.scheduleManager.listRuns(request.params.taskId, {
				...(request.params.beforeRunId ? { beforeRunId: request.params.beforeRunId } : {}),
				...(request.params.limit === undefined ? {} : { limit: request.params.limit }),
			});
			return {
				runs: page.runs.map(scheduleRunView),
				nextBeforeRunId: page.nextBeforeRunId,
			};
		}
		case "schedule/run/get": {
			const run = await context.scheduleManager.getRun(request.params.taskId, request.params.runId);
			const registered = await context.catalog.registerScheduledRun(run);
			if (registered?.changed) context.subscriptionHub.publishSessionUpdated(registered.session);
			return { run: scheduleRunView(run) };
		}
		case "schedule/run/mark-read":
			return await context.replayMutation(request, async () => {
				const run = await context.scheduleManager.markRunRead(request.params.taskId, request.params.runId);
				const registered = await context.catalog.registerScheduledRun(run);
				if (registered?.changed) context.subscriptionHub.publishSessionUpdated(registered.session);
				const task = await context.scheduleManager.get(request.params.taskId);
				return { run: scheduleRunView(run), unreadCount: task.unreadCount };
			});
		case "schedule/subscribe":
			return {
				snapshot: await context.subscriptions.subscribeSchedule((cursor) => scheduleSnapshot(context, cursor)),
			};
		case "schedule/unsubscribe":
			context.subscriptions.unsubscribeSchedule();
			return { unsubscribed: true };
		default:
			throw new Error(`Unhandled schedule request: ${request.method}`);
	}
}
