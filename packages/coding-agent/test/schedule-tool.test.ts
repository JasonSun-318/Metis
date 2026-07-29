import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { ScheduleManager } from "../src/core/schedules/manager.ts";
import { installScheduleHost, SCHEDULE_MAIN_PROMPT, ScheduleToolInputSchema } from "../src/core/schedules/tool.ts";
import type { ScheduleTask } from "../src/core/schedules/types.ts";

function task(id = "task-created"): ScheduleTask {
	return {
		id,
		title: "生成摘要",
		instruction: "生成摘要",
		schedule: { kind: "daily", time: "09:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "fixed", cwd: "/project" },
		status: "active",
		createdAt: "2026-07-26T00:00:00Z",
		updatedAt: "2026-07-26T00:00:00Z",
		nextRunAt: "2026-07-27T01:00:00Z",
		unreadCount: 0,
		nextRunSequence: 1,
	};
}

function fakeManager() {
	return {
		create: vi.fn(async () => task()),
		list: vi.fn(async () => ({ tasks: [task()], nextAfterTaskId: null })),
		get: vi.fn(async () => ({
			...task(),
			lastRun: {
				id: "run-latest",
				taskId: "task-created",
				sequence: 1,
				status: "succeeded" as const,
				scheduledFor: "2026-07-27T01:00:00Z",
				createdAt: "2026-07-27T01:00:00Z",
				completedAt: "2026-07-27T01:01:00Z",
				sessionId: "session-latest",
				resultPreview: "done",
				unread: true,
			},
		})),
		getRun: vi.fn(async () => ({
			id: "run-latest",
			taskId: "task-created",
			sequence: 1,
			trigger: "scheduled" as const,
			status: "succeeded" as const,
			scheduledFor: "2026-07-27T01:00:00Z",
			createdAt: "2026-07-27T01:00:00Z",
			startedAt: "2026-07-27T01:00:01Z",
			completedAt: "2026-07-27T01:01:00Z",
			sessionId: "session-latest",
			resultPreview: "done",
			unread: true,
			snapshot: {
				instruction: "生成摘要",
				schedule: { kind: "daily" as const, time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general" as const, workspace: "fixed" as const, cwd: "/project" },
			},
		})),
		update: vi.fn(async () => task()),
		pause: vi.fn(async () => ({ ...task(), status: "paused" as const })),
		resume: vi.fn(async () => task()),
		delete: vi.fn(async (taskId: string) => ({ taskId, deleted: true as const })),
		runNow: vi.fn(async (taskId: string, id: string) => ({
			id,
			taskId,
			sequence: 1,
			trigger: "manual" as const,
			status: "queued" as const,
			scheduledFor: "2026-07-26T00:00:00Z",
			createdAt: "2026-07-26T00:00:00Z",
			unread: false,
			snapshot: {
				instruction: "生成摘要",
				schedule: { kind: "daily" as const, time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general" as const, workspace: "fixed" as const, cwd: "/project" },
			},
		})),
	} as unknown as ScheduleManager;
}

function fakeSession(input: {
	mode: "chat" | "code";
	cwdOrigin: "managed" | "user-selected";
	cwd: string;
	header?: {
		scheduled?: { taskId: string; runId: string };
		subagent?: { agentId: string; name: string; parentSessionId: string };
	};
}) {
	const installed = new Map<string, ToolDefinition>();
	let installOptions: unknown;
	const removeHostTools = vi.fn();
	const session = {
		sessionManager: {
			getHeader: () => input.header,
			getMode: () => input.mode,
			getCwdOrigin: () => input.cwdOrigin,
			getCwd: () => input.cwd,
			getSessionId: () => "source-session",
		},
		installHostTools: (tools: ToolDefinition[], options: unknown) => {
			for (const tool of tools) installed.set(tool.name, tool);
			installOptions = options;
		},
		removeHostTools: (names: string[]) => {
			removeHostTools(names);
			for (const name of names) installed.delete(name);
		},
	} as unknown as AgentSession;
	return {
		session,
		get tool() {
			return installed.get("schedule");
		},
		get installOptions() {
			return installOptions;
		},
		removeHostTools,
	};
}

describe("schedule host tool", () => {
	it("has a strict schema with no host-owned execution fields", () => {
		expect(
			Value.Check(ScheduleToolInputSchema, {
				action: "create",
				instruction: "日报",
				schedule: { kind: "daily", time: "09:00" },
			}),
		).toBe(true);
		expect(Value.Check(ScheduleToolInputSchema, { action: "get", taskId: "task-created" })).toBe(true);
		expect(Value.Check(ScheduleToolInputSchema, { action: "get" })).toBe(false);
		expect(
			Value.Check(ScheduleToolInputSchema, {
				action: "create",
				instruction: "日报",
				schedule: { kind: "daily", time: "09:00" },
				cwd: "/forbidden",
			}),
		).toBe(false);
		const schema = JSON.stringify(ScheduleToolInputSchema);
		for (const field of [
			"target",
			"cwd",
			"workspace",
			"mode",
			"model",
			"thinking",
			"permission",
			"sandbox",
			"sourceSessionId",
			"createdFromSessionId",
			"timezone",
			"runId",
			"status",
		]) {
			expect(schema).not.toContain(`"${field}"`);
		}
		const visit = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			if (record.type === "object") expect(record.additionalProperties).toBe(false);
			for (const child of Object.values(record)) visit(child);
		};
		visit(ScheduleToolInputSchema);
	});

	it("accepts a model-provided JSON string for schedule", () => {
		const host = fakeSession({ mode: "chat", cwdOrigin: "user-selected", cwd: "/project" });
		installScheduleHost({ session: host.session, manager: fakeManager(), timezone: "Asia/Shanghai" });
		const prepared = host.tool!.prepareArguments!({
			action: "create",
			instruction: "创建桌面留言文件",
			schedule: '{"kind":"once","date":"2026-07-27","time":"11:52"}',
		});
		expect(prepared).toEqual({
			action: "create",
			instruction: "创建桌面留言文件",
			schedule: { kind: "once", date: "2026-07-27", time: "11:52" },
		});
		expect(Value.Check(ScheduleToolInputSchema, prepared)).toBe(true);
		expect(
			Value.Check(
				ScheduleToolInputSchema,
				host.tool!.prepareArguments!({ action: "create", instruction: "无效时间", schedule: "not-json" }),
			),
		).toBe(false);
	});

	it.each([
		[
			{ mode: "chat", cwdOrigin: "user-selected", cwd: "/notes" },
			{ kind: "general", workspace: "fixed", cwd: "/notes" },
		],
		[
			{ mode: "chat", cwdOrigin: "managed", cwd: "/old-chat" },
			{ kind: "general", workspace: "task" },
		],
	] as const)("derives target outside model input", async (source, expected) => {
		const host = fakeSession(source);
		const manager = fakeManager();
		const dispose = installScheduleHost({ session: host.session, manager, timezone: "Asia/Shanghai" });
		expect(host.installOptions).toEqual({ automaticPermissionToolNames: ["schedule"] });
		await host.tool!.execute(
			"call-1",
			{ action: "create", instruction: "生成摘要", schedule: { kind: "daily", time: "09:00" } },
			undefined,
			undefined,
			{} as never,
		);
		expect(manager.create).toHaveBeenCalledWith(
			expect.objectContaining({
				target: expected,
				timezone: "Asia/Shanghai",
			}),
		);
		expect(manager.create).toHaveBeenCalledWith(
			expect.not.objectContaining({ createdFromSessionId: expect.anything() }),
		);
		dispose();
		expect(host.removeHostTools).toHaveBeenCalledWith(["schedule"]);
	});

	it("omits the tool from Code, scheduled, and child sessions", () => {
		for (const source of [
			{ mode: "code" as const, header: undefined },
			{ mode: "chat" as const, header: { scheduled: { taskId: "task-1", runId: "run-1" } } },
			{
				mode: "chat" as const,
				header: { subagent: { agentId: "agent-1", name: "child", parentSessionId: "parent-1" } },
			},
		]) {
			const host = fakeSession({
				mode: source.mode,
				cwdOrigin: "user-selected",
				cwd: "/project",
				header: source.header,
			});
			installScheduleHost({ session: host.session, manager: fakeManager(), timezone: "Asia/Shanghai" });
			expect(host.tool).toBeUndefined();
		}
	});

	it("replaces duplicate installs and removes only the named host tool", () => {
		const host = fakeSession({ mode: "chat", cwdOrigin: "managed", cwd: "/managed" });
		const first = installScheduleHost({
			session: host.session,
			manager: fakeManager(),
			timezone: "Asia/Shanghai",
		});
		const second = installScheduleHost({
			session: host.session,
			manager: fakeManager(),
			timezone: "Asia/Shanghai",
		});
		expect(host.tool?.name).toBe("schedule");
		second();
		expect(host.tool).toBeUndefined();
		first();
	});

	it("returns machine-readable creation and latest-run status", async () => {
		const host = fakeSession({ mode: "chat", cwdOrigin: "managed", cwd: "/managed" });
		installScheduleHost({ session: host.session, manager: fakeManager(), timezone: "Asia/Shanghai" });
		const created = await host.tool!.execute(
			"create",
			{ action: "create", instruction: "生成摘要", schedule: { kind: "daily", time: "09:00" } },
			undefined,
			undefined,
			{} as never,
		);
		expect(created.details).toEqual({
			taskId: "task-created",
			status: "active",
			nextRunAt: "2026-07-27T01:00:00Z",
		});
		const detail = await host.tool!.execute(
			"get",
			{ action: "get", taskId: "task-created" },
			undefined,
			undefined,
			{} as never,
		);
		expect(detail.details).toMatchObject({
			id: "task-created",
			cwd: "/project",
			lastRun: { id: "run-latest", sessionId: "session-latest", resultPreview: "done" },
		});
		const run = await host.tool!.execute(
			"run",
			{ action: "run_now", taskId: "task-created" },
			undefined,
			undefined,
			{} as never,
		);
		expect(run.details).toMatchObject({ runId: expect.any(String), taskId: "task-created", status: "queued" });
		expect(run.details).not.toHaveProperty("id");
	});

	it("reports the active execution instead of an older completed run", async () => {
		const manager = fakeManager();
		vi.mocked(manager.get).mockResolvedValue({ ...task(), activeRunId: "run-active" });
		vi.mocked(manager.getRun).mockResolvedValue({
			id: "run-active",
			taskId: "task-created",
			sequence: 2,
			trigger: "manual",
			status: "running",
			scheduledFor: "2026-07-27T02:00:00Z",
			createdAt: "2026-07-27T02:00:00Z",
			startedAt: "2026-07-27T02:00:01Z",
			sessionId: "session-active",
			unread: false,
			snapshot: {
				instruction: "生成摘要",
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "fixed", cwd: "/project" },
			},
		});
		const host = fakeSession({ mode: "chat", cwdOrigin: "managed", cwd: "/managed" });
		installScheduleHost({ session: host.session, manager, timezone: "Asia/Shanghai" });
		const detail = await host.tool!.execute(
			"get",
			{ action: "get", taskId: "task-created" },
			undefined,
			undefined,
			{} as never,
		);
		expect(manager.getRun).toHaveBeenCalledWith("task-created", "run-active");
		expect(detail.details).toMatchObject({
			lastRun: { id: "run-active", status: "running", sessionId: "session-active" },
		});
	});

	it("keeps the main prompt minimal and model-facing", () => {
		expect(SCHEDULE_MAIN_PROMPT).toBe(
			"当用户要求未来执行或周期性执行任务时，可以使用 `schedule` 工具。创建前确保任务内容和执行时间明确；信息不足时先询问用户。",
		);
		const host = fakeSession({ mode: "chat", cwdOrigin: "managed", cwd: "/managed" });
		installScheduleHost({ session: host.session, manager: fakeManager(), timezone: "Asia/Shanghai" });
		expect(host.tool?.description).toBe(
			"创建和管理定时任务。创建时，请提供可独立执行的完整任务说明和明确的执行时间；信息不足时先询问用户。",
		);
		const contract = `${SCHEDULE_MAIN_PROMPT}\n${host.tool?.description}\n${JSON.stringify(ScheduleToolInputSchema)}`;
		for (const wording of [
			"每次执行时需要完成的完整任务说明。不得依赖当前对话中的省略信息。",
			"任务的执行时间或重复周期。",
			"定时任务的唯一标识。无法确定时先使用 `list` 查询。",
		]) {
			expect(contract).toContain(wording);
		}
		expect(contract).not.toMatch(/cwd|宿主|当前 Chat|沙箱|开发者|项目路径/);
	});
});
