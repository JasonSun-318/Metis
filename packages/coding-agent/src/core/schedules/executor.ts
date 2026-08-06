import { lstatSync, realpathSync } from "node:fs";
import type { AgentMessage } from "@arcmind/agent-core";
import { createAgentSessionFromServices, createAgentSessionServices } from "../agent-session-services.ts";
import { identifySubmitPromptRequest } from "../runtime-recovery.ts";
import { getDefaultSessionDir, SessionManager, sessionEntryToContextMessages } from "../session-manager.ts";
import { createUnattendedExecutionProfile, UNATTENDED_TOOL_NAMES } from "../unattended-execution.ts";
import { createWorkspaceSandbox, WorkspaceSandboxError } from "../workspace-sandbox.ts";
import { ScheduleError, type ScheduleExecutionResult, type ScheduleRunClaim, scheduleWorkspaceRoots } from "./types.ts";

export const SCHEDULE_EXECUTION_PROMPT =
	"你正在独立执行一个定时任务。请完成下面的任务，并在最终回复中清楚说明执行结果。不要假设你能看到创建任务时的对话。";

type ScheduledDisplayMessage = Extract<AgentMessage, { role: "user" | "assistant" }>;

function messageText(message: ScheduledDisplayMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

/** Read the immutable user instruction and final answer from a scheduled execution journal. */
export function readScheduledSessionView(path: string): { instruction: string; result: string } {
	const session = SessionManager.openReadOnly(path);
	if (!session.getHeader()?.scheduled) throw new Error("Session is not a scheduled execution");
	const messages = session.getBranch().flatMap(sessionEntryToContextMessages);
	return {
		instruction:
			messageText(
				messages.find((message): message is Extract<AgentMessage, { role: "user" }> => message.role === "user"),
			) || "Unavailable",
		result:
			messageText(
				messages
					.filter(
						(message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant",
					)
					.at(-1),
			) || "No result",
	};
}

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
		const workspaceRoots = scheduleWorkspaceRoots(claim.snapshot.target).map(assertWorkspace);
		const cwd = workspaceRoots[0]!;
		let sandbox: Awaited<ReturnType<typeof createWorkspaceSandbox>>;
		try {
			sandbox = await createWorkspaceSandbox({ cwd, workspaceRoots, signal });
		} catch (error) {
			if (signal.aborted) throw new Error("aborted", { cause: error });
			throw new ScheduleError(
				"SANDBOX_UNAVAILABLE",
				error instanceof WorkspaceSandboxError ? error.message : "Workspace sandbox is unavailable",
				{ cause: error },
			);
		}

		const sessionId = claim.sessionId;
		const cwdOrigin = claim.snapshot.target.workspace === "task" ? "managed" : "user-selected";
		let sessionManager: SessionManager | undefined;
		let services: Awaited<ReturnType<typeof createAgentSessionServices>> | undefined;
		let created: Awaited<ReturnType<typeof createAgentSessionFromServices>> | undefined;
		let abortListener: (() => void) | undefined;
		let executionResult: ScheduleExecutionResult | undefined;
		let executionError: unknown;
		try {
			services = await createAgentSessionServices({
				cwd,
				agentDir: options.agentDir,
				resourceLoaderOptions: {
					noExtensions: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const model = services.modelRegistry.find(claim.snapshot.model.provider, claim.snapshot.model.modelId);
			if (!model || !services.modelRegistry.hasConfiguredAuth(model)) {
				throw new ScheduleError(
					"MODEL_UNAVAILABLE",
					`Scheduled task model is unavailable: ${claim.snapshot.model.provider}/${claim.snapshot.model.modelId}`,
				);
			}
			sessionManager = SessionManager.create(cwd, getDefaultSessionDir(cwd, options.agentDir), {
				id: sessionId,
				mode: "chat",
				cwdOrigin,
				permissionMode: "ask",
				scheduled: { taskId: claim.taskId, runId: claim.runId },
			});
			sessionManager.appendSessionInfo(claim.snapshot.name);
			created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model,
				thinkingSelection: undefined,
				tools: [...UNATTENDED_TOOL_NAMES],
				customTools: [],
				additionalSystemPrompt: SCHEDULE_EXECUTION_PROMPT,
				includeAutoMemory: false,
				unattendedExecution: createUnattendedExecutionProfile({
					workspaceRoots,
					bashOperations: sandbox.operations,
				}),
			});
			abortListener = () => void created?.session.abort().catch(() => undefined);
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) {
				abortListener();
				throw new Error("aborted");
			}
			const input = { text: claim.snapshot.instruction };
			const identity = identifySubmitPromptRequest(claim.runId, input);
			created.session.assertCanDrainAgentEventPersistence();
			created.session.assertDurablePromptCapacity(input);
			created.session.prepareDurablePrompt(input);
			sessionManager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: identity.operationId,
				requestId: identity.requestId,
				requestHash: identity.requestHash,
				kind: "turn",
				state: "accepted",
				input,
			});
			created.session.beginDurableDirectTurn(identity, input);
			await created.session.runAcceptedDurablePrompt(identity.turnId, input);
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
