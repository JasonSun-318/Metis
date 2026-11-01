import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@metis/agent-core";
import { getSupportedThinkingLevels, type Model } from "@metis/ai/compat";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionRuntime } from "../agent-session-runtime.ts";
import type { RequestPermissionApproval } from "../permissions/approval.ts";
import {
	intersectPermissionSettings,
	isPermissionPreset,
	type PermissionPreset,
	type PermissionSettings,
	settingsForPreset,
} from "../permissions/settings.ts";
import { QueuedTurnConflictError, QueuedTurnNotFoundError } from "../queued-turn-queue.ts";
import { reduceRuntimeJournal } from "../runtime-recovery.ts";
import type {
	AgentControlPayload,
	AgentInputEntry,
	AgentRunControlEntry,
	AgentStateReason,
} from "../session-control.ts";
import { createSessionId } from "../session-id.ts";
import { type FileEntry, SessionManager } from "../session-manager.ts";
import { captureAgentRoleSnapshot, loadAgentTypeDefinitions, resolveAgentRoleSnapshot } from "./agent-type-registry.ts";
import { decideAgentDelivery, validateAgentSubmission } from "./message-admission.ts";
import { effectiveAgentToolNames, MAX_AGENT_DEPTH, resolveAgentProfile } from "./profiles.ts";
import {
	isManageableQueuedMessage,
	queuedAdmissionRequestId,
	queuedAgentMessages,
	queuedAgentTaskCount,
} from "./queued-messages.ts";
import { defaultSubagentScheduler, type SubagentSchedulerApi } from "./scheduler.ts";
import {
	type AgentDiskRecord,
	AgentStore,
	type AgentStoreApi,
	agentStatusFromTasks,
	summarizeAgentTask,
} from "./store.ts";
import { agentTaskWindow, projectAgentTrace, utf8Length, utf8Prefix } from "./trace.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentConfig,
	type AgentControlInput,
	type AgentControlReceipt,
	type AgentDeleteQueuedMessageInput,
	AgentError,
	type AgentForkTurns,
	type AgentMailboxEvent,
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
	type AgentMessageActor,
	type AgentMessageReceipt,
	type AgentQueuedMessage,
	type AgentRunControl,
	type AgentSendQueuedMessageInput,
	type AgentSubmitMessageInput,
	type AgentSummary,
	type AgentTaskSummary,
	type AgentTombstone,
	type AgentUsage,
	type AgentUsageTotals,
	type DeleteAgentResult,
	type InspectAgentsInput,
	type InspectAgentsResult,
	type InterruptAgentResult,
	MAX_AGENT_INPUT_UTF8_BYTES,
	MAX_AGENT_MAILBOX_DELIVERY_EVENTS,
	MAX_AGENT_MAILBOX_PENDING_EVENTS,
	MAX_AGENT_QUEUED_TASKS,
	MAX_AGENT_TASKS,
	type WaitAgentsInput,
	type WaitAgentsResult,
} from "./types.ts";
import { type AgentWaitHandle, normalizeWaitAgentIds, resolveWaiters, waitAgentsSnapshot } from "./wait.ts";

export interface SpawnAgentInput {
	readonly name: string;
	readonly task: string;
	readonly agentType?: string;
	readonly forkTurns?: AgentForkTurns;
	readonly model?: string;
	readonly permissionPreset?: PermissionPreset;
}

export interface AgentTaskReceipt {
	readonly agentId: string;
	readonly taskId: string;
	readonly status: "queued" | "running";
}

export interface SpawnAgentReceipt extends AgentTaskReceipt {
	readonly name: string;
	readonly agentType: string;
	readonly tools: readonly string[];
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
	readonly mode?: AgentConfig["mode"];
	readonly model?: AgentConfig["model"];
	readonly roleSnapshot?: AgentConfig["roleSnapshot"];
}

export interface ChildRuntimeFactoryInput {
	readonly config: AgentConfig;
	readonly permissionSettingsCeiling: () => PermissionSettings;
	readonly sessionManager: SessionManager;
	readonly onPermissionRequest?: RequestPermissionApproval;
}

export type CreateChildRuntime = (input: ChildRuntimeFactoryInput) => Promise<AgentSessionRuntime>;

