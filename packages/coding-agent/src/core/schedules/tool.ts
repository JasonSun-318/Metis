import { randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import { defineTool } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import type { ScheduleManager } from "./manager.ts";
import type { ScheduleCreateTarget, ScheduleRun, ScheduleTask } from "./types.ts";

export const SCHEDULE_MAIN_PROMPT =
	"当用户要求未来执行或周期性执行任务时，可以使用 `schedule` 工具。创建前确保任务内容和执行时间明确；信息不足时先询问用户。";

const StrictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const Time = Type.String({ description: "本地时间，24 小时制 HH:mm。", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });
const DateValue = Type.String({ description: "本地日期，格式 YYYY-MM-DD。", pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const ScheduleInput = Type.Union(
	[
		StrictObject({ kind: Type.Literal("once"), date: DateValue, time: Time }),
		StrictObject({ kind: Type.Literal("daily"), time: Time }),
		StrictObject({
			kind: Type.Literal("weekly"),
			weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
				description: "每周执行的星期，1 为周一，7 为周日。",
				minItems: 1,
				maxItems: 7,
				uniqueItems: true,
			}),
			time: Time,
		}),
		StrictObject({
			kind: Type.Literal("monthly"),
			day: Type.Integer({ description: "每月执行的日期，1 至 31。", minimum: 1, maximum: 31 }),
			time: Time,
		}),
		StrictObject({
			kind: Type.Literal("interval"),
			every: Type.Integer({ description: "间隔数量，1 至 10000。", minimum: 1, maximum: 10_000 }),
			unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")], {
				description: "间隔单位：minute 或 hour。",
			}),
			startDate: Type.String({ description: "本地日期，格式 YYYY-MM-DD。", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
			startTime: Type.String({
				description: "本地时间，24 小时制 HH:mm。",
				pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
			}),
		}),
	],
	{ description: "任务的执行时间或重复周期。" },
);

const TaskId = Type.String({
	description: "定时任务的唯一标识。无法确定时先使用 `list` 查询。",
	minLength: 1,
	maxLength: 255,
});

const TaskCursor = Type.String({
	description: "上一页返回的 nextAfterTaskId。",
	minLength: 1,
	maxLength: 255,
});

export const ScheduleToolInputSchema = Type.Union([
	StrictObject({
		action: Type.Literal("create"),
		name: Type.String({ description: "定时任务在桌面端显示的名称。", minLength: 1, maxLength: 256 }),
		description: Type.Optional(Type.String({ description: "桌面端显示的可选说明。", maxLength: 64 * 1024 })),
		instruction: Type.String({
			description: "每次执行时需要完成的完整任务说明。不得依赖当前对话中的省略信息。",
			minLength: 1,
			maxLength: 64 * 1024,
		}),
		schedule: ScheduleInput,
	}),
	StrictObject({ action: Type.Literal("list"), afterTaskId: Type.Optional(TaskCursor) }),
	StrictObject({ action: Type.Literal("get"), taskId: TaskId }),
	StrictObject({
		action: Type.Literal("update"),
		taskId: TaskId,
		name: Type.Optional(Type.String({ description: "定时任务在桌面端显示的名称。", minLength: 1, maxLength: 256 })),
		description: Type.Optional(Type.String({ description: "桌面端显示的可选说明。", maxLength: 64 * 1024 })),
		instruction: Type.Optional(
			Type.String({
				description: "每次执行时需要完成的完整任务说明。不得依赖当前对话中的省略信息。",
				minLength: 1,
				maxLength: 64 * 1024,
			}),
		),
		schedule: Type.Optional(ScheduleInput),
	}),
	StrictObject({
		action: Type.Union([
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("delete"),
			Type.Literal("run_now"),
		]),
		taskId: TaskId,
	}),
]);

function prepareScheduleArguments(input: unknown): Static<typeof ScheduleToolInputSchema> {
	if (!input || typeof input !== "object") return input as Static<typeof ScheduleToolInputSchema>;
	const args = input as Record<string, unknown>;
	if (typeof args.schedule === "string") {
		try {
			const parsed = JSON.parse(args.schedule);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args.schedule = parsed;
		} catch {}
	}
	return args as Static<typeof ScheduleToolInputSchema>;
}

export function resolveScheduleCreateTarget(input: {
	mode: "chat" | "code";
	cwdOrigin: "managed" | "user-selected";
	cwd: string;
}): ScheduleCreateTarget | undefined {
	if (input.mode !== "chat") return undefined;
	return input.cwdOrigin === "user-selected"
		? { kind: "general", workspace: "fixed", cwd: input.cwd }
		: { kind: "general", workspace: "task" };
}

export function isScheduleSessionEligible(manager: Pick<SessionManager, "getHeader" | "getMode">): boolean {
	const header = manager.getHeader();
	return manager.getMode() === "chat" && !header?.scheduled && !header?.subagent;
}

function compactTaskView(task: ScheduleTask) {
	return {
		id: task.id,
		name: task.title,
		description: task.description,
		status: task.status,
		schedule: task.schedule,
		nextRunAt: task.nextRunAt,
		cwd: task.target.cwd,
		unreadCount: task.unreadCount,
	};
}

function listTaskView(task: ScheduleTask) {
	return { ...compactTaskView(task), instructionPreview: task.instruction.slice(0, 500) };
}

async function detailTaskView(manager: ScheduleManager, task: ScheduleTask) {
	const latestRunId = task.activeRunId ?? task.lastRun?.id;
	const lastRun = latestRunId ? await manager.getRun(task.id, latestRunId) : undefined;
	return {
		...compactTaskView(task),
		instruction: task.instruction,
		model: task.model,
		timezone: task.timezone,
		...(lastRun
			? {
					lastRun: {
						id: lastRun.id,
						status: lastRun.status,
						scheduledFor: lastRun.scheduledFor,
						createdAt: lastRun.createdAt,
						...(lastRun.startedAt ? { startedAt: lastRun.startedAt } : {}),
						...(lastRun.completedAt ? { completedAt: lastRun.completedAt } : {}),
						...(lastRun.sessionId ? { sessionId: lastRun.sessionId } : {}),
						...(lastRun.resultPreview !== undefined ? { resultPreview: lastRun.resultPreview } : {}),
						...(lastRun.error ? { error: lastRun.error } : {}),
					},
				}
			: {}),
	};
}

function runView(run: ScheduleRun) {
	return { runId: run.id, taskId: run.taskId, status: run.status, scheduledFor: run.scheduledFor };
}

function output(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
		details: value,
		...(isError ? { isError: true } : {}),
	};
}

