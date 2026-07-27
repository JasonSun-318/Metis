import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ScheduleManager } from "../src/core/schedules/manager.ts";
import type { ScheduleRun, ScheduleTask } from "../src/core/schedules/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const TASK_ID = "20000000-0000-4000-8000-000000000001";

function task(): ScheduleTask {
	return {
		id: TASK_ID,
		title: "提交报告",
		instruction: "提交报告",
		schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
		timezone: "Asia/Shanghai",
		target: { kind: "project", cwd: "/project" },
		status: "active",
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:00.000Z",
		nextRunAt: "2026-08-03T01:30:00.000Z",
		unreadCount: 0,
		nextRunSequence: 1,
	};
}

describe("/schedule", () => {
	it("is one argument-free built-in command", () => {
		const commands = BUILTIN_SLASH_COMMANDS.filter(({ name }) => name === "schedule");
		expect(commands).toEqual([{ name: "schedule", description: "Manage scheduled tasks" }]);
	});

	it("creates through structured instruction, recurrence, date, and time fields only", async () => {
		const manager = {
			list: vi.fn(async () => ({ tasks: [], nextAfterTaskId: null })),
			create: vi.fn(async () => task()),
		} as unknown as ScheduleManager;
		const selectorChoices = ["创建任务", "仅一次", "创建", "关闭"];
		const inputValues = ["2026-08-03", "09:30"];
		const dialogs: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			options: { scheduleManager: manager },
			runtimeHost: {
				session: {
					sessionManager: {
						getMode: () => "code",
						getCwd: () => "/project",
						getCwdOrigin: () => "user-selected",
						getSessionId: () => "source-session",
					},
				},
			},
			guardSessionMutation: () => false,
			showExtensionEditor: vi.fn(async (title: string) => {
				dialogs.push(title);
				return "提交报告";
			}),
			showExtensionInput: vi.fn(async (title: string) => {
				dialogs.push(title);
				return inputValues.shift();
			}),
			showExtensionSelector: vi.fn(async (title: string) => {
				dialogs.push(title);
				return selectorChoices.shift();
			}),
			showStatus: vi.fn(),
			showError: vi.fn((message: string) => {
				throw new Error(message);
			}),
		});

		await (mode as unknown as { handleScheduleCommand(): Promise<void> }).handleScheduleCommand();
		expect(manager.create).toHaveBeenCalledWith(
			expect.objectContaining({
				instruction: "提交报告",
				schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
				target: { kind: "project", cwd: "/project" },
				createdFromSessionId: "source-session",
			}),
		);
		expect(dialogs.join("\n")).toContain("任务内容");
		expect(dialogs.join("\n")).toContain("执行周期");
		expect(dialogs.join("\n")).toContain("执行日期");
		expect(dialogs.join("\n")).toContain("执行时间");
		expect(dialogs.join("\n")).not.toMatch(/模式|项目路径|模型|权限|沙箱|设置/);
	});

	it("does not offer invalid edit or pause actions after a one-time task completes", async () => {
		const manager = {
			get: vi.fn(async () => ({ ...task(), status: "completed", nextRunAt: null })),
		} as unknown as ScheduleManager;
		let actions: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			showExtensionSelector: vi.fn(async (_title: string, choices: string[]) => {
				actions = choices;
				return "返回";
			}),
		});

		await (
			mode as unknown as { showScheduleTask(manager: ScheduleManager, taskId: string): Promise<void> }
		).showScheduleTask(manager, TASK_ID);
		expect(actions).not.toEqual(expect.arrayContaining(["修改任务内容", "修改时间和周期", "暂停", "恢复"]));
		expect(actions).toEqual(expect.arrayContaining(["查看执行记录", "立即运行", "删除", "返回"]));
	});

	it("never opens a result journal outside the task-owned session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-schedule-cli-forged-"));
		try {
			const cwd = join(root, "project");
			mkdirSync(cwd);
			const session = SessionManager.create(cwd, join(root, "ordinary"), { id: "forged-session" });
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "FORGED SECRET" }],
				api: "openai-completions",
				provider: "openai",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			const sessionFile = session.getSessionFile()!;
			session.close();
			const run: ScheduleRun = {
				id: "run-forged",
				taskId: TASK_ID,
				sequence: 1,
				trigger: "manual",
				status: "succeeded",
				scheduledFor: "2026-07-26T00:00:00Z",
				createdAt: "2026-07-26T00:00:00Z",
				completedAt: "2026-07-26T00:01:00Z",
				sessionId: "forged-session",
				sessionFile,
				resultPreview: "安全摘要",
				unread: false,
				snapshot: {
					instruction: task().instruction,
					schedule: task().schedule,
					timezone: task().timezone,
					target: task().target,
				},
			};
			let dialog = "";
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				showExtensionSelector: vi.fn(async (title: string) => {
					dialog = title;
					return "返回";
				}),
			});

			await (
				mode as unknown as {
					showScheduleRun(manager: ScheduleManager, task: ScheduleTask, run: ScheduleRun): Promise<void>;
				}
			).showScheduleRun({ agentDir: join(root, "agent") } as ScheduleManager, task(), run);
			expect(dialog).toContain("安全摘要");
			expect(dialog).not.toContain("FORGED SECRET");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
