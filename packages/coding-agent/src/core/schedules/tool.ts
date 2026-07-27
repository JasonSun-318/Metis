import { randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import { defineTool } from "../extensions/types.ts";
import type { ScheduleManager } from "./manager.ts";
import type { ScheduleCreateTarget, ScheduleRun, ScheduleTask } from "./types.ts";

export const SCHEDULE_MAIN_PROMPT =
	"你可以使用 schedule 工具创建和管理定时任务。创建时，请把任务写成无需依赖当前对话也能理解的完整说明，并按用户当前时区提交明确的时间与周期；如果信息不完整，先向用户确认。";

const StrictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const Time = Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" });
const DateValue = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const ScheduleInput = Type.Union([
	StrictObject({ kind: Type.Literal("once"), date: DateValue, time: Time }),
	StrictObject({ kind: Type.Literal("daily"), time: Time }),
	StrictObject({
		kind: Type.Literal("weekly"),
		weekdays: Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true }),
		time: Time,
	}),
	StrictObject({ kind: Type.Literal("monthly"), day: Type.Integer({ minimum: 1, maximum: 31 }), time: Time }),
	StrictObject({
		kind: Type.Literal("interval"),
		every: Type.Integer({ minimum: 1, maximum: 10_000 }),
		unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")]),
		startDate: DateValue,
		startTime: Time,
	}),
]);

export const ScheduleToolInputSchema = Type.Union([
	StrictObject({
		action: Type.Literal("create"),
		instruction: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
		schedule: ScheduleInput,
	}),
	StrictObject({ action: Type.Literal("list") }),
	StrictObject({
		action: Type.Literal("update"),
		taskId: Type.String({ minLength: 1, maxLength: 255 }),
		instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 64 * 1024 })),
		schedule: Type.Optional(ScheduleInput),
	}),
	StrictObject({
		action: Type.Union([
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("delete"),
			Type.Literal("run_now"),
		]),
		taskId: Type.String({ minLength: 1, maxLength: 255 }),
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

function targetFromSession(session: AgentSession): ScheduleCreateTarget {
	const manager = session.sessionManager;
	if (manager.getMode() === "code") return { kind: "project", cwd: manager.getCwd() };
	return manager.getCwdOrigin() === "user-selected"
		? { kind: "general", workspace: "fixed", cwd: manager.getCwd() }
		: { kind: "general", workspace: "task" };
}

function taskView(task: ScheduleTask) {
	return {
		id: task.id,
		title: task.title,
		status: task.status,
		nextRunAt: task.nextRunAt,
		unreadCount: task.unreadCount,
	};
}

function runView(run: ScheduleRun) {
	return { id: run.id, taskId: run.taskId, status: run.status, scheduledFor: run.scheduledFor };
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
	const header = input.session.sessionManager.getHeader();
	if (header?.scheduled || header?.subagent) return () => {};
	const tool = defineTool({
		name: "schedule",
		label: "定时任务",
		description: "创建、查看、修改、暂停、恢复、删除或立即运行定时任务。任务内容必须脱离当前对话也能独立理解。",
		parameters: ScheduleToolInputSchema,
		prepareArguments: prepareScheduleArguments,
		executionMode: "sequential" as const,
		async execute(_toolCallId, params) {
			try {
				switch (params.action) {
					case "create": {
						const task = await input.manager.create({
							id: randomUUID(),
							instruction: params.instruction,
							schedule: params.schedule,
							timezone: input.timezone,
							target: targetFromSession(input.session),
							createdFromSessionId: input.session.sessionManager.getSessionId(),
						});
						return output(`已创建定时任务 ${task.id}，下次执行时间：${task.nextRunAt ?? "无"}`);
					}
					case "list": {
						const page = await input.manager.list({ limit: 100 });
						return output({ tasks: page.tasks.map(taskView), nextAfterTaskId: page.nextAfterTaskId });
					}
					case "update": {
						if (params.instruction === undefined && params.schedule === undefined) {
							return output("更新定时任务时至少需要提供任务内容或时间周期。", true);
						}
						return output(
							taskView(
								await input.manager.update(params.taskId, {
									instruction: params.instruction,
									schedule: params.schedule,
								}),
							),
						);
					}
					case "pause":
						return output(taskView(await input.manager.pause(params.taskId)));
					case "resume":
						return output(taskView(await input.manager.resume(params.taskId)));
					case "delete":
						return output(await input.manager.delete(params.taskId));
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