export interface SubagentManagerOptions {
	readonly parentSessionManager: SessionManager;
	readonly agentDir: string;
	readonly getWorkspaceRoots: () => readonly string[];
	readonly scheduler?: SubagentSchedulerApi;
	readonly store?: AgentStoreApi;
	readonly createChildRuntime: CreateChildRuntime;
	readonly onPermissionRequest?: RequestPermissionApproval;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export interface SubagentManagerApi {
	attachActor(session: AgentSession): () => void;
	submitMessage(
		actor: AgentMessageActor,
		input: AgentSubmitMessageInput,
		signal?: AbortSignal,
	): Promise<AgentMessageReceipt>;
	listQueuedMessages(actor: AgentMessageActor, agentId: string): readonly AgentQueuedMessage[];
	deleteQueuedMessage(actor: AgentMessageActor, input: AgentDeleteQueuedMessageInput): Promise<void>;
	sendQueuedMessage(actor: AgentMessageActor, input: AgentSendQueuedMessageInput): Promise<AgentMessageReceipt>;
	control(actor: AgentMessageActor, input: AgentControlInput): Promise<AgentControlReceipt>;
	isRunAllowed(agentId: string): boolean;
	hasActiveWork(): boolean;
	getRunControl(agentId: string): AgentRunControl | undefined;
	spawn(actorId: string, input: SpawnAgentInput, signal?: AbortSignal): Promise<SpawnAgentReceipt>;
	inspect(actorId: string, input: InspectAgentsInput): Promise<InspectAgentsResult>;
	sendMessage(
		actorId: string,
		input: { readonly agentId: string; readonly message: string; readonly requestId?: string },
		signal?: AbortSignal,
	): Promise<{ readonly agentId: string; readonly taskId: string; readonly delivery: "accepted" }>;
	followUpTask(
		actorId: string,
		input: { readonly agentId: string; readonly task: string; readonly requestId?: string },
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt>;
	interrupt(actorId: string, agentId: string): Promise<InterruptAgentResult>;
	waitAgents(actorId: string, input: WaitAgentsInput, signal?: AbortSignal): Promise<WaitAgentsResult>;
	setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary>;
	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult>;
	listSummaries(actorId: string, includeArchived?: boolean): readonly AgentSummary[];
	listTasks(agentId: string): readonly AgentTaskSummary[];
	assertCanEnterPlan(actorId: string): void;
	readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]>;
	subscribe(listener: (event: AgentManagerEvent) => void): () => void;
	unload(reason: "parent_unloaded"): Promise<void>;
}

interface HotChild {
	accepting: boolean;
	readonly admissions: Set<Promise<unknown>>;
	readonly runtime: AgentSessionRuntime;
	readonly taskId: string;
	readonly startedAt: number;
	readonly settled: Promise<void>;
	resolveSettled(): void;
	readonly completion: Promise<void>;
	resolveCompletion(): void;
	stopReason?: "interrupted" | "parent_unloaded";
	lifecycleError?: Error;
	unsubscribe(): void;
}

interface StartingChild {
	readonly ready: Promise<void>;
	resolveReady(): void;
}

interface AttachedActor {
	readonly session: AgentSession;
	readonly unsubscribePermissions: () => void;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function selectChildThinkingLevel(
	parentLevel: ThinkingLevel,
	supported: readonly ThinkingLevel[],
): ThinkingLevel | undefined {
	const parentRank = THINKING_LEVELS.indexOf(parentLevel);
	for (let index = parentRank; index >= 0; index -= 1) {
		const level = THINKING_LEVELS[index];
		if (level && supported.includes(level)) return level;
	}
	return undefined;
}

function taskAssistant(
	journal: readonly FileEntry[],
	taskId: string,
): { readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string } | undefined {
	const window = agentTaskWindow(journal, taskId);
	if (!window) return undefined;
	const entry = journal
		.slice(window.start, window.end + 1)
		.reverse()
		.find((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
	return entry?.type === "message"
		? (entry.message as { readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string })
		: undefined;
}

function assistantText(message: { readonly content?: unknown } | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") return utf8Prefix(message.content, 4 * 1024);
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
	return text ? utf8Prefix(text, 4 * 1024) : undefined;
}

function assistantHasToolCalls(message: { readonly content?: unknown } | undefined): boolean {
	return (
		Array.isArray(message?.content) &&
		message.content.some(
			(block) =>
				typeof block === "object" && block !== null && (block as { readonly type?: unknown }).type === "toolCall",
		)
	);
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function isTerminalTaskStatus(status: AgentTaskSummary["status"]): boolean {
	return status === "done" || status === "failed" || status === "stopped";
}

function presetForSettings(settings: PermissionSettings): PermissionPreset {
	for (const preset of ["ask", "auto", "full"] as const) {
		const candidate = settingsForPreset(preset);
		if (candidate.sandboxPolicy === settings.sandboxPolicy && candidate.approvalPolicy === settings.approvalPolicy)
			return preset;
	}
	return "ask";
}

function samePermissionSettings(left: PermissionSettings, right: PermissionSettings): boolean {
	return left.sandboxPolicy === right.sandboxPolicy && left.approvalPolicy === right.approvalPolicy;
}

function terminalMailboxEvent(record: AgentDiskRecord, task: AgentTaskSummary): AgentMailboxTerminalEvent {
	return {
		eventId: `agent:${record.agentId}:${task.taskId}:terminal`,
		taskId: task.taskId,
		agentId: record.agentId,
		parentSessionId: record.config.parentSessionId,
		name: record.name,
		type: "terminal",
		instructionRevision: task.instructionRevision ?? 0,
		consumedInstructionRevision: task.consumedInstructionRevision ?? 0,
		status: task.status as "done" | "failed" | "stopped",
		...(task.finalMessage ? { finalMessage: utf8Prefix(task.finalMessage, 4 * 1024) } : {}),
		...(task.error ? { error: utf8Prefix(task.error, 4 * 1024) } : {}),
		completedAt: task.updatedAt,
	};
}

function taskText(journal: readonly FileEntry[], taskId: string): string {
	const entry = [...journal]
		.reverse()
		.find((candidate) => candidate.type === "agent_task" && candidate.taskId === taskId);
	if (!entry || entry.type !== "agent_task") throw new Error(`Unknown agent task: ${taskId}`);
	return entry.text;
}

export class SubagentManager implements SubagentManagerApi {
	private readonly parentSessionManager: SessionManager;
	private readonly agentDir: string;
	private readonly getWorkspaceRoots: () => readonly string[];
	private readonly scheduler: SubagentSchedulerApi;
	private readonly store: AgentStoreApi;
	private readonly createChildRuntime: CreateChildRuntime;
	private readonly onPermissionRequest?: RequestPermissionApproval;
	private readonly now: () => number;
	private readonly createId: () => string;
	private readonly writers = new Map<string, SessionManager>();
	private readonly hot = new Map<string, HotChild>();
	private readonly starting = new Map<string, StartingChild>();
	private readonly deleting = new Set<string>();
	private readonly actors = new Map<string, AttachedActor>();
	private readonly listeners = new Set<(event: AgentManagerEvent) => void>();
	private readonly waiters = new Set<AgentWaitHandle>();
	private readonly approvalRequests = new Map<string, { readonly taskId: string; readonly toolName: string }>();
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly scheduledRuns = new Map<string, string>();
	private readonly suppressedTasks = new Set<string>();
	private readonly activeTasks = new Map<string, Set<string>>();
	private readonly mailboxContinuations = new Set<string>();
	private readonly attemptedMailboxBatches = new Map<string, Set<string>>();
	private readonly mailboxRetries = new Map<string, { event: AgentMailboxEvent; wake: boolean }>();
	private mailboxRetryTimer?: ReturnType<typeof setTimeout>;
	private readonly childPermissionCeilings = new Map<string, PermissionSettings>();
	private readonly rootSessionId: string;
	private unloaded = false;

	constructor(options: SubagentManagerOptions) {
		this.parentSessionManager = options.parentSessionManager;
		this.rootSessionId = options.parentSessionManager.getSessionId();
		this.agentDir = options.agentDir;
		this.getWorkspaceRoots = options.getWorkspaceRoots;
		this.scheduler = options.scheduler ?? defaultSubagentScheduler;
		this.store = options.store ?? new AgentStore(options.parentSessionManager, options.agentDir);
		this.createChildRuntime = options.createChildRuntime;
		this.onPermissionRequest = options.onPermissionRequest;
		this.now = options.now ?? Date.now;
		this.createId = options.createId ?? createSessionId;
		const records = this.store.listTree().agents;
		for (const record of records) {
			for (const task of record.tasks) this.trackTask(record.agentId, task.taskId, task.status);
		}
		this.recoverInterruptedWork(records);
		const rootCeiling = settingsForPreset(this.parentSessionManager.getPermissionPreset());
		for (const record of [...records].sort(
			(left, right) => left.config.agentPath.length - right.config.agentPath.length,
		)) {
			const inherited = this.childPermissionCeilings.get(record.config.parentSessionId) ?? rootCeiling;
			const own = record.permissionCeiling ?? settingsForPreset(record.config.permissionPreset);
			this.childPermissionCeilings.set(record.agentId, intersectPermissionSettings(own, inherited));
		}
	}

	attachActor(session: AgentSession): () => void {
		// Interrupt rebuilds a child's session before its final disposal. During
		// parent unload, that replacement must not register another actor.
		if (this.unloaded) return () => undefined;
		const sessionId = session.sessionManager.getSessionId();
		if (this.actors.has(sessionId)) {
			throw new Error(`Agent actor is already attached: ${sessionId}`);
		}
		const attached: AttachedActor = {
			session,
			unsubscribePermissions: session.sessionManager.subscribePermissionPreset((next) => {
				this.narrowDescendantsTo(sessionId, next);
			}),
		};
		this.actors.set(sessionId, attached);
		if (
			sessionId === this.rootSessionId ||
			this.store.listTree().agents.some((record) => record.agentId === sessionId)
		) {
			this.narrowDescendantsTo(sessionId, session.sessionManager.getPermissionPreset());
		}
		this.recoverMailboxEvents(session);
		return () => {
			const current = this.actors.get(sessionId);
			if (current === attached) {
				current.unsubscribePermissions();
				this.actors.delete(sessionId);
			}
		};
	}

	async spawn(actorId: string, input: SpawnAgentInput, signal?: AbortSignal): Promise<SpawnAgentReceipt> {
		signal?.throwIfAborted();
		this.assertActive();
		const actor = this.requireActor(actorId);
		this.assertRunAllowed(actorId);
		if (
			!input.name ||
			input.name.trim() !== input.name ||
			input.name.length > 128 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(input.name)
		) {
			throw new AgentError(
				"INVALID_INPUT",
				"Agent name must be 1-128 trimmed characters with no control characters",
			);
		}
		if (actorId !== this.rootSessionId) this.assertOperable(actorId);
		const summary = summarizeAgentTask(input.task);
		if (!summary || utf8Length(input.task) > MAX_AGENT_INPUT_UTF8_BYTES) {
			throw new AgentError("INVALID_INPUT", "Agent task must be non-empty and at most 64 KiB");
		}
		if (
			input.forkTurns !== undefined &&
			input.forkTurns !== "all" &&
			(!Number.isInteger(input.forkTurns) || input.forkTurns < 1 || input.forkTurns > 1_000)
		) {
			throw new AgentError("INVALID_INPUT", 'Agent forkTurns must be "all" or an integer from 1 through 1000');
		}
		const tree = this.store.listTree();
		if (tree.diagnostics.length > 0) {
			throw new AgentError("INVALID_STATE", "Cannot create an agent while an existing child session is unreadable");
		}
		if (queuedAgentTaskCount(tree.agents) >= MAX_AGENT_QUEUED_TASKS) {
			throw new AgentError("QUEUE_FULL", `Agent task queue is limited to ${MAX_AGENT_QUEUED_TASKS} tasks`);
		}
		const actorPath = this.actorPath(actorId);
		const depth = actorPath.length + 1;
		if (depth > MAX_AGENT_DEPTH) {
			throw new AgentError("DEPTH_LIMIT", `Agent depth cannot exceed ${MAX_AGENT_DEPTH}`);
		}
		const names = new Set(tree.agents.map((candidate) => candidate.name));
		for (const tombstone of this.store.listTombstones()) names.add(tombstone.name);
		if (names.has(input.name))
			throw new AgentError("INVALID_INPUT", `Agent name has already been used: ${input.name}`);
		const agentType = input.agentType ?? "default";
		const definition = loadAgentTypeDefinitions(this.agentDir)[agentType];
		if (!definition)
			throw new AgentError(
				"INVALID_INPUT",
				`Unknown agent type: ${agentType}. Available types: ${Object.keys(loadAgentTypeDefinitions(this.agentDir)).join(", ")}`,
			);
		const inheritedWriteDenied =
			actor.sessionManager.getCollaborationMode() === "plan" ||
			actor.sessionManager.getHeader()?.agent?.writePolicy === "deny";
		const profile = resolveAgentProfile({
			definition,
			parentTools: actor.getDelegatableToolNames(inheritedWriteDenied ? "deny" : "inherit"),
			depth,
		});
		const parentPreset = actor.sessionManager.getPermissionPreset();
		const requestedPreset = input.permissionPreset ?? parentPreset;
		if (!isPermissionPreset(requestedPreset)) throw new AgentError("INVALID_INPUT", "Invalid permission preset");
		const model = this.resolveModel(actor, input.model);
		const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
		const thinkingLevel = selectChildThinkingLevel(actor.thinkingLevel, levels);
		if (!thinkingLevel) throw new AgentError("MODEL_UNAVAILABLE", "Child model has no supported thinking level");
		const cwd = this.resolveCwd(actor.sessionManager.getCwd());
		const agentId = this.createId();
		const taskId = this.createId();
		const config: AgentConfig = {
			mode: actor.mode,
			roleSnapshot: captureAgentRoleSnapshot(agentType, definition),
			agentId,
			name: input.name,
			agentType,
			initialTask: input.task,
			tools: [...profile.tools],
			writePolicy: inheritedWriteDenied ? "deny" : profile.writePolicy,
			permissionPreset: requestedPreset,
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel,
			cwd,
			forkTurns: input.forkTurns ?? 0,
			timeoutSeconds: 1_800,
			mayDelegate: profile.mayDelegate,
			parentSessionId: actorId,
			rootSessionId: this.rootSessionId,
			agentPath: [...actorPath, agentId],
		};
		const initialRequestId = `initial-${taskId}`;
		const origin = { kind: "agent" as const, sessionId: actorId };
		const initial = validateAgentSubmission(origin, {
			agentId,
			requestId: initialRequestId,
			delivery: "queue",
			input: { text: input.task },
		});
		const permissionCeiling = intersectPermissionSettings(
			this.actorCeiling(actorId, parentPreset),
			settingsForPreset(requestedPreset),
		);
		this.store.create(
			config,
			actor.messages,
			taskId,
			{
				type: "agent_input",
				agentId,
				taskId,
				messageId: this.createId(),
				requestId: initialRequestId,
				requestHash: initial.requestHash,
				delivery: "start",
				state: "queued",
				instructionRevision: 1,
				input: initial.input,
				origin,
			},
			presetForSettings(permissionCeiling),
		);
		this.trackTask(agentId, taskId, "queued");
		this.childPermissionCeilings.set(agentId, permissionCeiling);
		const status = this.scheduleNext(agentId) ?? "queued";
		this.emitUpdate(this.buildSummary(this.store.load(agentId)));
		return {
			agentId,
			taskId,
			status,
			name: config.name,
			agentType: config.agentType,
			tools: effectiveAgentToolNames(config),
			writePolicy: config.writePolicy,
			mayDelegate: config.mayDelegate,
			mode: config.mode,
			model: config.model,
			roleSnapshot: config.roleSnapshot,
		};
	}

	async inspect(actorId: string, input: InspectAgentsInput): Promise<InspectAgentsResult> {
		if (input.messageId) {
			if (!input.agentId || input.taskId || input.beforeEventId)
				throw new AgentError(
					"INVALID_INPUT",
					"Reading a message requires agentId and cannot combine trace cursors",
				);
			this.assertDescendant(actorId, input.agentId);
			const entry = this.inputs(input.agentId).find((item) => item.messageId === input.messageId);
			if (!entry) throw new AgentError("UNKNOWN_TASK", "Unknown agent input message");
			const offset = input.textOffset ?? 0;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.input.text.length)
				throw new AgentError("INVALID_INPUT", "Invalid message text offset");
			const text = utf8Prefix(entry.input.text.slice(offset), 16 * 1024);
			const next = offset + text.length;
			return {
				kind: "message",
				agentId: input.agentId,
				taskId: entry.taskId,
				messageId: entry.messageId,
				origin: entry.origin,
				text,
				imageCount: entry.input.images?.length ?? 0,
				state: entry.state,
				instructionRevision: entry.instructionRevision,
				...(next < entry.input.text.length ? { nextTextOffset: next } : {}),
			};
		}
		if (input.textOffset !== undefined) throw new AgentError("INVALID_INPUT", "textOffset requires messageId");
		const limit = input.limit ?? 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new AgentError("INVALID_INPUT", "Inspect limit must be from 1 through 100");
		}
		if (!input.agentId) {
			if (input.taskId || input.beforeEventId) {
				throw new AgentError("INVALID_INPUT", "inspect_agents requires agentId with taskId or beforeEventId");
			}
			const summaries = this.listSummaries(actorId);
			return {
				kind: "list",
				agents: summaries.slice(0, limit),
				usage: this.aggregateUsage(summaries),
			};
		}
		const record = this.assertDescendant(actorId, input.agentId);
		const summary = this.buildSummary(record);
		const taskId = input.taskId ?? summary.currentTask?.taskId ?? summary.latestTask?.taskId;
		if (!taskId) throw new AgentError("UNKNOWN_TASK", `Agent has no tasks: ${input.agentId}`);
		if (input.taskId && !this.store.listTasks(input.agentId).some((task) => task.taskId === input.taskId)) {
			throw new AgentError("UNKNOWN_TASK", `Unknown agent task: ${input.taskId}`);
		}
		const trace = projectAgentTrace({
			journal: this.store.readJournal(input.agentId, record),
			taskId,
			beforeEventId: input.beforeEventId,
			limit,
		});
		return { kind: "trace", agent: summary, taskId, ...trace };
	}

	async sendMessage(
		actorId: string,
		input: { readonly agentId: string; readonly message: string; readonly requestId?: string },
		signal?: AbortSignal,
	): Promise<{ readonly agentId: string; readonly taskId: string; readonly delivery: "accepted" }> {
		const receipt = await this.submitMessage(
			{ kind: "agent", sessionId: actorId },
			{
				agentId: input.agentId,
				requestId: input.requestId ?? this.requestId("message", input.agentId),
				delivery: "steer",
				input: { text: input.message },
			},
			signal,
		);
		return { agentId: receipt.agentId, taskId: receipt.taskId, delivery: "accepted" };
	}

	async followUpTask(
		actorId: string,
		input: { readonly agentId: string; readonly task: string; readonly requestId?: string },
		signal?: AbortSignal,
	): Promise<AgentTaskReceipt> {
		const receipt = await this.submitMessage(
			{ kind: "agent", sessionId: actorId },
			{
				agentId: input.agentId,
				requestId: input.requestId ?? this.requestId("followup", input.agentId),
				delivery: "queue",
				input: { text: input.task },
			},
			signal,
		);
		return {
			agentId: receipt.agentId,
			taskId: receipt.taskId,
			status:
				this.store.listTasks(receipt.agentId).find((task) => task.taskId === receipt.taskId)?.status === "running"
					? "running"
					: "queued",
		};
	}

	submitMessage(
		actor: AgentMessageActor,
		submission: AgentSubmitMessageInput,
		signal?: AbortSignal,
	): Promise<AgentMessageReceipt> {
		return this.serialize(submission.agentId, async () => {
			signal?.throwIfAborted();
			this.assertActive();
			const record = this.assertMessageActor(actor, submission.agentId);
			if (this.deleting.has(submission.agentId)) {
				throw new AgentError("INVALID_STATE", `Agent is deleting: ${submission.agentId}`);
			}
			const { input, requestHash } = validateAgentSubmission(actor, submission);
			const previous = record.inputs.find((entry) => entry.requestId === submission.requestId);
			if (previous) {
				if (previous.requestHash !== requestHash)
					throw new AgentError("REQUEST_ID_CONFLICT", "The request ID already belongs to different input");
				if (previous.delivery !== "steer" && (previous.state === "accepted" || previous.state === "queued")) {
					this.assertRunAllowed(
						submission.agentId,
						actor.kind === "user" || record.runControl?.state === "interrupted",
						record,
					);
					this.assertOperable(submission.agentId);
					const tree = this.store.listTree().agents;
					if (tree.some((item) => item.archived && record.config.agentPath.includes(item.agentId)))
						throw new AgentError("INVALID_STATE", "Archived agents must be unarchived before follow-up tasks");
					if (
						actor.kind === "agent" &&
						this.requireActor(actor.sessionId).sessionManager.getCollaborationMode() === "plan" &&
						record.config.writePolicy !== "deny"
					)
						throw new AgentError("INVALID_STATE", "Writable agents cannot receive follow-up tasks in Plan mode");
					if (!record.tasks.some((task) => task.taskId === previous.taskId)) {
						if (record.tasks.length >= MAX_AGENT_TASKS || queuedAgentTaskCount(tree) >= MAX_AGENT_QUEUED_TASKS)
							throw new AgentError("QUEUE_FULL", "Agent task queue or history is full");
						const text = previous.input.text || "Image input";
						this.appendControl(
							submission.agentId,
							{
								type: "agent_task",
								agentId: submission.agentId,
								taskId: previous.taskId,
								text,
								taskSummary: summarizeAgentTask(text),
								status: "queued",
							},
							record,
						);
						this.trackTask(submission.agentId, previous.taskId, "queued");
					}
					this.resumeForAdmittedInput(record, actor, submission.requestId);
					this.scheduleNext(submission.agentId, this.store.reload(record));
				}
				this.publishIntervention(record, previous);
				return this.messageReceipt(previous);
			}
			const targetControl = record.runControl;
			this.assertRunAllowed(
				submission.agentId,
				actor.kind === "user" || targetControl?.state === "interrupted",
				record,
			);
			const actorSession = actor.kind === "agent" ? this.requireActor(actor.sessionId) : undefined;
			if (actorSession?.sessionManager.getCollaborationMode() === "plan" && record.config.writePolicy !== "deny")
				throw new AgentError("INVALID_STATE", "Writable agents cannot receive follow-up tasks in Plan mode");
			const tree = this.store.listTree().agents;
			if (tree.some((item) => item.archived && record.config.agentPath.includes(item.agentId)))
				throw new AgentError("INVALID_STATE", "Archived agents must be unarchived before follow-up tasks");
			const hot = this.hot.get(submission.agentId);
			const delivery = decideAgentDelivery(
				!!hot?.accepting || this.starting.has(submission.agentId),
				submission.delivery ?? "auto",
			);
			if (delivery === "reject") throw new AgentError("INVALID_STATE", "send_message requires a running agent task");
			const tasks = record.tasks;
			if (
				delivery !== "steer" &&
				(tasks.length >= MAX_AGENT_TASKS || queuedAgentTaskCount(tree) >= MAX_AGENT_QUEUED_TASKS)
			)
				throw new AgentError("QUEUE_FULL", "Agent task queue or history is full");
			if (input.images?.length)
				this.withWriter(
					submission.agentId,
					(writer) => {
						const source =
							actor.kind === "user"
								? this.parentSessionManager
								: this.requireActor(actor.sessionId).sessionManager;
						writer.importDurableImageRefs(source, input.images!);
					},
					record,
				);

			const taskId = delivery === "steer" ? hot!.taskId : this.createId();
			const revision =
				Math.max(
					0,
					...record.inputs.filter((entry) => entry.taskId === taskId).map((entry) => entry.instructionRevision),
				) + 1;
			const payload: Omit<AgentInputEntry, "id" | "parentId" | "timestamp"> = {
				type: "agent_input",
				agentId: submission.agentId,
				taskId,
				messageId: this.createId(),
				requestId: submission.requestId,
				requestHash,
				delivery,
				state: "accepted",
				instructionRevision: revision,
				input,
				origin: actor,
			};
			this.appendControl(submission.agentId, payload, record);
			if (delivery !== "steer") {
				this.appendControl(
					submission.agentId,
					{
						type: "agent_task",
						agentId: submission.agentId,
						taskId,
						text: input.text || "Image input",
						taskSummary: summarizeAgentTask(input.text || "Image input"),
						status: "queued",
					},
					record,
				);
				this.trackTask(submission.agentId, taskId, "queued");
				this.appendControl(submission.agentId, { ...payload, state: "queued" }, record);
			} else {
				try {
					const admission = hot!.runtime.submitPrompt({
						requestId: payload.messageId,
						...input,
						streamingBehavior: "steer",
					});
					hot!.admissions.add(admission);
					try {
						await admission;
					} finally {
						hot!.admissions.delete(admission);
					}
				} catch (error) {
					this.appendControl(
						submission.agentId,
						{
							...payload,
							state: "failed",
							error: utf8Prefix(error instanceof Error ? error.message : String(error), 4096),
						},
						record,
					);
					this.publishIntervention(
						record,
						this.inputsForRecord(record).find((entry) => entry.messageId === payload.messageId)!,
					);
					throw error;
				}
			}
			this.resumeForAdmittedInput(record, actor, submission.requestId);
			const accepted = this.inputsForRecord(record).find((entry) => entry.messageId === payload.messageId)!;
			this.publishIntervention(record, accepted);
			const updated = this.store.reload(record);
			if (delivery !== "steer") this.scheduleNext(submission.agentId, updated);
			this.emitUpdate(this.buildSummary(updated));
			return this.messageReceipt(accepted);
		});
	}

	listQueuedMessages(actor: AgentMessageActor, agentId: string): readonly AgentQueuedMessage[] {
		this.assertActive();
		const record = this.assertMessageActor(actor, agentId);
		return queuedAgentMessages({
			inputs: this.inputsForRecord(record),
			tasks: record.tasks,
			archived: record.archived,
			...(record.runControl ? { runControl: record.runControl } : {}),
		});
	}

	deleteQueuedMessage(actor: AgentMessageActor, input: AgentDeleteQueuedMessageInput): Promise<void> {
		return this.serialize(input.agentId, async () => {
			this.assertActive();
			const record = this.assertMessageActor(actor, input.agentId);
			if (actor.kind !== "user" || record.archived)
				throw new AgentError("INVALID_STATE", "Only human input can manage an active agent queue");
			this.assertQueueMutationInput(input);
			const current = this.requireQueuedMessage(record, input.messageId, input.expectedRevision);
			const task = record.tasks.find((candidate) => candidate.taskId === current.taskId);
			if (!isManageableQueuedMessage(current, task)) {
				throw new QueuedTurnConflictError(input.messageId);
			}
			const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = current;
			this.appendControl(input.agentId, { ...payload, state: "cancelled", error: "Queued message deleted" }, record);
			if (this.scheduledRuns.get(input.agentId) === current.taskId) this.cancelScheduled(input.agentId);
			if (task?.status === "queued") {
				this.appendTaskState(
					input.agentId,
					{ taskId: task.taskId, status: "stopped", reason: "interrupted" },
					record,
				);
			}
			this.publishIntervention(
				record,
				this.inputsForRecord(record).find((entry) => entry.messageId === current.messageId)!,
			);
			this.emitUpdate(this.buildSummary(this.store.reload(record)));
			this.scheduleNext(input.agentId);
		});
	}

	sendQueuedMessage(actor: AgentMessageActor, input: AgentSendQueuedMessageInput): Promise<AgentMessageReceipt> {
		return this.serialize(input.agentId, async () => {
			this.assertActive();
			const record = this.assertMessageActor(actor, input.agentId);
			if (actor.kind !== "user") throw new AgentError("INVALID_STATE", "Only humans can manage queued messages");
			this.assertQueueMutationInput(input);
			if (input.delivery !== "steer" && input.delivery !== "start") {
				throw new AgentError("INVALID_INPUT", "Invalid queued message delivery");
			}
			const current = this.requireQueuedMessage(record, input.messageId, input.expectedRevision);
			const task = record.tasks.find((candidate) => candidate.taskId === current.taskId);
			if (!isManageableQueuedMessage(current, task) || this.deleting.has(input.agentId) || record.archived) {
				throw new QueuedTurnConflictError(input.messageId);
			}
			this.assertRunAllowed(input.agentId, true, record);
			if (input.delivery === "start" && queuedAgentMessages(record)[0]?.messageId !== current.messageId)
				throw new QueuedTurnConflictError(input.messageId);
			const hot = this.hot.get(input.agentId);
			const accepting = hot?.accepting === true && hot.runtime.session.isStreaming !== false;
			if (
				(input.delivery === "steer" && !accepting) ||
				(input.delivery === "start" &&
					(hot !== undefined || (task!.status !== "queued" && task!.status !== "stopped")))
			) {
				throw new AgentError("INVALID_STATE", "Queued message delivery does not match the current task");
			}
			const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = current;
			// A guided steer lands on the hot task, so its revision must advance the
			// target task's sequence instead of reusing the queued task's numbering.
			const instructionRevision =
				input.delivery === "steer"
					? Math.max(
							0,
							...record.inputs
								.filter((entry) => entry.taskId === hot!.taskId)
								.map((entry) => entry.instructionRevision),
						) + 1
					: payload.instructionRevision;
			const sending: Omit<AgentInputEntry, "id" | "parentId" | "timestamp"> = {
				...payload,
				taskId: input.delivery === "steer" ? hot!.taskId : payload.taskId,
				delivery: input.delivery === "steer" ? "steer" : payload.delivery,
				state: "accepted",
				instructionRevision,
			};
			this.appendControl(input.agentId, sending, record);
			if (input.delivery === "steer") {
				this.suppressedTasks.add(current.taskId);
				const cancelled = this.cancelScheduled(input.agentId);
				try {
					await this.admitSteerUnlocked(hot!, current, queuedAdmissionRequestId(current.messageId, current.id));
				} catch (error) {
					this.suppressedTasks.delete(current.taskId);
					this.appendControl(input.agentId, payload, record);
					if (cancelled) this.scheduleNext(input.agentId, this.store.reload(record));
					this.publishIntervention(
						record,
						this.inputsForRecord(record).find((entry) => entry.messageId === current.messageId)!,
					);
					this.emitUpdate(this.buildSummary(this.store.reload(record)));
					throw error;
				}
				this.appendTaskState(
					input.agentId,
					{ taskId: current.taskId, status: "stopped", reason: "interrupted" },
					record,
				);
				this.suppressedTasks.delete(current.taskId);
				const delivered = this.inputsForRecord(record).find((entry) => entry.messageId === current.messageId);
				if (
					!delivered ||
					delivered.taskId !== hot!.taskId ||
					delivered.delivery !== "steer" ||
					delivered.requestId !== current.requestId ||
					delivered.requestHash !== current.requestHash
				) {
					throw new Error("Guided message receipt was not retained");
				}
				this.publishIntervention(record, delivered);
				this.emitUpdate(this.buildSummary(this.store.reload(record)));
				return this.messageReceipt(delivered);
			}
			this.resumeForAdmittedInput(record, actor, input.requestId);
			const restored = this.inputsForRecord(record).find((entry) => entry.messageId === current.messageId)!;
			this.appendControl(input.agentId, { ...payload, state: "queued" }, record);
			if (task!.status !== "queued") {
				this.appendTaskState(
					input.agentId,
					{ taskId: current.taskId, status: "queued", reason: "recovered" },
					record,
				);
			}
			this.scheduleNext(input.agentId, this.store.reload(record));
			this.publishIntervention(
				record,
				this.inputsForRecord(record).find((entry) => entry.messageId === current.messageId)!,
			);
			this.emitUpdate(this.buildSummary(this.store.reload(record)));
			return this.messageReceipt(restored);
		});
	}

	private assertQueueMutationInput(input: AgentDeleteQueuedMessageInput): void {
		if (!input.requestId || input.requestId.length > 256 || /[\u0000-\u001f]/u.test(input.requestId)) {
			throw new AgentError("INVALID_INPUT", "Invalid queued message request ID");
		}
		if (!input.messageId || !input.expectedRevision) {
			throw new AgentError("INVALID_INPUT", "Queued message identity is required");
		}
	}

	private requireQueuedMessage(record: AgentDiskRecord, messageId: string, expectedRevision: string): AgentInputEntry {
		const current = this.inputsForRecord(record).find((entry) => entry.messageId === messageId);
		if (!current || current.origin.kind !== "user") throw new QueuedTurnNotFoundError(messageId);
		if (current.id !== expectedRevision || (current.state !== "queued" && current.state !== "accepted")) {
			throw new QueuedTurnConflictError(messageId);
		}
		return current;
	}

	private async admitSteerUnlocked(hot: HotChild, input: AgentInputEntry, admissionRequestId: string): Promise<void> {
		const admission = hot.runtime.submitPrompt({
			requestId: admissionRequestId,
			...input.input,
			streamingBehavior: "steer",
		});
		hot.admissions.add(admission);
		try {
			await admission;
		} finally {
			hot.admissions.delete(admission);
		}
	}

	private resumeForAdmittedInput(record: AgentDiskRecord, actor: AgentMessageActor, requestId: string): void {
		if (!record.runControl || record.runControl.state === "enabled") return;
		this.appendControl(
			record.agentId,
			{
				type: "agent_run_control",
				agentId: record.agentId,
				action: "resume",
				state: "enabled",
				scope: "self",
				requestId: `resume-${createHash("sha256").update(requestId).digest("hex")}`,
				origin: actor,
			},
			record,
		);
	}

	async control(actor: AgentMessageActor, input: AgentControlInput): Promise<AgentControlReceipt> {
		this.assertActive();
		if (actor.kind !== "user" && actor.kind !== "agent")
			throw new AgentError("INVALID_INPUT", "Invalid control actor");
		if (!input.requestId || input.requestId.length > 256 || /[\u0000-\u001f]/u.test(input.requestId))
			throw new AgentError("INVALID_INPUT", "Invalid control request ID");
		if (input.action !== "stop" && input.action !== "resume")
			throw new AgentError("INVALID_INPUT", "Invalid control action");
		if (input.scope !== "self" && input.scope !== "subtree")
			throw new AgentError("INVALID_INPUT", "Invalid control scope");
		if (input.agentId !== this.rootSessionId) this.assertMessageActor(actor, input.agentId);
		else if (actor.kind !== "user")
			throw new AgentError("NOT_DESCENDANT", "Agents cannot control their root session");
		if (input.action === "resume" && input.scope !== "self")
			throw new AgentError(
				"INVALID_INPUT",
				"Resume applies to this conversation only; send a new human instruction to resume stopped descendants",
			);
		return this.serialize(input.agentId, async () => {
			const previous = this.journal(input.agentId).find(
				(entry) => entry.type === "agent_run_control" && entry.requestId === input.requestId,
			);
			if (previous?.type === "agent_run_control") {
				if (
					previous.action !== input.action ||
					previous.scope !== input.scope ||
					JSON.stringify(previous.origin) !== JSON.stringify(actor)
				)
					throw new AgentError("REQUEST_ID_CONFLICT", "Control request ID has different content");
				// A retry completes an unfinished control, but must not undo a newer human decision.
				if (this.runControl(input.agentId)?.requestId === previous.requestId) {
					if (previous.action === "stop") await this.applyControlStop(actor, input, previous.state);
					else if (input.agentId !== this.rootSessionId) {
						this.attemptedMailboxBatches.delete(input.agentId);
						this.mailboxContinuations.add(input.agentId);
						this.scheduleNext(input.agentId);
					}
				}
				if (input.agentId !== this.rootSessionId) this.publishControl(this.store.load(input.agentId), previous);
				return {
					agentId: input.agentId,
					state: previous.state,
					scope: previous.scope,
					requestId: previous.requestId,
				};
			}
			if (input.action === "resume")
				this.assertRunAllowed(
					input.agentId,
					actor.kind === "user" || this.runControl(input.agentId)?.state === "interrupted",
				);
			const state = input.action === "resume" ? "enabled" : actor.kind === "user" ? "user_paused" : "interrupted";
			this.appendControl(input.agentId, {
				type: "agent_run_control",
				agentId: input.agentId,
				action: input.action,
				state,
				scope: input.scope,
				requestId: input.requestId,
				origin: actor,
			});
			if (input.action === "stop") await this.applyControlStop(actor, input, state);
			else if (input.agentId !== this.rootSessionId) {
				this.attemptedMailboxBatches.delete(input.agentId);
				this.mailboxContinuations.add(input.agentId);
				this.scheduleNext(input.agentId);
			}
			if (input.agentId !== this.rootSessionId)
				this.publishControl(this.store.load(input.agentId), this.runControl(input.agentId)!);
			return { agentId: input.agentId, state, scope: input.scope, requestId: input.requestId };
		});
	}

	private async applyControlStop(
		actor: AgentMessageActor,
		input: AgentControlInput,
		state: AgentRunControl["state"],
	): Promise<void> {
		const targets = this.store
			.listTree()
			.agents.filter(
				(record) =>
					record.agentId === input.agentId ||
					(input.scope === "subtree" &&
						(input.agentId === this.rootSessionId || record.config.agentPath.includes(input.agentId))),
			);
		for (const record of targets) {
			if (record.agentId === input.agentId) continue;
			const requestId = `${input.requestId}:${record.agentId}`.slice(0, 256);
			const existing = this.journal(record.agentId).some(
				(entry) => entry.type === "agent_run_control" && entry.requestId === requestId,
			);
			if (existing) continue;
			this.appendControl(record.agentId, {
				type: "agent_run_control",
				agentId: record.agentId,
				action: "stop",
				state,
				scope: "self",
				requestId,
				origin: actor,
			});
		}
		for (const record of [...targets].reverse()) {
			if (record.agentId === input.agentId) await this.interruptNow(this.rootSessionId, record.agentId);
			else await this.serialize(record.agentId, () => this.interruptNow(this.rootSessionId, record.agentId));
		}
	}

	getRunControl(agentId: string): AgentRunControl | undefined {
		const control = this.runControl(agentId);
		return control ? { state: control.state, scope: control.scope, requestId: control.requestId } : undefined;
	}

	isRunAllowed(agentId: string, record?: AgentDiskRecord): boolean {
		try {
			this.assertRunAllowed(agentId, false, record);
			return true;
		} catch {
			return false;
		}
	}

	hasActiveWork(): boolean {
		if (this.unloaded) return false;
		return this.hot.size > 0 || this.starting.size > 0 || this.scheduledRuns.size > 0 || this.activeTasks.size > 0;
	}

	private trackTask(agentId: string, taskId: string, status: AgentTaskSummary["status"]): void {
		if (status === "queued" || status === "running") {
			let tasks = this.activeTasks.get(agentId);
			if (!tasks) {
				tasks = new Set();
				this.activeTasks.set(agentId, tasks);
			}
			tasks.add(taskId);
			return;
		}
		const tasks = this.activeTasks.get(agentId);
		if (!tasks) return;
		tasks.delete(taskId);
		if (tasks.size === 0) this.activeTasks.delete(agentId);
	}

	interrupt(actorId: string, agentId: string): Promise<InterruptAgentResult> {
		return this.serialize(agentId, async () => {
			this.assertActive();
			const record = this.assertDescendant(actorId, agentId);
			this.assertOperable(agentId);
			// Fence factory completion and later notifications before awaiting shutdown.
			// Preserve an existing human pause and its subtree scope.
			if (!record.runControl || record.runControl.state === "enabled")
				this.appendControl(
					agentId,
					{
						type: "agent_run_control",
						agentId,
						action: "stop",
						state: "interrupted",
						scope: "self",
						requestId: this.requestId("stop", agentId),
						origin: { kind: "agent", sessionId: actorId },
					},
					record,
				);
			return this.interruptNow(actorId, agentId);
		});
	}

	async waitAgents(actorId: string, input: WaitAgentsInput, signal?: AbortSignal): Promise<WaitAgentsResult> {
		signal?.throwIfAborted();
		this.assertActive();
		this.requireActor(actorId);
		const timeoutMs = input.timeoutMs ?? 30_000;
		if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300_000) {
			throw new AgentError("INVALID_INPUT", "wait_agents timeoutMs must be from 10 through 300000");
		}
		const summaries = this.listSummaries(actorId, true);
		const ids = normalizeWaitAgentIds(input.agentIds);
		for (const id of ids) this.assertDescendant(actorId, id);
		const selected = new Set(ids);
		const immediate = this.waitAgentsSnapshot(actorId, summaries, selected);
		if (immediate) return Promise.resolve(immediate);
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
		}
		const scheduledTaskId = this.scheduledRuns.get(actorId);
		if (scheduledTaskId) this.scheduler.suspend(scheduledTaskId);
		try {
			return await new Promise<WaitAgentsResult>((resolvePromise, rejectPromise) => {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				const onAbort = (): void =>
					waiter.reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
				const waiter: AgentWaitHandle = {
					actorId,
					ids: selected,
					snapshot: () => this.waitAgentsSnapshot(actorId, this.listSummaries(actorId, true), selected),
					resolve: (result) => {
						waiter.dispose();
						resolvePromise(result);
					},
					reject: (error) => {
						waiter.dispose();
						rejectPromise(error);
					},
					dispose: () => {
						this.waiters.delete(waiter);
						if (timeout) clearTimeout(timeout);
						signal?.removeEventListener("abort", onAbort);
					},
				};
				this.waiters.add(waiter);
				signal?.addEventListener("abort", onAbort, { once: true });
				timeout = setTimeout(() => {
					waiter.resolve({
						timedOut: true,
						agents: this.listSummaries(actorId, true).filter((summary) => selected.has(summary.agentId)),
						mailboxEventIds: [],
					});
				}, timeoutMs);
				const afterRegister = this.waitAgentsSnapshot(actorId, this.listSummaries(actorId, true), selected);
				if (afterRegister) waiter.resolve(afterRegister);
			});
		} finally {
			if (scheduledTaskId && !signal?.aborted && this.isRunAllowed(actorId))
				await this.scheduler.resume(scheduledTaskId, signal);
		}
	}

