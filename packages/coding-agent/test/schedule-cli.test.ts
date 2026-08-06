import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ScheduleManager } from "../src/core/schedules/manager.ts";
import type { ScheduleInputSpec, ScheduleRun, ScheduleTask } from "../src/core/schedules/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const TASK_ID = "20000000-0000-4000-8000-000000000001";

function task(): ScheduleTask {
	return {
		id: TASK_ID,
		title: "Submit report",
		instruction: "Submit report",
		model: { provider: "openai", modelId: "gpt-test" },
		schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "fixed", cwd: "/project" },
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
		expect(commands).toEqual([{ name: "schedule", description: "Manage scheduled tasks", modes: ["chat"] }]);
		expect(getBuiltinSlashCommands("chat").some(({ name }) => name === "schedule")).toBe(true);
		expect(getBuiltinSlashCommands("code").some(({ name }) => name === "schedule")).toBe(false);
	});

	it("opens exactly three root choices and closes with Esc", async () => {
		let title = "";
		let choices: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			options: { scheduleManager: {} as ScheduleManager },
			runtimeHost: { session: { sessionManager: { getMode: () => "chat" } } },
			guardSessionMutation: () => false,
			showExtensionSelector: vi.fn(async (nextTitle: string, nextChoices: string[]) => {
				title = nextTitle;
				choices = nextChoices;
				return undefined;
			}),
			showError: vi.fn(),
		});

		await (mode as unknown as { handleScheduleCommand(): Promise<void> }).handleScheduleCommand();
		expect(title).toBe("Schedule");
		expect(choices).toEqual(["Create task", "Scheduled tasks", "Execution history"]);
	});

	it("rejects a pasted /schedule command in Code mode", async () => {
		const showExtensionSelector = vi.fn();
		const showWarning = vi.fn();
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			options: { scheduleManager: {} as ScheduleManager },
			runtimeHost: { session: { sessionManager: { getMode: () => "code" } } },
			guardSessionMutation: () => false,
			showExtensionSelector,
			showWarning,
		});
		await (mode as unknown as { handleScheduleCommand(): Promise<void> }).handleScheduleCommand();
		expect(showWarning).toHaveBeenCalledWith("Scheduled tasks are only available in Chat mode");
		expect(showExtensionSelector).not.toHaveBeenCalled();
	});

	it("creates through explicit display metadata, instruction, model, and recurrence", async () => {
		const manager = {
			create: vi.fn(async () => task()),
		} as unknown as ScheduleManager;
		const selectorChoices: Array<string | undefined> = ["Create task", "Once", "Create", undefined];
		const inputValues = ["Submit report", "", "2026-08-03", "09:30"];
		const dialogs: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			options: { scheduleManager: manager },
			runtimeHost: {
				session: {
					model: { provider: "openai", id: "gpt-test" },
					sessionManager: {
						getMode: () => "chat",
						getCwd: () => "/project",
						getCwdOrigin: () => "user-selected",
						getSessionId: () => "source-session",
					},
				},
			},
			guardSessionMutation: () => false,
			showExtensionEditor: vi.fn(async (title: string) => {
				dialogs.push(title);
				return "Submit report";
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
				name: "Submit report",
				instruction: "Submit report",
				model: { provider: "openai", modelId: "gpt-test" },
				schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
				target: { kind: "general", workspace: "fixed", cwd: "/project" },
			}),
		);
		expect(dialogs.join("\n")).toContain("Task instructions");
		expect(dialogs.join("\n")).toContain("Recurrence");
		expect(dialogs.join("\n")).toContain("Run date");
		expect(dialogs.join("\n")).toContain("Run time");
		expect(dialogs.findIndex((title) => title.includes("Task name"))).toBeLessThan(
			dialogs.findIndex((title) => title.includes("Task instructions")),
		);
		expect(dialogs.findIndex((title) => title.includes("Task instructions"))).toBeLessThan(
			dialogs.findIndex((title) => title.includes("Recurrence")),
		);
		expect(dialogs.join("\n")).not.toMatch(/project path|permission|sandbox|settings/i);
	});

	it("accepts the documented maximum interval", async () => {
		const selectorChoices = ["Interval", "Minutes"];
		const inputValues = ["10000", "2026-08-03", "09:30"];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			showExtensionSelector: vi.fn(async () => selectorChoices.shift()),
			showExtensionInput: vi.fn(async () => inputValues.shift()),
			showWarning: vi.fn(),
		});

		const schedule = await (
			mode as unknown as { askScheduleSpec(): Promise<ScheduleInputSpec | undefined> }
		).askScheduleSpec();
		expect(schedule).toEqual({
			kind: "interval",
			every: 10_000,
			unit: "minute",
			startDate: "2026-08-03",
			startTime: "09:30",
		});
		expect(inputValues).toEqual([]);
	});

	it("separates task plans from execution history, keeps duplicate rows, and localizes statuses", async () => {
		const latestRun: ScheduleRun = {
			id: "run-latest",
			taskId: TASK_ID,
			sequence: 1,
			trigger: "scheduled",
			status: "succeeded",
			scheduledFor: "2026-08-03T01:30:00.000Z",
			createdAt: "2026-08-03T01:30:00.000Z",
			completedAt: "2026-08-03T01:31:00.000Z",
			resultPreview: "Submitted",
			unread: true,
			snapshot: {
				name: "Submit report",
				model: { provider: "openai", modelId: "gpt-test" },
				instruction: "Submit report",
				schedule: task().schedule,
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "fixed", cwd: "/project" },
			},
		};
		const duplicateTask = {
			...task(),
			id: "20000000-0000-4000-8000-000000000002",
			lastRun: { ...latestRun, taskId: "20000000-0000-4000-8000-000000000002" },
		};
		const manager = {
			list: vi.fn(async () => ({
				tasks: [
					{ ...task(), unreadCount: 1, lastRun: latestRun },
					{ ...duplicateTask, unreadCount: 1 },
				],
				nextAfterTaskId: null,
			})),
		} as unknown as ScheduleManager;
		const dialogs: Array<{ title: string; choices: string[] }> = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			showExtensionSelector: vi.fn(async (title: string, choices: string[]) => {
				dialogs.push({ title, choices });
				return undefined;
			}),
		});

		await (mode as unknown as { showScheduleTasks(manager: ScheduleManager): Promise<void> }).showScheduleTasks(
			manager,
		);
		await (mode as unknown as { showScheduleHistory(manager: ScheduleManager): Promise<void> }).showScheduleHistory(
			manager,
		);
		expect(dialogs[0]).toMatchObject({ title: "Scheduled tasks" });
		expect(dialogs[0]!.choices).toHaveLength(2);
		expect(dialogs[0]!.choices[0]).toContain("Active");
		expect(dialogs[1]).toMatchObject({ title: "Execution history" });
		expect(dialogs[1]!.choices).toHaveLength(2);
		expect(dialogs[1]!.choices[0]).toContain("Succeeded");
		expect(manager.list).toHaveBeenNthCalledWith(2, { afterTaskId: undefined, limit: 50, withRunsOnly: true });
		for (const dialog of dialogs)
			expect(dialog.choices).not.toEqual(expect.arrayContaining(["Close", "Back", "Cancel"]));
	});

	it("renders internal run reasons as user-facing English", async () => {
		const run: ScheduleRun = {
			id: "run-overlap",
			taskId: TASK_ID,
			sequence: 1,
			trigger: "scheduled",
			status: "skipped",
			scheduledFor: "2026-08-03T01:30:00.000Z",
			createdAt: "2026-08-03T01:30:00.000Z",
			completedAt: "2026-08-03T01:30:00.000Z",
			reason: "overlap",
			unread: false,
			snapshot: {
				name: "Submit report",
				model: { provider: "openai", modelId: "gpt-test" },
				instruction: "Submit report",
				schedule: task().schedule,
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "fixed", cwd: "/project" },
			},
		};
		let dialog = "";
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			showExtensionSelector: vi.fn(async (title: string) => {
				dialog = title;
				return undefined;
			}),
		});

		await (
			mode as unknown as {
				showScheduleRun(manager: ScheduleManager, task: ScheduleTask, run: ScheduleRun): Promise<void>;
			}
		).showScheduleRun({ agentDir: "/tmp/unused" } as ScheduleManager, task(), run);
		expect(dialog).toContain("Another execution was already running");
		expect(dialog).not.toContain("overlap");
	});

	it("keeps execution rows selectable when run IDs share a prefix", async () => {
		const firstRun: ScheduleRun = {
			id: "run-prefix-0001",
			taskId: TASK_ID,
			sequence: 1,
			trigger: "scheduled",
			status: "succeeded",
			scheduledFor: "2026-08-03T01:30:00.000Z",
			createdAt: "2026-08-03T01:30:00.000Z",
			completedAt: "2026-08-03T01:31:00.000Z",
			resultPreview: "Submitted",
			unread: false,
			snapshot: {
				name: "Submit report",
				model: { provider: "openai", modelId: "gpt-test" },
				instruction: task().instruction,
				schedule: task().schedule,
				timezone: task().timezone,
				target: task().target,
			},
		};
		const manager = {
			listRuns: vi.fn(async () => ({
				runs: [firstRun, { ...firstRun, id: "run-prefix-0002", sequence: 2 }],
				nextBeforeRunId: null,
			})),
		} as unknown as ScheduleManager;
		let choices: string[] = [];
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
		Object.assign(mode, {
			showExtensionSelector: vi.fn(async (_title: string, nextChoices: string[]) => {
				choices = nextChoices;
				return undefined;
			}),
		});

		await (
			mode as unknown as { showScheduleRuns(manager: ScheduleManager, task: ScheduleTask): Promise<void> }
		).showScheduleRuns(manager, task());
		expect(choices).toHaveLength(2);
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
				return undefined;
			}),
		});

		await (
			mode as unknown as { showScheduleTask(manager: ScheduleManager, taskId: string): Promise<void> }
		).showScheduleTask(manager, TASK_ID);
		expect(actions).not.toEqual(expect.arrayContaining(["Edit instructions", "Edit schedule", "Pause", "Resume"]));
		expect(actions).toEqual(expect.arrayContaining(["View execution history", "Run now", "Delete"]));
		expect(actions).not.toContain("Back");
	});

	it("opens scheduled entries as read-only results without switching the active session", async () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-schedule-resume-"));
		try {
			const cwd = join(root, "workspace");
			const sessionDir = join(root, "sessions");
			mkdirSync(cwd);
			const scheduled = SessionManager.create(cwd, sessionDir, {
				id: "scheduled-result",
				mode: "chat",
				scheduled: { taskId: TASK_ID, runId: "run-result" },
			});
			scheduled.appendMessage({ role: "user", content: [{ type: "text", text: "Generate report" }], timestamp: 1 });
			const sessionFile = scheduled.getSessionFile()!;
			scheduled.close();
			const switchSession = vi.fn();
			let dialog = "";
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				runtimeHost: { switchSession },
				clearStatusIndicator: vi.fn(),
				showExtensionSelector: vi.fn(async (title: string) => {
					dialog = title;
					return undefined;
				}),
			});
			await (
				mode as unknown as { handleResumeSession(path: string): Promise<{ cancelled: boolean }> }
			).handleResumeSession(sessionFile);
			expect(dialog).toContain("Scheduled execution");
			expect(dialog).toContain("Generate report");
			expect(switchSession).not.toHaveBeenCalled();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
				resultPreview: "Safe summary",
				unread: false,
				snapshot: {
					name: "Submit report",
					model: { provider: "openai", modelId: "gpt-test" },
					instruction: "Original task instructions",
					schedule: task().schedule,
					timezone: task().timezone,
					target: task().target,
				},
			};
			let dialog = "";
			let choices: string[] = [];
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				showExtensionSelector: vi.fn(async (title: string, nextChoices: string[]) => {
					dialog = title;
					choices = nextChoices;
					return undefined;
				}),
			});

			await (
				mode as unknown as {
					showScheduleRun(manager: ScheduleManager, task: ScheduleTask, run: ScheduleRun): Promise<void>;
				}
			).showScheduleRun({ agentDir: join(root, "agent") } as ScheduleManager, task(), run);
			expect(dialog).toContain("Safe summary");
			expect(dialog).toContain("Task instructions: Original task instructions");
			expect(dialog).toContain("Status: Succeeded");
			expect(dialog).not.toContain("FORGED SECRET");
			expect(choices).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
