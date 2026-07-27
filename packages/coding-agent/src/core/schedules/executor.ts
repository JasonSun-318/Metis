import { lstatSync, realpathSync } from "node:fs";
import { createAgentSessionFromServices, createAgentSessionServices } from "../agent-session-services.ts";
import { createSessionId } from "../session-id.ts";
import { SessionManager } from "../session-manager.ts";
import { createUnattendedExecutionProfile, UNATTENDED_TOOL_NAMES } from "../unattended-execution.ts";
import { createWorkspaceSandbox, WorkspaceSandboxError } from "../workspace-sandbox.ts";
import { ensureScheduleSessionDirectory } from "./paths.ts";
import { ScheduleError, type ScheduleExecutionResult, type ScheduleRunClaim } from "./types.ts";

export const SCHEDULE_EXECUTION_PROMPT =
	"你正在独立执行一个定时任务。请完成下面的任务，并在最终回复中清楚说明执行结果。不要假设你能看到创建任务时的对话。";

function assertWorkspace(cwd: string): string {
	try {
		const metadata = lstatSync(cwd);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a real directory");
		const canonical = realpathSync(cwd);
		if (canonical !== cwd) throw new Error("workspace path is not canonical");
		return canonical;
	} catch (error) {
		throw new ScheduleError("WORKSPACE_MISSING", "Scheduled task workspace is unavailable", { cause: error });
	}
}

export function createScheduledRunExecutor(options: {
	agentDir: string;
}): (claim: ScheduleRunClaim, signal: AbortSignal) => Promise<ScheduleExecutionResult> {
	return async (claim, signal) => {
		if (signal.aborted) throw new Error("aborted");
		const cwd = assertWorkspace(claim.snapshot.target.cwd);
		let sandbox: Awaited<ReturnType<typeof createWorkspaceSandbox>>;
		try {
			sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots: [cwd], signal });
		} catch (error) {
			if (signal.aborted) throw new Error("aborted", { cause: error });
			throw new ScheduleError(
				"SANDBOX_UNAVAILABLE",
				error instanceof WorkspaceSandboxError ? error.message : "Workspace sandbox is unavailable",
				{ cause: error },
			);
		}

		const sessionId = createSessionId();
		const mode = claim.snapshot.target.kind === "project" ? "code" : "chat";
		const cwdOrigin =
			claim.snapshot.target.kind === "general" && claim.snapshot.target.workspace === "task"
				? "managed"
				: "user-selected";
		let sessionManager: SessionManager | undefined;
		let services: Awaited<ReturnType<typeof createAgentSessionServices>> | undefined;
		let created: Awaited<ReturnType<typeof createAgentSessionFromServices>> | undefined;
		let abortListener: (() => void) | undefined;
		let executionResult: ScheduleExecutionResult | undefined;
		let executionError: unknown;
		try {
			sessionManager = SessionManager.create(cwd, ensureScheduleSessionDirectory(options.agentDir, claim.taskId), {
				id: sessionId,
				mode,
				cwdOrigin,
				permissionMode: "ask",
				scheduled: { taskId: claim.taskId, runId: claim.runId },
			});
			services = await createAgentSessionServices({
				cwd,
				agentDir: options.agentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			created = await createAgentSessionFromServices({
				services,
				sessionManager,
				thinkingSelection: undefined,
				tools: [...UNATTENDED_TOOL_NAMES],
				customTools: [],
				additionalSystemPrompt: SCHEDULE_EXECUTION_PROMPT,
				includeAutoMemory: false,
				unattendedExecution: createUnattendedExecutionProfile({
					workspaceRoots: [cwd],
					bashOperations: sandbox.operations,
				}),
			});
			abortListener = () => void created?.session.abort().catch(() => undefined);
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) {
				abortListener();
				throw new Error("aborted");
			}
			await created.session.prompt(claim.snapshot.instruction, {
				expandPromptTemplates: false,
				source: "rpc",
			});
			await created.session.waitForIdle();
			if (signal.aborted) throw new Error("aborted");
			const finalAssistant = [...created.session.messages].reverse().find((message) => message.role === "assistant");
			if (!finalAssistant || finalAssistant.stopReason !== "stop") {
				throw new Error("Scheduled task model execution did not complete successfully");
			}
			const result = created.session.getLastAssistantText();
			if (!result) throw new Error("Scheduled task model execution returned no final text result");
			executionResult = {
				runId: claim.runId,
				sessionId,
				sessionFile: sessionManager.getSessionFile()!,
				result,
			};
		} catch (error) {
			const sessionFile = sessionManager?.getSessionFile();
			executionError = sessionFile
				? new ScheduleError(
						"EXECUTION_FAILED",
						error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "Scheduled task model execution failed",
						{ cause: error, executionSession: { sessionId, sessionFile } },
					)
				: error;
		}

		let cleanupError: unknown;
		if (abortListener) signal.removeEventListener("abort", abortListener);
		if (created) {
			try {
				if (!created.session.isIdle) await created.session.abort().catch(() => undefined);
				created.session.dispose();
			} catch (error) {
				cleanupError = error;
			}
		} else {
			try {
				services?.resourceLoader.dispose?.();
			} catch (error) {
				cleanupError = error;
			}
			try {
				sessionManager?.close();
			} catch (error) {
				cleanupError ??= error;
			}
		}
		try {
			await sandbox.dispose();
		} catch (error) {
			cleanupError ??= error;
		}
		if (executionError) throw executionError;
		if (cleanupError) {
			const sessionFile = sessionManager?.getSessionFile();
			if (!sessionFile) throw cleanupError;
			throw new ScheduleError("EXECUTION_FAILED", "Scheduled task cleanup failed", {
				cause: cleanupError,
				executionSession: { sessionId, sessionFile },
			});
		}
		if (!executionResult) throw new ScheduleError("EXECUTION_FAILED", "Scheduled task produced no result");
		return executionResult;
	};
}