	deleteAgent(actorId: string, agentId: string): Promise<DeleteAgentResult> {
		return this.serialize(agentId, async () => {
			const target = this.assertDescendant(actorId, agentId);
			if (this.deleting.has(agentId)) {
				throw new AgentError("INVALID_STATE", `Agent is already deleting: ${agentId}`);
			}
			const subtree = this.store
				.listTree()
				.agents.filter((record) =>
					target.config.agentPath.every((id, index) => record.config.agentPath[index] === id),
				)
				.sort((left, right) => right.config.agentPath.length - left.config.agentPath.length);
			const overlap = subtree.find((record) => this.deleting.has(record.agentId));
			if (overlap) {
				throw new AgentError("INVALID_STATE", `Agent tree overlaps an active deletion: ${overlap.agentId}`);
			}
			for (const record of subtree) this.deleting.add(record.agentId);
			try {
				for (const record of subtree) {
					await this.interruptNow(actorId, record.agentId, { allowDeleting: true });
				}
				const tombstones = subtree.map(
					(record): AgentTombstone => ({
						agentId: record.agentId,
						name: record.name,
						status: "deleted",
						deletedAt: new Date(this.now()).toISOString(),
					}),
				);
				this.store.beginDeleteGroup(agentId, tombstones);
				const result = await this.store.finishDeleteGroup(agentId);
				for (const deletedId of result.deletedAgentIds) {
					this.childPermissionCeilings.delete(deletedId);
					this.activeTasks.delete(deletedId);
					this.mailboxContinuations.delete(deletedId);
					this.attemptedMailboxBatches.delete(deletedId);
					for (const [id, retry] of this.mailboxRetries)
						if (retry.event.agentId === deletedId || retry.event.parentSessionId === deletedId)
							this.mailboxRetries.delete(id);
				}
				if (result.deletedAgentIds.length > 0) {
					this.emitEvent({ type: "deleted", agentId, deletedAgentIds: result.deletedAgentIds });
				}
				if (result.status !== "deleted") {
					return {
						agentId,
						status: result.status,
						...(result.residualPath ? { residualPath: result.residualPath } : {}),
						error: `Failed to delete agent tree: ${result.error ?? "unknown error"}`,
					};
				}
				return { agentId, status: "deleted" };
			} finally {
				for (const record of subtree) this.deleting.delete(record.agentId);
			}
		});
	}