export function installScheduleHost(input: {
	session: AgentSession;
	manager: ScheduleManager;
	timezone: string;
}): () => void {
	if (!isScheduleSessionEligible(input.session.sessionManager)) return () => {};
	const tool = defineTool({
		name: "schedule",
		label: "定时任务",
		description: "创建和管理定时任务。创建时，请提供可独立执行的完整任务说明和明确的执行时间；信息不足时先询问用户。",
		parameters: ScheduleToolInputSchema,
		prepareArguments: prepareScheduleArguments,
		executionMode: "sequential" as const,
		async execute(_toolCallId, params) {
			try {
				switch (params.action) {
					case "create": {
						const manager = input.session.sessionManager;
						const target = resolveScheduleCreateTarget({
							mode: manager.getMode(),
							cwdOrigin: manager.getCwdOrigin(),
							cwd: manager.getCwd(),
						});
						if (!target) return output("定时任务只能在 Chat 中创建。", true);
						const model = input.session.model;
						if (!model) return output("当前会话尚未配置模型，无法创建定时任务。", true);
						const task = await input.manager.create({
							id: randomUUID(),
							name: params.name,
							description: params.description,
							instruction: params.instruction,
							model: { provider: model.provider, modelId: model.id },
							schedule: params.schedule,
							timezone: input.timezone,
							target,
						});
						return output({ taskId: task.id, status: task.status, nextRunAt: task.nextRunAt });
					}
					case "list": {
						const page = await input.manager.list({ afterTaskId: params.afterTaskId, limit: 100 });
						return output({ tasks: page.tasks.map(listTaskView), nextAfterTaskId: page.nextAfterTaskId });
					}
					case "get":
						return output(await detailTaskView(input.manager, await input.manager.get(params.taskId)));
					case "update": {
						if (
							params.name === undefined &&
							params.description === undefined &&
							params.instruction === undefined &&
							params.schedule === undefined
						) {
							return output("更新定时任务时至少需要提供一个字段。", true);
						}
						return output(
							compactTaskView(
								await input.manager.update(params.taskId, {
									name: params.name,
									description: params.description,
									instruction: params.instruction,
									schedule: params.schedule,
								}),
							),
						);
					}
					case "pause":
						return output(compactTaskView(await input.manager.pause(params.taskId)));
					case "resume":
						return output(compactTaskView(await input.manager.resume(params.taskId)));
					case "delete":
						return output(await input.manager.delete(params.taskId, { deleteSessions: false }));
					case "run_now":
						return output(runView(await input.manager.runNow(params.taskId, randomUUID())));
				}
			} catch (error) {
				return output(error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "定时任务操作失败。", true);
			}
		},
	});
	input.session.installHostTools([tool], { automaticPermissionToolNames: [tool.name] });
	return () => input.session.removeHostTools([tool.name]);
}
