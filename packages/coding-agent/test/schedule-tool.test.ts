import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { ScheduleManager } from "../src/core/schedules/manager.ts";
import { installScheduleHost, SCHEDULE_MAIN_PROMPT, ScheduleToolInputSchema } from "../src/core/schedules/tool.ts";
import type { ScheduleTask } from "../src/core/schedules/types.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const harnesses: Harness[] = [];

function task(id = "task-created"): ScheduleTask {
	return {
		id,
		title: "生成摘要",
		instruction: "生成摘要",
		schedule: { kind: "daily", time: "09:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "project", cwd: "/project" },
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
				target: { kind: "project" as const, cwd: "/project" },
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
	let installed: ToolDefinition | undefined;
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
			installed = tools[0];
			installOptions = options;
		},
		removeHostTools,
	} as unknown as AgentSession;
	return {
		session,
		get tool() {
			return installed;
		},
		get installOptions() {
			return installOptions;
		},
		removeHostTools,
	};
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("schedule host tool", () => {
	it("has a strict schema with no host-owned execution fields", () => {
		expect(
			Value.Check(ScheduleToolInputSchema, {
				action: "create",
				instruction: "日报",
				schedule: { kind: "daily", time: "09:00" },
			}),
		).toBe(true);
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
		const host = fakeSession({ mode: "code", cwdOrigin: "user-selected", cwd: "/project" });
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
			{ mode: "code", cwdOrigin: "user-selected", cwd: "/project" },
			{ kind: "project", cwd: "/project" },
		],
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
				createdFromSessionId: "source-session",
			}),
		);
		dispose();
		expect(host.removeHostTools).toHaveBeenCalledWith(["schedule"]);
	});

	it("omits the tool from scheduled and child sessions", () => {
		for (const header of [
			{ scheduled: { taskId: "task-1", runId: "run-1" } },
			{ subagent: { agentId: "agent-1", name: "child", parentSessionId: "parent-1" } },
		]) {
			const host = fakeSession({ mode: "code", cwdOrigin: "user-selected", cwd: "/project", header });
			installScheduleHost({ session: host.session, manager: fakeManager(), timezone: "Asia/Shanghai" });
			expect(host.tool).toBeUndefined();
		}
	});

	it("replaces duplicate installs and removes only the named host tool", () => {
		const harness = createHarness();
		harnesses.push(harness);
		const first = installScheduleHost({
			session: harness.session,
			manager: fakeManager(),
			timezone: "Asia/Shanghai",
		});
		const second = installScheduleHost({
			session: harness.session,
			manager: fakeManager(),
			timezone: "Asia/Shanghai",
		});
		expect(harness.session.getAllTools().filter(({ name }) => name === "schedule")).toHaveLength(1);
		second();
		expect(harness.session.getAllTools().some(({ name }) => name === "schedule")).toBe(false);
		first();
	});

	it("keeps the main prompt minimal and model-facing", () => {
		expect(SCHEDULE_MAIN_PROMPT).toBe(
			"你可以使用 schedule 工具创建和管理定时任务。创建时，请把任务写成无需依赖当前对话也能理解的完整说明，并按用户当前时区提交明确的时间与周期；如果信息不完整，先向用户确认。",
		);
		expect(SCHEDULE_MAIN_PROMPT).not.toMatch(/cwd|沙箱|开发者|实现/);
	});
});