	setArchived(actorId: string, agentId: string, archived: boolean): Promise<AgentSummary> {
		this.assertDescendant(actorId, agentId);
		return this.serialize(agentId, async () => {
			this.assertOperable(agentId);
			const record = this.store.load(agentId);
			const records = this.store.listTree().agents;
			const archivedIds = new Set(
				records.filter((candidate) => candidate.archived).map((candidate) => candidate.agentId),
			);
			if (!archived && record.config.agentPath.slice(0, -1).some((id) => archivedIds.has(id))) {
				throw new AgentError("INVALID_STATE", "Archived ancestors must be unarchived first");
			}
			const status = agentStatusFromTasks(record.tasks);
			const activeDescendant = records.some(
				(candidate) =>
					candidate.config.agentPath.length > record.config.agentPath.length &&
					record.config.agentPath.every((id, index) => candidate.config.agentPath[index] === id) &&
					["queued", "running"].includes(agentStatusFromTasks(candidate.tasks)),
			);
			if (status === "running" || status === "queued" || activeDescendant) {
				throw new AgentError("INVALID_STATE", "Only terminal agents can be archived");
			}
			this.withWriter(
				agentId,
				(writer) => writer.appendAgentControl({ type: "agent_archived", agentId, archived }),
				record,
			);
			return this.emitUpdate(this.buildSummary(this.store.load(agentId)));
		});
	}

