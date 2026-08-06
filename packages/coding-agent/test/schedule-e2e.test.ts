import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@arcmind/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createScheduledRunExecutor } from "../src/core/schedules/executor.ts";
import { ScheduleManager } from "../src/core/schedules/manager.ts";
import type { ScheduleRun } from "../src/core/schedules/types.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForRun(manager: ScheduleManager, taskId: string, runId: string): Promise<ScheduleRun> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const run = await manager.getRun(taskId, runId);
		if (["succeeded", "failed", "missed", "skipped", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("scheduled run did not finish");
}

describe.runIf(process.env.ARCMIND_TEST_OS_SANDBOX === "1")("scheduled task end to end", () => {
	it("runs through the real model, sandbox, visible session, inbox, and owned cleanup", async () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-schedule-e2e-"));
		roots.push(root);
		const agentDirPath = join(root, "agent");
		mkdirSync(agentDirPath);
		const agentDir = realpathSync(agentDirPath);
		const grantedDirPath = join(root, "granted");
		mkdirSync(grantedDirPath);
		const grantedDir = realpathSync(grantedDirPath);
		const faux = registerFauxProvider();
		vi.spyOn(ModelRegistry.prototype, "streamSimple").mockImplementation((model, context, options) =>
			faux.streamSimple(model, context, options),
		);
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bash", {
					command: `printf scheduled-ok > result.txt; printf granted-ok > ${JSON.stringify(join(grantedDir, "granted.txt"))}`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("定时任务执行完成"),
		]);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					faux: {
						api: faux.api,
						baseUrl: faux.getModel().baseUrl,
						models: [{ id: faux.getModel().id }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: faux.getModel().provider, defaultModel: faux.getModel().id }),
		);
		AuthStorage.create(join(agentDir, "auth.json")).set(faux.getModel().provider, {
			type: "api_key",
			key: "faux-key",
		});

		const manager = ScheduleManager.create({
			agentDir,
			execute: createScheduledRunExecutor({ agentDir }),
		});
		try {
			await manager.start();
			const task = await manager.create({
				id: "schedule-e2e-task",
				name: "Schedule E2E task",
				instruction: "在工作目录生成 result.txt",
				model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "task", additionalWorkspaceCwd: grantedDir },
			});
			const queued = await manager.runNow(task.id, "schedule-e2e-run");
			const run = await waitForRun(manager, task.id, queued.id);

			expect(run).toMatchObject({ status: "succeeded", unread: true, resultPreview: "定时任务执行完成" });
			expect(existsSync(join(task.target.cwd, "result.txt"))).toBe(true);
			expect(existsSync(join(grantedDir, "granted.txt"))).toBe(true);
			const normalRoot = getDefaultSessionDir(task.target.cwd, agentDir);
			expect(relative(normalRoot, run.sessionFile!).startsWith(`..${sep}`)).toBe(false);
			const visible = SessionManager.openReadOnly(run.sessionFile!);
			expect(visible.getHeader()?.scheduled).toEqual({ taskId: task.id, runId: run.id });
			expect(JSON.stringify(visible.getBranch())).toContain("定时任务执行完成");
			expect((await SessionManager.list(task.target.cwd, normalRoot)).map(({ id }) => id)).toContain(run.sessionId);
			expect((await manager.markRunRead(task.id, run.id)).unread).toBe(false);

			const sessionFile = run.sessionFile!;
			const workspace = task.target.cwd;
			await manager.delete(task.id, { deleteSessions: false });
			expect(existsSync(sessionFile)).toBe(true);
			expect(existsSync(workspace)).toBe(false);
			expect(existsSync(join(grantedDir, "granted.txt"))).toBe(true);
			await expect(manager.get(task.id)).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
		} finally {
			await manager.stop();
			faux.unregister();
		}
	});
});