	async readJournal(actorId: string, agentId: string): Promise<readonly FileEntry[]> {
		const record = this.assertDescendant(actorId, agentId);
		return this.store.readJournal(agentId, record);
	}

	listSummaries(actorId: string, includeArchived = false): readonly AgentSummary[] {
		this.requireActor(actorId);
		const actorPath = this.actorPath(actorId);
		const records = this.store.listTree().agents;
		const archivedIds = new Set(records.filter((record) => record.archived).map((record) => record.agentId));
		return records
			.filter((record) => {
				if (!includeArchived && record.config.agentPath.some((id) => archivedIds.has(id))) return false;
				return this.isDescendantPath(actorPath, record.config.agentPath);
			})
			.map((record) => this.buildSummary(record))
			.sort(
				(left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.agentId.localeCompare(left.agentId),
			);
	}

	listTasks(agentId: string): readonly AgentTaskSummary[] {
		this.assertKnown(agentId);
		return this.store.listTasks(agentId);
	}

	assertCanEnterPlan(actorId: string): void {
		this.requireActor(actorId);
		const actorPath = this.actorPath(actorId);
		const writable = this.store
			.listTree()
			.agents.find(
				(record) =>
					this.isDescendantPath(actorPath, record.config.agentPath) &&
					record.config.writePolicy !== "deny" &&
					["queued", "running"].includes(agentStatusFromTasks(record.tasks)),
			);
		if (writable) {
			throw new AgentError("INVALID_STATE", `Stop writable agent ${writable.name} before entering Plan mode`);
		}
	}

	subscribe(listener: (event: AgentManagerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async unload(reason: "parent_unloaded"): Promise<void> {
		if (this.unloaded) return;
		this.unloaded = true;
		if (this.mailboxRetryTimer) clearTimeout(this.mailboxRetryTimer);
		this.mailboxRetries.clear();
		this.mailboxContinuations.clear();
		this.attemptedMailboxBatches.clear();
		for (const waiter of [...this.waiters]) {
			waiter.reject(new AgentError("INVALID_STATE", "Agent manager is unloaded"));
		}
		this.waiters.clear();
		this.approvalRequests.clear();
		for (const actor of this.actors.values()) actor.unsubscribePermissions();
		this.actors.clear();
		const errors: unknown[] = [];
		for (const record of this.store.listTree().agents) {
			try {
				this.cancelScheduled(record.agentId);
				await this.starting.get(record.agentId)?.ready;
				const hot = this.hot.get(record.agentId);
				if (hot) {
					if (hot.accepting) {
						hot.stopReason = reason;
						await hot.runtime.interrupt({ requestId: this.requestId("unload", record.agentId) });
					}
					await hot.completion;
					if (hot.lifecycleError) errors.push(hot.lifecycleError);
				}
				for (const task of this.store.reload(record).tasks) {
					if (task.status !== "queued" && task.status !== "running") continue;
					this.appendTaskState(record.agentId, { taskId: task.taskId, status: "stopped", reason });
				}
				this.cancelPendingInputs(
					record.agentId,
					"Parent unloaded before this input reached a model request",
					record,
					record.inputs.filter((entry) => entry.origin.kind !== "user" || entry.state === "accepted"),
				);
			} catch (error) {
				errors.push(error);
			}
		}
		this.activeTasks.clear();
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to unload agents");
	}

	private scheduleNext(agentId: string, record?: AgentDiskRecord): "queued" | "running" | undefined {
		const current = record?.agentId === agentId ? record : undefined;
		if (this.unloaded || this.deleting.has(agentId) || !this.isRunAllowed(agentId, current)) return undefined;
		if (this.hot.has(agentId) || this.starting.has(agentId)) return undefined;
		const inputs = current ? this.inputsForRecord(current) : this.inputs(agentId);
		const task = (current?.tasks ?? this.store.listTasks(agentId)).find(
			(candidate) =>
				candidate.status === "queued" &&
				!this.suppressedTasks.has(candidate.taskId) &&
				inputs.some(
					(input) =>
						input.taskId === candidate.taskId &&
						input.delivery !== "steer" &&
						(input.state === "queued" || input.state === "accepted"),
				),
		);
		if (task) return this.schedule(agentId, task.taskId);
		if (!this.mailboxContinuations.has(agentId)) return undefined;
		return this.scheduleMailboxContinuation(agentId);
	}

	/** Child continuations use the same scheduler, writer and lifetime as ordinary tasks. */
	private scheduleMailboxContinuation(agentId: string): "queued" | "running" | undefined {
		const record = this.store.load(agentId);
		if (record.archived) return undefined;
		const events = this.pendingMailboxIds(this.journal(agentId)).slice(0, MAX_AGENT_MAILBOX_DELIVERY_EVENTS);
		if (events.length === 0) {
			this.mailboxContinuations.delete(agentId);
			this.attemptedMailboxBatches.delete(agentId);
			return undefined;
		}
		const hash = createHash("sha256").update(JSON.stringify(events)).digest("hex");
		const attempted = this.attemptedMailboxBatches.get(agentId) ?? new Set<string>();
		if (attempted.has(hash)) return undefined;
		if (
			record.tasks.length >= MAX_AGENT_TASKS ||
			queuedAgentTaskCount(this.store.listTree().agents) >= MAX_AGENT_QUEUED_TASKS
		)
			return undefined;
		const taskId = this.createId();
		const text =
			"Process the pending agent notifications and continue your assigned work. Respect the latest human instructions.";
		this.withWriter(
			agentId,
			(writer) => {
				const messageId = this.createId();
				const payload: AgentControlPayload = {
					type: "agent_input",
					agentId,
					taskId,
					messageId,
					requestId: `mailbox-${messageId}`,
					requestHash: hash,
					delivery: "start",
					state: "queued",
					instructionRevision: 1,
					input: { text },
					origin: { kind: "system", eventId: events[0]! },
				};
				writer.appendAgentControl(payload);
				try {
					writer.appendAgentControl({
						type: "agent_task",
						agentId,
						taskId,
						text,
						taskSummary: "Process agent notifications",
						status: "queued",
					});
				} catch (error) {
					writer.appendAgentControl({
						...payload,
						state: "failed",
						error: "Could not admit mailbox continuation",
					});
					throw error;
				}
			},
			record,
		);
		attempted.add(hash);
		this.attemptedMailboxBatches.set(agentId, attempted);
		this.trackTask(agentId, taskId, "queued");
		return this.schedule(agentId, taskId);
	}

	private schedule(agentId: string, taskId: string): "queued" | "running" {
		let readyResolved = false;
		let resolveReadyPromise!: () => void;
		const starting: StartingChild = {
			ready: new Promise<void>((resolvePromise) => {
				resolveReadyPromise = resolvePromise;
			}),
			resolveReady: () => {
				if (readyResolved) return;
				readyResolved = true;
				resolveReadyPromise();
			},
		};
		this.scheduledRuns.set(agentId, taskId);
		this.starting.set(agentId, starting);
		try {
			return this.scheduler.enqueue({
				key: taskId,
				parentSessionId: this.rootSessionId,
				start: async () => {
					try {
						await this.runChild(agentId, taskId, starting);
					} finally {
						if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
					}
				},
			});
		} catch (error) {
			if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			throw error;
		}
	}

	private cancelScheduled(agentId: string): boolean {
		const taskId = this.scheduledRuns.get(agentId);
		if (!taskId || !this.scheduler.cancel(taskId)) return false;
		if (this.scheduledRuns.get(agentId) === taskId) this.scheduledRuns.delete(agentId);
		const starting = this.starting.get(agentId);
		starting?.resolveReady();
		if (starting && this.starting.get(agentId) === starting) this.starting.delete(agentId);
		return true;
	}

	private async runChild(agentId: string, taskId: string, starting: StartingChild): Promise<void> {
		let completedHot: HotChild | undefined;
		try {
			let terminalTask: AgentTaskSummary | undefined;
			try {
				if (this.deleting.has(agentId) || this.unloaded) return;
				terminalTask = await this.runChildLifecycle(agentId, taskId, starting.resolveReady);
			} catch (error) {
				if (!this.deleting.has(agentId)) {
					try {
						const errorText = error instanceof Error ? error.message : String(error);
						this.appendTaskState(agentId, {
							taskId,
							status: "failed",
							reason: "error",
							error: utf8Prefix(errorText, 64 * 1024),
						});
						terminalTask = this.store.listTasks(agentId).find((task) => task.taskId === taskId);
					} catch {
						// The child journal itself is unavailable; store diagnostics retain the failure.
					}
				}
			}
			if (terminalTask && isTerminalTaskStatus(terminalTask.status)) {
				completedHot = this.hot.get(agentId);
				this.hot.delete(agentId);
				this.publishTerminal(this.store.load(agentId), terminalTask);
			}
		} finally {
			const hot = completedHot ?? this.hot.get(agentId);
			this.hot.delete(agentId);
			hot?.resolveCompletion();
			starting.resolveReady();
			if (this.starting.get(agentId) === starting) this.starting.delete(agentId);
			this.scheduleNext(agentId);
			for (const pendingId of this.mailboxContinuations) {
				if (pendingId !== agentId) this.scheduleNext(pendingId);
			}
		}
	}

	private async runChildLifecycle(
		agentId: string,
		taskId: string,
		markReady: () => void,
	): Promise<AgentTaskSummary | undefined> {
		const record = this.store.load(agentId);
		const task = record.tasks.find((candidate) => candidate.taskId === taskId);
		if (!task || task.status !== "queued" || this.suppressedTasks.has(taskId)) return undefined;
		const originalInputs = this.store
			.readJournal(agentId, record)
			.filter((entry) => entry.type === "agent_input" && entry.taskId === taskId);
		if (
			originalInputs.length > 0 &&
			!record.inputs.some(
				(entry) =>
					entry.taskId === taskId &&
					entry.delivery !== "steer" &&
					(entry.state === "queued" || entry.state === "accepted"),
			)
		)
			return undefined;
		let config = record.config;
		const childManager = SessionManager.open(record.path);
		this.writers.set(agentId, childManager);
		if (!config.roleSnapshot) {
			const roleSnapshot = resolveAgentRoleSnapshot(config.agentType, { agentDir: this.agentDir });
			childManager.appendAgentControl({ type: "agent_role_snapshot", agentId, roleSnapshot });
			config = { ...config, roleSnapshot };
		}
		let runtime: AgentSessionRuntime | undefined;
		try {
			const onPermissionRequest: RequestPermissionApproval = async (request) => {
				const summary = this.buildSummary(this.store.load(agentId));
				this.approvalRequests.set(config.agentId, { taskId, toolName: request.action.toolName });
				this.emitApprovalRequired(summary, taskId, request.action.toolName);
				this.notifyApprovalWaiters(config.agentId);
				try {
					if (!this.onPermissionRequest) {
						throw new Error("No interactive parent session owner is available");
					}
					return await this.onPermissionRequest({
						...request,
						actor: {
							type: "agent",
							id: config.agentId,
							name: config.name,
							taskId,
						},
					});
				} finally {
					this.approvalRequests.delete(config.agentId);
				}
			};
			runtime = await this.createChildRuntime({
				config,
				permissionSettingsCeiling: () => this.childPermissionCeilings.get(agentId) ?? settingsForPreset("ask"),
				sessionManager: childManager,
				onPermissionRequest,
			});
			if (this.unloaded || this.deleting.has(agentId) || !this.isRunAllowed(agentId)) {
				await runtime.dispose();
				runtime = undefined;
				this.writers.delete(agentId);
				return this.store.listTasks(agentId).find((task) => task.taskId === taskId);
			}
			this.persistRuntimeCeiling(runtime, agentId);
			const configuredTools = new Set([...config.tools, ...(config.mayDelegate ? AGENT_TOOL_NAMES : [])]);
			const activeTools = runtime.session.getActiveToolNames();
			const missingTools = [...configuredTools].filter((tool) => !activeTools.includes(tool));
			const unexpectedTools = activeTools.filter((tool) => !configuredTools.has(tool));
			if (missingTools.length > 0 || unexpectedTools.length > 0) {
				throw new Error(
					`Child runtime tool snapshot mismatch (missing: ${missingTools.join(", ") || "none"}; unexpected: ${unexpectedTools.join(", ") || "none"})`,
				);
			}
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolvePromise) => {
				resolveSettled = resolvePromise;
			});
			let resolveCompletion!: () => void;
			const completion = new Promise<void>((resolvePromise) => {
				resolveCompletion = resolvePromise;
			});
			const hot: HotChild = {
				accepting: true,
				admissions: new Set(),
				runtime,
				taskId,
				startedAt: this.now(),
				settled,
				resolveSettled,
				completion,
				resolveCompletion,
				unsubscribe: () => undefined,
			};
			const childSession = runtime.session;
			hot.unsubscribe = childSession.subscribe((event) => {
				if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
					this.emitUpdate(this.buildSummary(this.store.load(agentId)));
				}
				if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
					this.emitEvent({ type: "activity", agentId, taskId, event });
				}
				if (event.type === "agent_settled") {
					hot.accepting = false;
					hot.resolveSettled();
				}
			});
			const unsubscribeConsumed = childSession.subscribeDurablePromptConsumed?.((messageId) =>
				this.markInputConsumed(agentId, messageId),
			);
			const unsubscribeActivity = hot.unsubscribe;
			hot.unsubscribe = () => {
				unsubscribeConsumed?.();
				unsubscribeActivity();
			};
			this.hot.set(agentId, hot);
			markReady();
			this.persistRuntimeCeiling(runtime, agentId);
			this.appendHotTaskState(runtime, {
				taskId,
				status: "running",
			});
			this.emitUpdate(this.buildSummary(this.store.load(agentId)));
			const text = taskText(runtime.session.sessionManager.getDurableJournalSnapshot(), taskId);
			const baselineStats = runtime.session.getSessionStats();
			const admitted = this.inputs(agentId).find(
				(entry) =>
					entry.taskId === taskId &&
					entry.delivery !== "steer" &&
					(entry.state === "queued" || entry.state === "accepted"),
			);
			if ((originalInputs.length > 0 && !admitted) || this.suppressedTasks.has(taskId)) {
				this.suppressedTasks.delete(taskId);
				this.appendHotTaskState(runtime, { taskId, status: "stopped", reason: "interrupted" });
				return undefined;
			}
			await runtime.submitPrompt(
				admitted
					? { requestId: admitted.messageId, ...admitted.input }
					: { requestId: this.requestId("task", agentId), text },
			);
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<"timeout">((resolvePromise) => {
				timeout = setTimeout(() => resolvePromise("timeout"), config.timeoutSeconds * 1_000);
			});
			const outcome = await Promise.race([settled.then(() => "settled" as const), timedOut]);
			if (timeout) clearTimeout(timeout);
			if (outcome === "settled") {
				await Promise.allSettled([...hot.admissions]);
				await runtime.waitForIdle?.();
			}
			if (outcome === "timeout") {
				hot.stopReason = undefined;
				await runtime.interrupt({ requestId: this.requestId("timeout", agentId) });
			}
			const stats = runtime.session.getSessionStats();
			const model =
				runtime.session.model ?? ({ provider: config.model.provider, id: config.model.modelId } as Model<any>);
			const usage: AgentUsage = {
				model: { provider: model.provider, modelId: model.id },
				input: Math.max(0, stats.tokens.input - baselineStats.tokens.input),
				output: Math.max(0, stats.tokens.output - baselineStats.tokens.output),
				cacheRead: Math.max(0, stats.tokens.cacheRead - baselineStats.tokens.cacheRead),
				cacheWrite: Math.max(0, stats.tokens.cacheWrite - baselineStats.tokens.cacheWrite),
				elapsedMs: Math.max(0, this.now() - hot.startedAt),
				toolCalls: Math.max(0, stats.toolCalls - baselineStats.toolCalls),
				...(Number.isFinite(stats.cost) && Number.isFinite(baselineStats.cost)
					? { cost: Math.max(0, stats.cost - baselineStats.cost) }
					: {}),
			};
			const assistant = taskAssistant(runtime.session.sessionManager.getDurableJournalSnapshot(), taskId);
			const status =
				outcome === "timeout"
					? "failed"
					: hot.stopReason
						? "stopped"
						: assistant?.stopReason === "aborted"
							? "stopped"
							: assistant?.stopReason === "error"
								? "failed"
								: "done";
			const reason =
				outcome === "timeout"
					? "timeout"
					: hot.stopReason
						? hot.stopReason
						: assistant?.stopReason === "error"
							? "error"
							: assistant?.stopReason === "aborted"
								? "interrupted"
								: "completed";
			const terminalError =
				outcome === "timeout"
					? `Agent task timed out after ${config.timeoutSeconds} seconds`
					: assistant?.stopReason === "error"
						? (assistant.errorMessage ?? "Child model response ended with an error")
						: undefined;
			const finalMessage =
				status === "done" && !assistantHasToolCalls(assistant) ? assistantText(assistant) : undefined;
			this.appendHotTaskState(runtime, {
				taskId,
				status,
				reason,
				...(finalMessage ? { finalMessage } : {}),
				...(terminalError ? { error: utf8Prefix(terminalError, 64 * 1024) } : {}),
				usage,
			});
			hot.unsubscribe();
			await runtime.dispose();
			runtime = undefined;
			this.writers.delete(agentId);
			return this.store.listTasks(agentId).find((task) => task.taskId === taskId);
		} catch (error) {
			const hot = this.hot.get(agentId);
			hot?.unsubscribe();
			const lifecycleErrors: unknown[] = [error];
			try {
				if (runtime) await runtime.dispose();
				else childManager.close();
			} catch (cleanupError) {
				lifecycleErrors.push(cleanupError);
			}
			this.writers.delete(agentId);
			const errorText = lifecycleErrors
				.map((failure) => (failure instanceof Error ? failure.message : String(failure)))
				.join("; ");
			const firstError = lifecycleErrors[0];
			const lifecycleError =
				lifecycleErrors.length === 1 && firstError instanceof Error
					? firstError
					: new AggregateError(lifecycleErrors, "Agent lifecycle cleanup failed");
			if (hot) hot.lifecycleError = lifecycleError;
			if (this.deleting.has(agentId)) return undefined;
			this.hot.delete(agentId);
			hot?.resolveCompletion();
			this.appendTaskState(agentId, {
				taskId,
				status: hot?.stopReason ? "stopped" : "failed",
				reason: hot?.stopReason ?? "error",
				error: utf8Prefix(errorText, 64 * 1024),
			});
			return this.store.listTasks(agentId).find((task) => task.taskId === taskId);
		}
	}

	private appendHotTaskState(
		runtime: AgentSessionRuntime,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskSummary["status"];
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
	): string {
		const journal = runtime.session.sessionManager.getDurableJournalSnapshot();
		const prior = [...journal]
			.reverse()
			.find((entry) => entry.type === "agent_task" && entry.taskId === input.taskId);
		if (!prior || prior.type !== "agent_task") throw new Error(`Unknown agent task: ${input.taskId}`);
		const id = runtime.session.sessionManager.appendAgentControl({
			type: "agent_task",
			agentId: prior.agentId,
			taskId: input.taskId,
			text: prior.text,
			taskSummary: prior.taskSummary,
			status: input.status,
			...(input.reason ? { reason: input.reason } : {}),
			...(input.finalMessage ? { finalMessage: input.finalMessage } : {}),
			...(input.error ? { error: input.error } : {}),
			...(input.usage ? { usage: input.usage } : {}),
		});
		this.trackTask(prior.agentId, input.taskId, input.status);
		return id;
	}

	private appendTaskState(
		agentId: string,
		input: {
			readonly taskId: string;
			readonly status: AgentTaskSummary["status"];
			readonly reason?: AgentStateReason;
			readonly finalMessage?: string;
			readonly error?: string;
			readonly usage?: AgentUsage;
		},
		record?: AgentDiskRecord,
	): void {
		const hot = this.hot.get(agentId);
		if (hot) {
			this.appendHotTaskState(hot.runtime, input);
			return;
		}
		this.withWriter(
			agentId,
			(writer) => {
				const journal = writer.getDurableJournalSnapshot();
				const prior = [...journal]
					.reverse()
					.find((entry) => entry.type === "agent_task" && entry.taskId === input.taskId);
				if (!prior || prior.type !== "agent_task") throw new Error(`Unknown agent task: ${input.taskId}`);
				writer.appendAgentControl({
					type: "agent_task",
					agentId: prior.agentId,
					taskId: input.taskId,
					text: prior.text,
					taskSummary: prior.taskSummary,
					status: input.status,
					...(input.reason ? { reason: input.reason } : {}),
					...(input.finalMessage ? { finalMessage: input.finalMessage } : {}),
					...(input.error ? { error: input.error } : {}),
					...(input.usage ? { usage: input.usage } : {}),
				});
			},
			record,
		);
		this.trackTask(agentId, input.taskId, input.status);
	}

	private async interruptNow(
		actorId: string,
		agentId: string,
		options: { readonly allowDeleting?: boolean } = {},
	): Promise<InterruptAgentResult> {
		this.assertDescendant(actorId, agentId);
		if (!options.allowDeleting) this.assertOperable(agentId);
		const existingTasks = this.store.listTasks(agentId);
		if (
			!this.hot.has(agentId) &&
			!existingTasks.some((task) => task.status === "queued" || task.status === "running")
		) {
			const latest = existingTasks.at(-1);
			if (latest && isTerminalTaskStatus(latest.status)) {
				return {
					agentId,
					taskId: latest.taskId,
					status: latest.status as "done" | "failed" | "stopped",
					cancelledTaskIds: [],
				};
			}
		}
		this.cancelPendingInputs(
			agentId,
			"Task interrupted before this input reached a model request",
			undefined,
			this.inputs(agentId).filter((entry) => entry.origin.kind !== "user"),
		);
		const cancelledTaskIds: string[] = [];
		const cancelledTasks: AgentTaskSummary[] = [];
		const hot = this.hot.get(agentId);
		for (const task of this.store.listTasks(agentId)) {
			if (task.status !== "queued" && (task.status !== "running" || hot)) continue;
			this.appendTaskState(agentId, {
				taskId: task.taskId,
				status: "stopped",
				reason: "interrupted",
			});
			cancelledTaskIds.push(task.taskId);
			const stopped = this.store.listTasks(agentId).find((candidate) => candidate.taskId === task.taskId);
			if (stopped) cancelledTasks.push(stopped);
		}
		this.cancelScheduled(agentId);
		for (const task of cancelledTasks) this.publishTerminal(this.store.load(agentId), task);
		await this.starting.get(agentId)?.ready;
		if (hot) {
			hot.stopReason = "interrupted";
			await hot.runtime.interrupt({ requestId: this.requestId("interrupt", agentId) });
			await hot.completion;
			if (hot.lifecycleError) throw hot.lifecycleError;
		}
		const tasks = this.store.listTasks(agentId);
		const running = tasks.find((task) => task.taskId === hot?.taskId);
		const latest = tasks.at(-1);
		const status =
			running?.status === "done" || running?.status === "failed"
				? running.status
				: latest?.status === "done" || latest?.status === "failed"
					? latest.status
					: "stopped";
		return {
			agentId,
			taskId: hot?.taskId ?? latest?.taskId,
			status,
			cancelledTaskIds,
		};
	}

	private recoverInterruptedWork(records: readonly AgentDiskRecord[]): void {
		for (const record of records) {
			const recoveredGuidance = this.recoverPendingGuidance(record);
			for (const input of this.store.reload(record).inputs) this.publishIntervention(record, input, false);
			if (record.tasks.some((task) => task.status === "queued" || task.status === "running")) {
				if (record.runControl?.state !== "user_paused")
					this.appendControl(
						record.agentId,
						{
							type: "agent_run_control",
							agentId: record.agentId,
							action: "stop",
							state: "interrupted",
							scope: "subtree",
							requestId: `recovered-${this.createId()}`,
							origin: { kind: "system", eventId: `recovery-${record.agentId}` },
						},
						record,
					);
				this.cancelPendingInputs(
					record.agentId,
					"Process interrupted before input delivery; resume with a new instruction",
					record,
					record.inputs.filter(
						(entry) =>
							!recoveredGuidance.has(entry.messageId) &&
							(entry.origin.kind !== "user" || entry.state === "accepted"),
					),
				);
			}
			for (const task of record.tasks) {
				if (task.status !== "queued" && task.status !== "running") continue;
				this.appendTaskState(
					record.agentId,
					{
						taskId: task.taskId,
						status: "stopped",
						reason: "parent_unloaded",
					},
					record,
				);
			}
		}
	}

	/** The original queued revision is the durable promotion intent; consumption wins over recovery. */
	private recoverPendingGuidance(record: AgentDiskRecord): ReadonlySet<string> {
		const journal = this.store.readJournal(record.agentId, record);
		const runtime = reduceRuntimeJournal(journal);
		const recovered = new Set<string>();
		for (const input of record.inputs) {
			if (input.origin.kind !== "user" || input.state !== "accepted" || input.delivery !== "steer") continue;
			const index = journal.findIndex((entry) => entry.id === input.id);
			if (index < 0) continue;
			const original = journal
				.slice(0, index)
				.reverse()
				.find(
					(entry): entry is AgentInputEntry =>
						entry.type === "agent_input" &&
						entry.messageId === input.messageId &&
						entry.state === "queued" &&
						entry.taskId !== input.taskId,
				);
			if (!original) continue;
			const requestId = queuedAdmissionRequestId(original.messageId, original.id);
			const operation = runtime.operations.find((entry) => entry.requestId === requestId);
			const consumed =
				runtime.queues.some(
					(entry) => entry.operationId === operation?.operationId && entry.state === "consumed",
				) || journal.some((entry) => entry.type === "message" && entry.agentMessageId === requestId);
			const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = consumed ? input : original;
			this.appendControl(record.agentId, { ...payload, state: consumed ? "delivered" : "queued" }, record);
			recovered.add(input.messageId);
		}
		return recovered;
	}

	private actorCeiling(actorId: string, actorPreset: PermissionPreset): PermissionSettings {
		const requested = settingsForPreset(actorPreset);
		if (actorId === this.rootSessionId) return requested;
		const inherited = this.childPermissionCeilings.get(actorId);
		return inherited ? intersectPermissionSettings(requested, inherited) : requested;
	}

	private notifyChildCeilingChanged(agentId: string): void {
		const hot = this.hot.get(agentId);
		const session = hot?.runtime.session as { notifyPermissionCeilingChanged?: () => void } | undefined;
		session?.notifyPermissionCeilingChanged?.();
	}

	private narrowDescendantsTo(actorId: string, parentPreset: PermissionPreset): void {
		const actorPath = this.actorPath(actorId);
		const actorCeiling = this.actorCeiling(actorId, parentPreset);
		const records = this.store
			.listTree()
			.agents.filter((record) => this.isDescendantPath(actorPath, record.config.agentPath))
			.sort((left, right) => left.config.agentPath.length - right.config.agentPath.length);
		for (const record of records) {
			const inherited =
				record.config.parentSessionId === actorId
					? actorCeiling
					: (this.childPermissionCeilings.get(record.config.parentSessionId) ?? actorCeiling);
			const current =
				this.childPermissionCeilings.get(record.agentId) ??
				record.permissionCeiling ??
				settingsForPreset(record.config.permissionPreset);
			const next = intersectPermissionSettings(current, inherited);
			if (samePermissionSettings(current, next)) continue;
			this.childPermissionCeilings.set(record.agentId, next);
			this.withWriter(
				record.agentId,
				(writer) => this.recordCeiling(writer, record.agentId, presetForSettings(next)),
				record,
			);
			this.notifyChildCeilingChanged(record.agentId);
		}
	}

	private recordCeiling(manager: SessionManager, agentId: string, preset: PermissionPreset): void {
		const latest = [...manager.getDurableJournalSnapshot()]
			.reverse()
			.find((entry) => entry.type === "agent_permission_ceiling" && entry.agentId === agentId);
		if (latest?.type === "agent_permission_ceiling" && latest.permissionPreset === preset) return;
		manager.appendAgentControl({ type: "agent_permission_ceiling", agentId, permissionPreset: preset });
	}

	private persistRuntimeCeiling(runtime: AgentSessionRuntime, agentId: string): void {
		const ceiling = this.childPermissionCeilings.get(agentId);
		if (!ceiling) return;
		this.recordCeiling(runtime.session.sessionManager, agentId, presetForSettings(ceiling));
		this.notifyChildCeilingChanged(agentId);
	}

	private resolveModel(parent: AgentSession, requested: string | undefined): Model<any> {
		if (!requested) {
			if (!parent.model) throw new AgentError("MODEL_UNAVAILABLE", "Parent session has no selected model");
			return parent.model;
		}
		const slash = requested.indexOf("/");
		if (slash <= 0 || slash === requested.length - 1 || requested.length > 512 || /\s/u.test(requested)) {
			throw new AgentError("INVALID_INPUT", "Child model must use exact provider/modelId syntax");
		}
		const registry = parent.modelRegistry as {
			find(provider: string, modelId: string): Model<any> | undefined;
			hasConfiguredAuth(model: Model<any>): boolean;
		};
		const model = registry.find(requested.slice(0, slash), requested.slice(slash + 1));
		if (!model || !registry.hasConfiguredAuth(model)) {
			throw new AgentError("MODEL_UNAVAILABLE", `Child model is unavailable: ${requested}`);
		}
		return model;
	}

	private resolveCwd(value: string): string {
		const path = realpathSync(resolve(this.parentSessionManager.getCwd(), value));
		if (!statSync(path).isDirectory())
			throw new AgentError("INVALID_INPUT", "Agent cwd must be an existing directory");
		if (!this.getWorkspaceRoots().some((root) => isInside(root, path))) {
			throw new AgentError("INVALID_INPUT", "Agent cwd must stay inside the parent workspace");
		}
		return path;
	}

	private buildSummary(record: AgentDiskRecord): AgentSummary {
		const hot = this.hot.get(record.agentId);
		const retry = hot?.runtime.session.retryState;
		return {
			...agentSummaryFromRecord(record, { hotTaskId: hot?.taskId, now: this.now() }),
			...(retry ? { retry } : {}),
		};
	}

	private aggregateUsage(summaries: readonly AgentSummary[]): AgentUsageTotals {
		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let elapsedMs = 0;
		let cost = 0;
		let hasCost = false;
		for (const summary of summaries) {
			for (const task of summary.tasks) {
				const usage = task.usage;
				if (!usage) continue;
				input += usage.input;
				output += usage.output;
				cacheRead += usage.cacheRead;
				cacheWrite += usage.cacheWrite;
				elapsedMs += usage.elapsedMs;
				if (usage.cost !== undefined) {
					cost += usage.cost;
					hasCost = true;
				}
			}
		}
		return { input, output, cacheRead, cacheWrite, elapsedMs, ...(hasCost ? { cost } : {}) };
	}

	private assertDescendant(actorId: string, targetAgentId: string): AgentDiskRecord {
		const target = this.loadKnown(targetAgentId);
		const actorPath = this.actorPath(actorId);
		if (target.agentId === actorId) {
			throw new AgentError("NOT_DESCENDANT", "An agent cannot target itself");
		}
		if (target.config.agentPath.length <= actorPath.length) {
			throw new AgentError("NOT_DESCENDANT", "Agent is not a descendant");
		}
		if (actorPath.some((id, index) => target.config.agentPath[index] !== id)) {
			throw new AgentError("NOT_DESCENDANT", "Agent is not a descendant");
		}
		return target;
	}

	private isDescendantPath(actorPath: readonly string[], targetPath: readonly string[]): boolean {
		if (targetPath.length <= actorPath.length) return false;
		return actorPath.every((id, index) => targetPath[index] === id);
	}

	private actorPath(actorId: string): readonly string[] {
		if (actorId === this.rootSessionId) return [];
		return [...this.loadKnown(actorId).config.agentPath];
	}

	private emitUpdate(summary: AgentSummary): AgentSummary {
		this.emitEvent({ type: "updated", summary });
		return summary;
	}

	private emitApprovalRequired(summary: AgentSummary, taskId: string, toolName: string): void {
		this.emitEvent({ type: "approval_required", summary, taskId, toolName });
	}

	private waitAgentsSnapshot(
		actorId: string,
		summaries: readonly AgentSummary[],
		selected: ReadonlySet<string>,
	): WaitAgentsResult | undefined {
		return waitAgentsSnapshot(summaries, selected, this.pendingMailboxEventIds(actorId), this.approvalRequests);
	}

	private pendingMailboxEventIds(actorId: string): readonly string[] {
		return this.actors.get(actorId)?.session.getPendingAgentMailboxEventIds() ?? [];
	}

	private notifyMailboxWaiters(actorId: string): void {
		for (const waiter of this.waiters) {
			if (waiter.actorId !== actorId) continue;
			const result = waiter.snapshot();
			if (result) waiter.resolve(result);
		}
	}

	private notifyApprovalWaiters(agentId: string): void {
		resolveWaiters(this.waiters, agentId);
	}

	private emitEvent(event: AgentManagerEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private publishTerminal(record: AgentDiskRecord, task: AgentTaskSummary): AgentSummary {
		const summary = this.emitUpdate(this.buildSummary(record));
		if (!isTerminalTaskStatus(task.status) || this.unloaded) return summary;
		this.publishMailbox(terminalMailboxEvent(record, task));
		resolveWaiters(this.waiters, record.agentId);
		return summary;
	}

	private pendingMailboxIds(journal: readonly FileEntry[]): string[] {
		const pending = new Set<string>();
		const started = new Set<string>();
		for (const entry of journal) {
			if (entry.type === "agent_mailbox_event") {
				pending.add(entry.event.eventId);
				continue;
			}
			if (entry.type !== "agent_mailbox_delivery") continue;
			const key = `${entry.deliveryId}\n${JSON.stringify(entry.eventIds)}`;
			if (entry.state === "started") started.add(key);
			else if (started.has(key)) for (const eventId of entry.eventIds) pending.delete(eventId);
		}
		return [...pending];
	}

	private recoverMailboxEvents(session: AgentSession): void {
		const parentId = session.sessionManager.getSessionId();
		for (const record of this.store.listTree().agents) {
			if (record.config.parentSessionId === parentId)
				for (const task of record.tasks) {
					if (!isTerminalTaskStatus(task.status)) continue;
					const event = terminalMailboxEvent(record, task);
					if (!session.hasAgentMailboxEvent(event.eventId)) this.publishMailbox(event, false);
				}
			if (record.config.parentSessionId === parentId || parentId === this.rootSessionId) {
				for (const input of record.inputs)
					if (!session.hasAgentMailboxEvent(`agent:${record.agentId}:${input.messageId}:intervention:${parentId}`))
						this.publishIntervention(record, input, false, parentId);
				for (const entry of this.journal(record.agentId, record))
					if (
						entry.type === "agent_run_control" &&
						entry.agentId === record.agentId &&
						entry.origin.kind === "user" &&
						!session.hasAgentMailboxEvent(`agent:${record.agentId}:${entry.requestId}:control:${parentId}`)
					)
						this.publishControl(record, entry, false, parentId);
			}
		}
	}

	private assertMessageActor(actor: AgentMessageActor, agentId: string): AgentDiskRecord {
		if (actor.kind === "user") return this.assertDescendant(this.rootSessionId, agentId);
		this.requireActor(actor.sessionId);
		return this.assertDescendant(actor.sessionId, agentId);
	}

	private journal(agentId: string, record?: AgentDiskRecord): readonly FileEntry[] {
		if (agentId === this.rootSessionId) return this.parentSessionManager.getDurableJournalSnapshot();
		return (
			(
				this.hot.get(agentId)?.runtime.session.sessionManager ?? this.writers.get(agentId)
			)?.getDurableJournalSnapshot() ?? this.store.readJournal(agentId, record)
		);
	}

	private withWriter<T>(agentId: string, action: (manager: SessionManager) => T, record?: AgentDiskRecord): T {
		const owner =
			agentId === this.rootSessionId
				? this.parentSessionManager
				: (this.hot.get(agentId)?.runtime.session.sessionManager ?? this.writers.get(agentId));
		if (owner) return action(owner);
		const path = record?.agentId === agentId ? record.path : this.store.load(agentId).path;
		const writer = SessionManager.open(path);
		try {
			return action(writer);
		} finally {
			writer.close();
		}
	}

	private appendControl(agentId: string, payload: AgentControlPayload, record?: AgentDiskRecord): void {
		this.withWriter(agentId, (writer) => writer.appendAgentControl(payload), record);
	}

	private runControl(agentId: string): AgentRunControlEntry | undefined {
		return [...this.journal(agentId)]
			.reverse()
			.find(
				(entry): entry is AgentRunControlEntry => entry.type === "agent_run_control" && entry.agentId === agentId,
			);
	}

	private assertRunAllowed(agentId: string, allowTargetResume = false, target?: AgentDiskRecord): void {
		const path =
			agentId === this.rootSessionId
				? [this.rootSessionId]
				: [
						this.rootSessionId,
						...(target?.agentId === agentId
							? target.config.agentPath
							: this.store.load(agentId).config.agentPath),
					];
		for (const id of path) {
			const record = id === this.rootSessionId ? undefined : id === agentId && target ? target : this.store.load(id);
			if (record?.archived) throw new AgentError("INVALID_STATE", `Agent execution is archived: ${id}`);
			if (allowTargetResume && id === agentId) continue;
			const control = record ? record.runControl : this.runControl(id);
			if (!control || control.state === "enabled") continue;
			if (id !== agentId && control.scope !== "subtree") continue;
			throw new AgentError(
				control.state === "user_paused" ? "USER_PAUSED" : "INVALID_STATE",
				`Agent execution is ${control.state}: ${id}`,
			);
		}
	}

	private inputs(agentId: string): AgentInputEntry[] {
		return this.inputsFromJournal(this.journal(agentId));
	}

	private inputsForRecord(record: AgentDiskRecord): AgentInputEntry[] {
		const owner = this.hot.get(record.agentId)?.runtime.session.sessionManager ?? this.writers.get(record.agentId);
		return this.inputsFromJournal(
			owner?.getDurableJournalSnapshot() ?? this.store.readJournal(record.agentId, record),
		);
	}

	private inputsFromJournal(journal: readonly FileEntry[]): AgentInputEntry[] {
		const latest = new Map<string, AgentInputEntry>();
		for (const entry of journal) if (entry.type === "agent_input") latest.set(entry.messageId, entry);
		return [...latest.values()];
	}

	private messageReceipt(entry: AgentInputEntry): AgentMessageReceipt {
		const { agentId, taskId, messageId, requestId, delivery, state, instructionRevision } = entry;
		return { agentId, taskId, messageId, requestId, delivery, state, instructionRevision };
	}

	private cancelPendingInputs(
		agentId: string,
		reason: string,
		record?: AgentDiskRecord,
		inputs: readonly AgentInputEntry[] = this.inputs(agentId),
	): void {
		for (const entry of inputs) {
			if (entry.state !== "accepted" && entry.state !== "queued") continue;
			const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = entry;
			this.appendControl(agentId, { ...payload, state: "cancelled", error: reason }, record);
		}
	}

	private markInputConsumed(agentId: string, messageId: string): void {
		const inputs = this.inputs(agentId);
		let input = inputs.find((entry) => entry.messageId === messageId);
		if (!input) {
			const origin = [...this.journal(agentId)]
				.reverse()
				.find(
					(entry): entry is AgentInputEntry =>
						entry.type === "agent_input" && queuedAdmissionRequestId(entry.messageId, entry.id) === messageId,
				);
			if (origin) input = inputs.find((entry) => entry.messageId === origin.messageId);
		}
		if (!input || input.state === "delivered" || input.state === "cancelled" || input.state === "failed") return;
		const { id: _id, parentId: _parentId, timestamp: _timestamp, ...payload } = input;
		this.appendControl(agentId, { ...payload, state: "delivered" });
		this.emitUpdate(this.buildSummary(this.store.load(agentId)));
	}

	private publishIntervention(
		record: AgentDiskRecord,
		input: AgentInputEntry,
		wake = true,
		onlyParent?: string,
	): void {
		if (input.origin.kind !== "user") return;
		for (const parentSessionId of new Set([record.config.parentSessionId, this.rootSessionId])) {
			if (onlyParent && parentSessionId !== onlyParent) continue;
			this.publishMailbox(
				{
					type: "intervention",
					eventId: `agent:${record.agentId}:${input.messageId}:intervention:${parentSessionId}`,
					taskId: input.taskId,
					agentId: record.agentId,
					parentSessionId,
					name: record.name,
					completedAt: input.timestamp,
					messageId: input.messageId,
					instructionRevision: input.instructionRevision,
					delivery: input.delivery,
					state: input.state,
					text: utf8Prefix(input.input.text || "Image input", 4096),
					...(input.input.images?.length ? { imageCount: input.input.images.length } : {}),
				},
				wake,
			);
		}
	}

	private publishControl(
		record: AgentDiskRecord,
		input: AgentRunControlEntry,
		wake = true,
		onlyParent?: string,
	): void {
		for (const parentSessionId of new Set([record.config.parentSessionId, this.rootSessionId])) {
			if (onlyParent && parentSessionId !== onlyParent) continue;
			this.publishMailbox(
				{
					type: "run_control",
					eventId: `agent:${record.agentId}:${input.requestId}:control:${parentSessionId}`,
					taskId: record.tasks.at(-1)?.taskId ?? record.agentId,
					agentId: record.agentId,
					parentSessionId,
					name: record.name,
					completedAt: input.timestamp,
					action: input.action,
					state: input.state,
					scope: input.scope,
				},
				wake,
			);
		}
	}

	private publishMailbox(event: AgentMailboxEvent, wake = true): void {
		if (this.unloaded) return;
		const parentId = event.parentSessionId;
		try {
			const parent = this.actors.get(parentId)?.session;
			let accepted = parent?.enqueueAgentMailboxEvent(event) ?? false;
			if (!parent)
				this.withWriter(parentId, (manager) => {
					const journal = manager.getDurableJournalSnapshot();
					if (
						journal.some((entry) => entry.type === "agent_mailbox_event" && entry.event.eventId === event.eventId)
					)
						return;
					if (this.pendingMailboxIds(journal).length >= MAX_AGENT_MAILBOX_PENDING_EVENTS)
						throw new Error("Agent mailbox is full");
					manager.appendAgentControl({ type: "agent_mailbox_event", event });
					accepted = true;
				});
			this.mailboxRetries.delete(event.eventId);
			if (accepted) {
				this.emitEvent({ type: "notification_ready", event, wake });
				this.notifyMailboxWaiters(parentId);
				if (wake && parentId !== this.rootSessionId) {
					this.mailboxContinuations.add(parentId);
					void this.serialize(parentId, async () => {
						this.scheduleNext(parentId);
					}).catch((error) => {
						this.emitEvent({ type: "notification_failed", event, error: String(error) });
					});
				}
			}
		} catch (error) {
			const firstFailure = !this.mailboxRetries.has(event.eventId);
			this.mailboxRetries.set(event.eventId, {
				event,
				wake: wake || this.mailboxRetries.get(event.eventId)?.wake === true,
			});
			this.scheduleMailboxRetry();
			if (firstFailure)
				this.emitEvent({
					type: "notification_failed",
					event,
					error: error instanceof Error ? error.message : String(error),
				});
		}
	}

	private scheduleMailboxRetry(): void {
		if (this.unloaded || this.mailboxRetryTimer || this.mailboxRetries.size === 0) return;
		this.mailboxRetryTimer = setTimeout(() => {
			this.mailboxRetryTimer = undefined;
			for (const { event, wake } of [...this.mailboxRetries.values()]) this.publishMailbox(event, wake);
		}, 1000);
		this.mailboxRetryTimer.unref?.();
	}

	private serialize<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(agentId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(operation);
		this.tails.set(agentId, next);
		void next.then(
			() => {
				if (this.tails.get(agentId) === next) this.tails.delete(agentId);
			},
			() => {
				if (this.tails.get(agentId) === next) this.tails.delete(agentId);
			},
		);
		return next;
	}

	private requestId(kind: string, agentId: string): string {
		return `agent-${kind}-${agentId}-${createSessionId()}`;
	}

	private requireActor(actorId: string): AgentSession {
		const attached = this.actors.get(actorId);
		if (!attached) throw new AgentError("INVALID_STATE", `Unknown agent actor: ${actorId}`);
		return attached.session;
	}

	private assertActive(): void {
		if (this.unloaded) throw new AgentError("INVALID_STATE", "Agent manager is unloaded");
	}

	private assertKnown(agentId: string): void {
		this.loadKnown(agentId);
	}

	private loadKnown(agentId: string): AgentDiskRecord {
		this.assertActive();
		try {
			return this.store.load(agentId);
		} catch {
			throw new AgentError("UNKNOWN_AGENT", `Unknown agent: ${agentId}`);
		}
	}

	private assertOperable(agentId: string): void {
		this.assertKnown(agentId);
		if (this.deleting.has(agentId)) throw new AgentError("INVALID_STATE", `Agent is deleting: ${agentId}`);
	}
}

export function agentSummaryFromRecord(
	record: AgentDiskRecord,
	options: { hotTaskId?: string; now?: number } = {},
): AgentSummary {
	const tasks = record.tasks;
	const hot = options.hotTaskId ? { taskId: options.hotTaskId } : undefined;
	const running = tasks.find((task) => task.taskId === hot?.taskId) ?? tasks.find((task) => task.status === "running");
	const current = running ?? tasks.find((task) => task.status === "queued");
	// Task creation order is not lifecycle order: a queued Guide placeholder is
	// stopped before the active task completes, so the last state change
	// decides the latest task (later-created tasks win timestamp ties).
	let latest: AgentTaskSummary | undefined;
	for (const task of tasks) if (!latest || task.updatedAt >= latest.updatedAt) latest = task;
	const status = hot ? "running" : agentStatusFromTasks(tasks);
	const createdAt = tasks[0]?.createdAt ?? new Date(options.now ?? Date.now()).toISOString();
	const updatedAt = tasks.reduce(
		(latestTimestamp, task) => (task.updatedAt > latestTimestamp ? task.updatedAt : latestTimestamp),
		createdAt,
	);
	return {
		agentId: record.agentId,
		name: record.name,
		agentType: record.config.agentType,
		model: record.config.model,
		...(record.runControl ? { runControl: record.runControl } : {}),
		mode: record.config.mode ?? "code",
		...(record.config.roleSnapshot ? { roleSnapshot: record.config.roleSnapshot } : {}),
		depth: record.config.agentPath.length,
		status,
		archived: record.archived,
		tools: effectiveAgentToolNames(record.config),
		writePolicy: record.config.writePolicy,
		mayDelegate: record.config.mayDelegate,
		tasks,
		parentSessionId: record.config.parentSessionId,
		rootSessionId: record.config.rootSessionId,
		agentPath: record.config.agentPath,
		...(current ? { currentTask: current } : {}),
		...(latest ? { latestTask: latest } : {}),
		createdAt,
		updatedAt,
	};
}
