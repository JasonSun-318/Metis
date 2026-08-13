import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentMode } from "./agent-mode.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { PermissionMode } from "./permission-mode.ts";
import { QueuedTurnConflictError, type QueuedTurnDraft, QueuedTurnQueue } from "./queued-turn-queue.ts";
import {
	type DurableImageRef,
	identifyRuntimeRequest,
	identifySubmitPromptRequest,
	parseDurablePromptSubmission,
	RequestIdReusedError,
} from "./runtime-recovery.ts";
import { materializeRuntimeRecovery, type RecoverablePromptDraft } from "./runtime-recovery-materializer.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { createSessionId } from "./session-id.ts";
import { getSessionSubagentDir, SessionManager } from "./session-manager.ts";
import { removeOwnedManagedWorkspace, resolveNewSessionWorkspace } from "./session-workspace.ts";
import { SubagentManager } from "./subagents/manager.ts";
import { SUBAGENT_COORDINATION_PROMPT } from "./subagents/prompts.ts";
import { createSubagentTools } from "./subagents/tools.ts";
import {
	type ActivateSubagentsResult,
	SUBAGENT_ACTIVATION_TOOL_NAME,
	SUBAGENT_TOOL_NAMES,
	type SubagentConfig,
} from "./subagents/types.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export interface SubmitPromptInput {
	requestId: string;
	text: string;
	images?: readonly DurableImageRef[];
	streamingBehavior?: "steer" | "followUp";
}

export interface SubmitPromptResult {
	operationId: string;
	queueItemId?: string;
	turnId?: string;
	status: "accepted" | "existing";
}

export interface SubmitInterruptInput {
	requestId: string;
}

export interface SubmitInterruptResult {
	operationId: string;
	status: "accepted" | "existing";
}

export class QueuedTurnBusyError extends Error {
	readonly code = "BUSY";
	constructor() {
		super("The task state changed before the queued turn could be sent");
		this.name = "QueuedTurnBusyError";
	}
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	ultraAvailable?: boolean;
	childConfig?: SubagentConfig;
	permissionModeCeiling?: () => PermissionMode;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function pathsReferToSameFile(left: string, right: string): boolean {
	if (resolve(left) === resolve(right)) return true;
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

function closeUnadoptedSessionManager(sessionManager: SessionManager, error: unknown, message: string): never {
	try {
		sessionManager.close();
	} catch (cleanupError) {
		try {
			sessionManager.close();
		} catch (retryError) {
			throw new AggregateError([error, cleanupError, retryError], message);
		}
	}
	throw error;
}

function recoverSessionManager(sessionManager: SessionManager): RecoveredSessionRuntime {
	const result = materializeRuntimeRecovery(sessionManager);
	const reduced = result.state;
	if (reduced.decisions.length > 0) throw new Error("Runtime recovery did not reach a stable journal state");
	const queues = new Map(reduced.queues.map((queue) => [queue.operationId, queue]));
	const requests = new Map<string, IndexedRuntimeRequest>();
	const operations = new Map<string, IndexedRuntimeRequest>();
	for (const operation of reduced.operations) {
		const queue = queues.get(operation.operationId);
		const indexed: IndexedRuntimeRequest = {
			requestId: operation.requestId,
			requestHash: operation.requestHash,
			operationId: operation.operationId,
			...(queue === undefined ? {} : { queueItemId: queue.queueItemId }),
			...(operation.turnId === undefined ? {} : { turnId: operation.turnId }),
		};
		requests.set(indexed.requestId, indexed);
		operations.set(indexed.operationId, indexed);
	}
	return {
		recoverableDrafts: result.drafts.map((draft) => ({
			queueItemId: draft.queueItemId,
			input: structuredClone(draft.input),
		})),
		requests,
		operations,
	};
}

const lifecycleOperationContext = new AsyncLocalStorage<{ owner: object; active: boolean }>();
const acceptedPromptTaskContext = new AsyncLocalStorage<{ owner: object; active: boolean }>();
const REENTRANT_LIFECYCLE_ERROR = "Session lifecycle changes cannot be awaited from within another lifecycle operation";
const ACCEPTED_PROMPT_LIFECYCLE_ERROR = "Session lifecycle changes cannot run from within an accepted prompt task";
const RUNTIME_DISPOSING_ERROR = "Agent session runtime is disposing or disposed";

class AgentSessionRuntimeTerminalError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "AgentSessionRuntimeTerminalError";
	}
}

type CandidateRuntimeOptions = Omit<Parameters<CreateAgentSessionRuntimeFactory>[0], "agentDir" | "sessionManager">;

interface PreparedRuntime {
	readonly result: CreateAgentSessionRuntimeResult;
	readonly recovered: RecoveredSessionRuntime;
}

interface IndexedRuntimeRequest {
	readonly requestId: string;
	readonly requestHash: string;
	readonly operationId: string;
	queueItemId?: string;
	turnId?: string;
}

interface RecoveredSessionRuntime {
	readonly recoverableDrafts: readonly RecoverablePromptDraft[];
	readonly requests: Map<string, IndexedRuntimeRequest>;
	readonly operations: Map<string, IndexedRuntimeRequest>;
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Different-target replacements prepare the next runtime before invalidating the
 * current one. Same-target replacements rebuild the original runtime on failure.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private disposePromise?: Promise<void>;
	private eventPersistenceDrained = false;
	private shutdownAttempted = false;
	private beforeInvalidateAttempted = false;
	private runtimeRecoveryAttempted = false;
	private disposed = false;
	private disposeRequested = false;
	private terminalError?: AgentSessionRuntimeTerminalError;
	private lifecycleTail: Promise<void> = Promise.resolve();
	private submissionGateOpen = true;
	private submissionDisabled = false;
	private pendingLifecycleOperations = 0;
	private readonly acceptedTasks = new Set<Promise<void>>();
	private queuedTurnQueue: QueuedTurnQueue;
	private readonly queuedTurnListeners = new Set<(turns: readonly QueuedTurnDraft[]) => void>();
	private queuedTurnDrainTask?: Promise<void>;
	private _recoverableDrafts: readonly RecoverablePromptDraft[];
	private requestIndex: Map<string, IndexedRuntimeRequest>;
	private operationIndex: Map<string, IndexedRuntimeRequest>;
	private readonly hostCwd: string;
	private subagentManagerValue?: SubagentManager;
	private subagentsActivated = false;
	private readonly pendingSubagentContinuationIds = new Set<string>();
	private readonly attemptedSubagentContinuationIds = new Set<string>();
	private subagentContinuationTask?: Promise<void>;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		_recovered?: RecoveredSessionRuntime,
		hostCwd: string = process.cwd(),
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this._recoverableDrafts = _recovered?.recoverableDrafts ?? [];
		this.requestIndex = _recovered?.requests ?? new Map();
		this.operationIndex = _recovered?.operations ?? new Map();
		this.hostCwd = resolvePath(hostCwd);
		this.queuedTurnQueue = new QueuedTurnQueue(_session.sessionManager);
		this.bindDurableSession(_session);
		this.bindSubagents(_session);
	}

	get services(): AgentSessionServices {
		this.assertPubliclyAccessible();
		return this._services;
	}

	get session(): AgentSession {
		this.assertPubliclyAccessible();
		return this._session;
	}

	get cwd(): string {
		this.assertPubliclyAccessible();
		return this._services.cwd;
	}

	/** Terminal cwd captured when the runtime host was created. */
	get terminalCwd(): string {
		return this.hostCwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	get recoverableDrafts(): readonly RecoverablePromptDraft[] {
		this.assertPubliclyAccessible();
		return structuredClone(this._recoverableDrafts);
	}

	get queuedTurns(): readonly QueuedTurnDraft[] {
		this.assertPubliclyAccessible();
		return this.queuedTurnQueue.list();
	}

	subscribeQueuedTurns(listener: (turns: readonly QueuedTurnDraft[]) => void): () => void {
		this.assertPubliclyAccessible();
		this.queuedTurnListeners.add(listener);
		return () => this.queuedTurnListeners.delete(listener);
	}

	get subagentManager(): SubagentManager | undefined {
		this.assertPubliclyAccessible();
		return this.subagentManagerValue;
	}

	async initializeSubagents(): Promise<void> {
		this.assertPubliclyAccessible();
		await this.subagentManagerValue?.recoverCloseMarkers();
	}

	private bindDurableSession(session: AgentSession): void {
		session.setDurableOperationTurnListener((operationId, turnId) => {
			const indexed = this.operationIndex.get(operationId);
			if (indexed) indexed.turnId = turnId;
			this.emitQueuedTurns();
		});
	}

	private bindSubagents(session: AgentSession): void {
		this.subagentsActivated = false;
		this.pendingSubagentContinuationIds.clear();
		this.attemptedSubagentContinuationIds.clear();
		this.subagentContinuationTask = undefined;
		const header = session.sessionManager.getHeader();
		if (!session.sessionManager.isPersisted() || header?.subagent || header?.scheduled) {
			this.subagentManagerValue = undefined;
			return;
		}
		const hasLegacyChildren =
			existsSync(getSessionSubagentDir(this._services.agentDir, session.sessionManager.getSessionId())) ||
			session.sessionManager.getDurableJournalSnapshot().some((entry) => entry.type === "subagent_closed");
		if (session.mode !== "code" && !hasLegacyChildren) {
			this.subagentManagerValue = undefined;
			return;
		}
		const manager = new SubagentManager({
			parentSessionManager: session.sessionManager,
			agentDir: this._services.agentDir,
			getWorkspaceRoots: () => session.sessionManager.getWorkspaceRoots(),
			onPermissionRequest: (request) => session.requestPermissionApproval(request),
			createChildRuntime: async ({ config, permissionModeCeiling, sessionManager, onPermissionRequest }) => {
				const recovered = recoverSessionManager(sessionManager);
				const result = await this.createRuntime({
					cwd: config.cwd,
					agentDir: this._services.agentDir,
					sessionManager,
					ultraAvailable: false,
					childConfig: config,
					permissionModeCeiling,
					sessionStartEvent: { type: "session_start", reason: "resume" },
				});
				result.session.setPermissionApprovalHandler(onPermissionRequest);
				return new AgentSessionRuntime(
					result.session,
					result.services,
					this.createRuntime,
					result.diagnostics,
					result.modelFallbackMessage,
					recovered,
					this.hostCwd,
				);
			},
		});
		this.subagentManagerValue = manager;
		session.installHostTools(
			createSubagentTools({
				getManager: () => this.subagentManagerValue,
				getSession: () => this._session,
				activateSubagents: () => this.activateSubagents(session),
			}),
			{ automaticPermissionToolNames: ["inspect_agents"] },
		);
		const sync = (): void => this.syncSubagentCapabilities(session);
		session.subscribe((event) => {
			if (event.type === "thinking_selection_changed") sync();
		});
		manager.subscribe((event) => {
			sync();
			if (event.type === "notification_ready") {
				this.requestSubagentContinuation(session, event.event.eventId);
			} else if (event.type === "notification_failed") {
				this._diagnostics = [
					...this._diagnostics,
					{ type: "warning", message: `Subagent notification failed: ${event.error}` },
				];
			}
		});
		manager.attachParent(session);
		sync();
	}

	private requestSubagentContinuation(session: AgentSession, eventId: string): void {
		if (session !== this._session || this.disposeRequested || this.disposed) return;
		this.pendingSubagentContinuationIds.add(eventId);
		this.scheduleSubagentContinuation(session);
	}

	private scheduleSubagentContinuation(session: AgentSession): void {
		if (this.subagentContinuationTask || session !== this._session || this.disposeRequested || this.disposed) return;
		let task!: Promise<void>;
		task = this.drainSubagentContinuation(session)
			.catch((error) => {
				this._diagnostics = [
					...this._diagnostics,
					{
						type: "warning",
						message: `Automatic subagent continuation failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				];
			})
			.finally(() => {
				if (this.subagentContinuationTask !== task) return;
				this.subagentContinuationTask = undefined;
				if (session !== this._session || this.disposeRequested || this.disposed) return;
				const pending = new Set(session.getPendingSubagentMailboxEventIds());
				const hasUnattempted = [...this.pendingSubagentContinuationIds].some(
					(eventId) => pending.has(eventId) && !this.attemptedSubagentContinuationIds.has(eventId),
				);
				if (hasUnattempted) this.scheduleSubagentContinuation(session);
			});
		this.subagentContinuationTask = task;
	}

	private async drainSubagentContinuation(session: AgentSession): Promise<void> {
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		await session.waitForIdle();
		if (session !== this._session || this.disposeRequested || this.disposed) return;

		const pending = new Set(session.getPendingSubagentMailboxEventIds());
		for (const eventId of [...this.pendingSubagentContinuationIds]) {
			if (!pending.has(eventId)) this.pendingSubagentContinuationIds.delete(eventId);
		}
		const unattempted = [...this.pendingSubagentContinuationIds].filter(
			(eventId) => !this.attemptedSubagentContinuationIds.has(eventId),
		);
		if (unattempted.length === 0) return;
		for (const eventId of unattempted) this.attemptedSubagentContinuationIds.add(eventId);

		await session.continueSubagentMailbox(unattempted);
		const remaining = new Set(session.getPendingSubagentMailboxEventIds());
		for (const eventId of [...this.pendingSubagentContinuationIds]) {
			if (!remaining.has(eventId)) this.pendingSubagentContinuationIds.delete(eventId);
		}
	}

	private activateSubagents(session: AgentSession): ActivateSubagentsResult {
		if (
			session !== this._session ||
			session.mode !== "code" ||
			!session.sessionManager.isPersisted() ||
			session.sessionManager.getHeader()?.subagent ||
			session.sessionManager.getHeader()?.scheduled ||
			session.getThinkingSelection() !== "ultra"
		) {
			throw new Error("Subagents can be activated only in a persisted primary Code session with Ultra selected");
		}
		const alreadyActivated = this.subagentsActivated;
		if (!alreadyActivated) {
			this.subagentsActivated = true;
			this.syncSubagentCapabilities(session);
		}
		return { activated: true, alreadyActivated };
	}

	private syncSubagentCapabilities(session: AgentSession): void {
		const manager = this.subagentManagerValue;
		if (!manager) return;
		const management = new Set<string>([SUBAGENT_ACTIVATION_TOOL_NAME, ...SUBAGENT_TOOL_NAMES]);
		const base = session.getActiveToolNames().filter((name) => !management.has(name));
		const residual = manager.listSummaries().some((summary) => summary.status !== "closed");
		const cleanup = residual ? ["inspect_agents", "interrupt_agent", "close_agent"] : [];
		const ultra = session.mode === "code" && session.getThinkingSelection() === "ultra";
		if (!ultra) this.subagentsActivated = false;
		const desired = ultra
			? this.subagentsActivated
				? [...SUBAGENT_TOOL_NAMES]
				: [SUBAGENT_ACTIVATION_TOOL_NAME, ...cleanup]
			: cleanup;
		session.setActiveToolsByName([...base, ...desired]);
		session.setHostSystemPrompt(() =>
			this.subagentsActivated && session.mode === "code" && session.getThinkingSelection() === "ultra"
				? SUBAGENT_COORDINATION_PROMPT
				: undefined,
		);
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	enqueueQueuedTurn(input: SubmitPromptInput): QueuedTurnDraft {
		this.assertPubliclyAccessible();
		if (!this.submissionGateOpen) throw new Error(RUNTIME_DISPOSING_ERROR);
		const submission = parseDurablePromptSubmission(input);
		this._session.prepareDurablePrompt(submission.input);
		const queuedTurn = this.queuedTurnQueue.enqueue({
			requestId: submission.requestId,
			input: submission.input,
			state: this._session.activeDurableTurnId !== undefined || this._session.isStreaming ? "enqueued" : "paused",
		});
		this.emitQueuedTurns();
		return queuedTurn;
	}

	updateQueuedTurn(input: { queueItemId: string; expectedRevision: string; text: string }): QueuedTurnDraft {
		this.assertPubliclyAccessible();
		const queuedTurn = this.queuedTurnQueue.update(input);
		this.emitQueuedTurns();
		return queuedTurn;
	}

	deleteQueuedTurn(input: { queueItemId: string; expectedRevision: string }): void {
		this.assertPubliclyAccessible();
		this.queuedTurnQueue.delete(input);
		this.emitQueuedTurns();
	}

	async sendQueuedTurn(input: {
		queueItemId: string;
		expectedRevision: string;
		delivery: "steer" | "start";
	}): Promise<SubmitPromptResult & { queueItemId: string }> {
		this.assertPubliclyAccessible();
		if (!this.submissionGateOpen) throw new Error(RUNTIME_DISPOSING_ERROR);
		const active = this._session.activeDurableTurnId !== undefined || this._session.isStreaming;
		if ((input.delivery === "steer" && !active) || (input.delivery === "start" && active)) {
			throw new QueuedTurnBusyError();
		}
		const current = this.queuedTurnQueue.list().find((item) => item.queueItemId === input.queueItemId);
		if (!current) throw new QueuedTurnConflictError(input.queueItemId);
		if (input.delivery === "start" && this.queuedTurnQueue.list()[0]?.queueItemId !== input.queueItemId) {
			throw new QueuedTurnConflictError(input.queueItemId);
		}
		this._session.assertCanDrainAgentEventPersistence();
		this._session.assertDurablePromptCapacity(current.input);
		this._session.prepareDurablePrompt(current.input);

		const draft = this.queuedTurnQueue.markDispatching(input);
		this.emitQueuedTurns();
		if (!draft.deliveryRequestId) throw new Error("Queued turn delivery request was not created");
		const identity = identifySubmitPromptRequest(draft.deliveryRequestId, draft.input);
		if (identity.operationId !== draft.operationId) throw new Error("Queued turn delivery identity changed");
		const indexed: IndexedRuntimeRequest = {
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			operationId: identity.operationId,
			queueItemId: draft.queueItemId,
		};
		let operationAccepted = false;
		let turnStarted = false;
		try {
			this._session.sessionManager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: identity.operationId,
				requestId: identity.requestId,
				requestHash: identity.requestHash,
				kind: input.delivery === "steer" ? "steer" : "next_turn",
				state: "accepted",
				input: draft.input,
			});
			operationAccepted = true;
			this.requestIndex.set(identity.requestId, indexed);
			this.operationIndex.set(identity.operationId, indexed);
			if (input.delivery === "steer") {
				this._session.enqueueAcceptedDurablePrompt(draft.input, identity, "steer", draft.queueItemId);
				return { operationId: identity.operationId, queueItemId: draft.queueItemId, status: "accepted" };
			}

			const session = this._session;
			const turnId = session.beginDurableQueuedTurn(identity, draft.input, draft.queueItemId);
			turnStarted = true;
			indexed.turnId = turnId;
			this.trackAcceptedTask(turnId, session, async () => {
				try {
					const state = await session.runAcceptedDurablePrompt(turnId, draft.input);
					this.afterQueuedTurnSettled(session, state);
				} catch (error) {
					this.afterQueuedTurnSettled(session, "interrupted");
					throw error;
				}
			});
			return { operationId: identity.operationId, queueItemId: draft.queueItemId, turnId, status: "accepted" };
		} catch (error) {
			if (operationAccepted && !turnStarted) {
				this._session.sessionManager.appendRuntimeControl({
					type: "runtime_operation",
					operationId: identity.operationId,
					requestId: identity.requestId,
					requestHash: identity.requestHash,
					kind: input.delivery === "steer" ? "steer" : "next_turn",
					state: "interrupted",
					error: { code: "ADMISSION_FAILED", message: "The queued turn could not be scheduled." },
				});
			}
			if (!turnStarted) {
				this.queuedTurnQueue.pause(draft.queueItemId, "delivery_failed");
				this.emitQueuedTurns();
			}
			throw error;
		}
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			const session = this._session;
			await session.waitForIdle();
			await this.drainAcceptedTasks();
			if (session !== this._session) continue;
			if (
				!this.queuedTurnDrainTask &&
				!this.disposeRequested &&
				!this.disposed &&
				this.queuedTurnQueue.firstQueued()
			) {
				this.scheduleQueuedTurnDrain(session);
			}
			const drain = this.queuedTurnDrainTask;
			if (!drain) return;
			await drain;
		}
	}

	async submitPrompt(input: SubmitPromptInput): Promise<SubmitPromptResult> {
		this.assertPubliclyAccessible();
		if (!this.submissionGateOpen) throw new Error(RUNTIME_DISPOSING_ERROR);

		const submission = parseDurablePromptSubmission(input);
		const identity = identifySubmitPromptRequest(submission.requestId, submission.input);
		const existing = this.requestIndex.get(submission.requestId);
		if (existing) {
			if (existing.requestHash !== identity.requestHash) throw new RequestIdReusedError(submission.requestId);
			return {
				operationId: existing.operationId,
				...(existing.queueItemId === undefined ? {} : { queueItemId: existing.queueItemId }),
				...(existing.turnId === undefined ? {} : { turnId: existing.turnId }),
				status: "existing",
			};
		}

		const queued = this._session.activeDurableTurnId !== undefined || this._session.isStreaming;
		if (queued && submission.input.streamingBehavior === undefined) {
			throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp').");
		}
		this._session.assertCanDrainAgentEventPersistence();
		this._session.assertDurablePromptCapacity(submission.input);
		this._session.prepareDurablePrompt(submission.input);
		let accepted = false;
		let queueDurable = false;
		let turnStarted = false;
		const indexed: IndexedRuntimeRequest = {
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			operationId: identity.operationId,
		};
		try {
			this._session.sessionManager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: identity.operationId,
				requestId: identity.requestId,
				requestHash: identity.requestHash,
				kind: queued ? "steer" : "turn",
				state: "accepted",
				input: submission.input,
			});
			accepted = true;
			this.requestIndex.set(identity.requestId, indexed);
			this.operationIndex.set(identity.operationId, indexed);

			if (queued) {
				const behavior = submission.input.streamingBehavior!;
				const queue = behavior === "followUp" ? "follow_up" : "steer";
				this._session.sessionManager.appendRuntimeControl({
					type: "runtime_queue",
					operationId: identity.operationId,
					queueItemId: identity.queueItemId,
					queue,
					state: "enqueued",
					input: submission.input,
				});
				queueDurable = true;
				indexed.queueItemId = identity.queueItemId;
				this._session.enqueueAcceptedDurablePrompt(submission.input, identity, behavior);
				return { operationId: identity.operationId, queueItemId: identity.queueItemId, status: "accepted" };
			}

			const session = this._session;
			const predecessors = [...this.acceptedTasks];
			session.beginDurableDirectTurn(identity, submission.input);
			turnStarted = true;
			this.trackAcceptedTask(identity.turnId, session, async () => {
				await Promise.all(predecessors);
				try {
					const state = await session.runAcceptedDurablePrompt(identity.turnId, submission.input);
					this.afterQueuedTurnSettled(session, state);
				} catch (error) {
					this.afterQueuedTurnSettled(session, "interrupted");
					throw error;
				}
			});
			return { operationId: identity.operationId, turnId: identity.turnId, status: "accepted" };
		} catch (error) {
			if (!accepted) throw error;
			try {
				if (queueDurable) {
					this._session.sessionManager.appendRuntimeControl({
						type: "runtime_queue",
						operationId: identity.operationId,
						queueItemId: identity.queueItemId,
						queue: submission.input.streamingBehavior === "followUp" ? "follow_up" : "steer",
						state: "cancelled",
						reason: "admission_failed",
					});
				}
				if (turnStarted) {
					this._session.sessionManager.appendRuntimeControl({
						type: "runtime_turn",
						turnId: identity.turnId,
						operationIds: [identity.operationId],
						state: "interrupted",
						consumedQueueItemIds: [],
					});
				}
				this._session.sessionManager.appendRuntimeControl({
					type: "runtime_operation",
					operationId: identity.operationId,
					requestId: identity.requestId,
					requestHash: identity.requestHash,
					kind: queued ? "steer" : "turn",
					state: "interrupted",
					...(turnStarted ? { turnId: identity.turnId } : {}),
					error: { code: "ADMISSION_FAILED", message: "The accepted prompt could not be scheduled." },
				});
			} catch (compensationError) {
				this.submissionDisabled = true;
				this.submissionGateOpen = false;
				this._diagnostics = [
					...this._diagnostics,
					{ type: "error", message: "Durable prompt admission failed; new submissions are disabled." },
				];
				throw new AggregateError([error, compensationError], "Prompt acceptance could not be compensated");
			}
			throw error;
		}
	}

	/** Durably accept an interrupt, settle active work, then rebuild clean runtime state. */
	interrupt(input: SubmitInterruptInput): Promise<SubmitInterruptResult> {
		return this.enqueueLifecycle(() => this.interruptOnce(input));
	}

	private async interruptOnce(input: SubmitInterruptInput): Promise<SubmitInterruptResult> {
		this.assertPubliclyAccessible();
		const identity = identifyRuntimeRequest("interrupt", input.requestId, {});
		const existing = this.requestIndex.get(input.requestId);
		if (existing) {
			if (existing.requestHash !== identity.requestHash) throw new RequestIdReusedError(input.requestId);
			return { operationId: existing.operationId, status: "existing" };
		}

		const session = this._session;
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Durable interrupt requires a persisted session");
		const previousCwd = session.sessionManager.getCwd();
		const indexed: IndexedRuntimeRequest = {
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			operationId: identity.operationId,
		};
		session.sessionManager.appendRuntimeControl({
			type: "runtime_operation",
			operationId: identity.operationId,
			requestId: identity.requestId,
			requestHash: identity.requestHash,
			kind: "interrupt",
			state: "accepted",
		});
		this.requestIndex.set(identity.requestId, indexed);
		this.operationIndex.set(identity.operationId, indexed);

		let interruptError: unknown;
		try {
			await session.abortAndDrainAgentEventPersistence();
			await this.drainAcceptedTasks();
			session.sessionManager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: identity.operationId,
				requestId: identity.requestId,
				requestHash: identity.requestHash,
				kind: "interrupt",
				state: "completed",
			});
		} catch (error) {
			interruptError = error;
			try {
				session.sessionManager.appendRuntimeControl({
					type: "runtime_operation",
					operationId: identity.operationId,
					requestId: identity.requestId,
					requestHash: identity.requestHash,
					kind: "interrupt",
					state: "interrupted",
					error: { code: "INTERRUPT_FAILED", message: "The accepted interrupt did not settle cleanly." },
				});
			} catch (compensationError) {
				throw this.enterTerminalState(
					"Agent session runtime is unusable after interrupt compensation failed",
					new AggregateError([error, compensationError], "Interrupt could not be compensated"),
				);
			}
		}

		let teardownError: unknown;
		try {
			teardownError = await this.replaceCurrentInPlace(
				sessionFile,
				() => SessionManager.open(sessionFile, undefined, previousCwd),
				"resume",
				(sessionManager) => ({
					cwd: sessionManager.getCwd(),
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: sessionFile },
				}),
			);
			await this.finishReplacement(teardownError);
		} catch (error) {
			if (interruptError === undefined) throw error;
			throw new AggregateError([interruptError, error], "Interrupt and runtime recovery failed");
		}
		if (interruptError !== undefined) throw interruptError;
		return { operationId: identity.operationId, status: "accepted" };
	}

	private trackAcceptedTask(turnId: string, session: AgentSession, task: () => Promise<void>): void {
		const context = { owner: this, active: true };
		const accepted = Promise.resolve()
			.then(() =>
				acceptedPromptTaskContext.run(context, async () => {
					try {
						await task();
					} finally {
						context.active = false;
					}
				}),
			)
			.catch(() => {
				if (session.activeDurableTurnId === turnId) {
					this.submissionDisabled = true;
					this.submissionGateOpen = false;
					this._diagnostics = [
						...this._diagnostics,
						{
							type: "error",
							message:
								"Durable prompt finalization failed; new submissions are disabled until session recovery.",
						},
					];
					return;
				}
				this._diagnostics = [
					...this._diagnostics,
					{ type: "warning", message: "An accepted prompt did not complete; its durable state was preserved." },
				];
			});
		this.acceptedTasks.add(accepted);
		void accepted.then(() => this.acceptedTasks.delete(accepted));
	}

	private emitQueuedTurns(): void {
		if (this.queuedTurnListeners.size === 0) return;
		const turns = this.queuedTurnQueue.list();
		for (const listener of this.queuedTurnListeners) listener(structuredClone(turns));
	}

	private afterQueuedTurnSettled(session: AgentSession, state: "completed" | "interrupted"): void {
		if (session !== this._session || this.disposeRequested || this.disposed) return;
		if (state === "completed") {
			this.scheduleQueuedTurnDrain(session);
			return;
		}
		this.queuedTurnQueue.pauseUndispatched("turn_interrupted");
		this.emitQueuedTurns();
	}

	private scheduleQueuedTurnDrain(session: AgentSession): void {
		if (this.queuedTurnDrainTask || session !== this._session || this.disposeRequested || this.disposed) return;
		let task!: Promise<void>;
		task = this.drainQueuedTurns(session)
			.catch((error) => {
				if (error instanceof QueuedTurnBusyError || error instanceof QueuedTurnConflictError) return;
				this._diagnostics = [
					...this._diagnostics,
					{
						type: "warning",
						message: `Automatic queued turn failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				];
			})
			.finally(() => {
				if (this.queuedTurnDrainTask !== task) return;
				this.queuedTurnDrainTask = undefined;
				if (session !== this._session || this.disposeRequested || this.disposed) return;
				// A very fast queued turn can settle before this delivery task's
				// finally handler runs. Re-arm here so the next FIFO item is not stranded.
				if (this.queuedTurnQueue.firstQueued()) this.scheduleQueuedTurnDrain(session);
			});
		this.queuedTurnDrainTask = task;
	}

	private async drainQueuedTurns(session: AgentSession): Promise<void> {
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
		await session.waitForIdle();
		if (session !== this._session || this.disposeRequested || this.disposed || session.isCompacting) return;
		const next = this.queuedTurnQueue.firstQueued();
		if (!next) return;
		await this.sendQueuedTurn({
			queueItemId: next.queueItemId,
			expectedRevision: next.revision,
			delivery: "start",
		});
	}

	private async drainAcceptedTasks(): Promise<void> {
		while (this.acceptedTasks.size > 0) await Promise.all([...this.acceptedTasks]);
	}

	private assertUsable(): void {
		if (this.terminalError) throw this.terminalError;
	}

	private assertPubliclyAccessible(): void {
		const context = lifecycleOperationContext.getStore();
		const insideAcceptedLifecycle = context?.owner === this && context.active;
		if ((this.disposeRequested || this.disposed) && !insideAcceptedLifecycle) {
			throw new Error(RUNTIME_DISPOSING_ERROR);
		}
		this.assertUsable();
	}

	private enterTerminalState(message: string, cause: unknown): AgentSessionRuntimeTerminalError {
		const error = new AgentSessionRuntimeTerminalError(message, cause);
		this.terminalError = error;
		return error;
	}

	private assertNotInLifecycleOperation(): void {
		const context = lifecycleOperationContext.getStore();
		if (context?.owner === this && context.active) {
			throw new Error(REENTRANT_LIFECYCLE_ERROR);
		}
		const acceptedContext = acceptedPromptTaskContext.getStore();
		if (acceptedContext?.owner === this && acceptedContext.active) {
			throw new Error(ACCEPTED_PROMPT_LIFECYCLE_ERROR);
		}
	}

	private runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
		const context = { owner: this, active: true };
		return lifecycleOperationContext.run(context, async () => {
			try {
				return await operation();
			} finally {
				// Async work spawned by a completed hook inherits the store. Marking the
				// shared context inactive prevents those later tasks from being rejected.
				context.active = false;
			}
		});
	}

	private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposeRequested) {
			return Promise.reject(new Error(RUNTIME_DISPOSING_ERROR));
		}
		try {
			this.assertUsable();
			this.assertNotInLifecycleOperation();
			this._session.assertCanDrainAgentEventPersistence();
		} catch (error) {
			return Promise.reject(error);
		}
		this.pendingLifecycleOperations += 1;
		this.submissionGateOpen = false;
		const result = this.lifecycleTail.then(() =>
			this.runLifecycleOperation(async () => {
				// A previously queued replacement may have put the runtime into a
				// terminal state or installed a different session since this call was accepted.
				this.assertUsable();
				this._session.assertCanDrainAgentEventPersistence();
				return operation();
			}),
		);
		this.lifecycleTail = result.then(
			() => undefined,
			() => undefined,
		);
		void result.then(
			() => this.releaseLifecycleAdmission(),
			() => this.releaseLifecycleAdmission(),
		);
		return result;
	}

	private releaseLifecycleAdmission(): void {
		this.pendingLifecycleOperations -= 1;
		if (
			this.pendingLifecycleOperations === 0 &&
			!this.disposeRequested &&
			!this.disposed &&
			!this.terminalError &&
			!this.submissionDisabled
		) {
			this.submissionGateOpen = true;
		}
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		const session = this._session;
		session.beginRuntimeTeardown();
		this.pendingSubagentContinuationIds.clear();
		this.attemptedSubagentContinuationIds.clear();
		this.submissionGateOpen = false;
		const errors: unknown[] = [];
		try {
			await this.subagentManagerValue?.unload("parent_unloaded");
		} catch (error) {
			errors.push(error);
		}
		this.subagentManagerValue = undefined;
		try {
			session.abortCompaction();
		} catch (error) {
			errors.push(error);
		}
		try {
			await session.abortAndDrainAgentEventPersistence();
		} catch (error) {
			errors.push(error);
		}
		try {
			await this.drainAcceptedTasks();
		} catch (error) {
			errors.push(error);
		}
		try {
			recoverSessionManager(session.sessionManager);
		} catch (error) {
			errors.push(error);
		}
		try {
			await session.waitForDream();
		} catch (error) {
			errors.push(error);
		}
		try {
			await emitSessionShutdownEvent(session.extensionRunner, {
				type: "session_shutdown",
				reason,
				targetSessionFile,
			});
		} catch (error) {
			errors.push(error);
		}
		try {
			await session.disposeInteractiveExecution();
		} catch (error) {
			errors.push(error);
		}
		try {
			this.beforeSessionInvalidate?.();
		} catch (error) {
			errors.push(error);
		}
		try {
			session.disposeFromRuntime();
		} catch (error) {
			errors.push(error);
			try {
				session.disposeFromRuntime();
			} catch (retryError) {
				errors.push(retryError);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to tear down agent session");
	}

	private async apply(prepared: PreparedRuntime): Promise<void> {
		this._session = prepared.result.session;
		this._services = prepared.result.services;
		this._diagnostics = prepared.result.diagnostics;
		this._modelFallbackMessage = prepared.result.modelFallbackMessage;
		this._recoverableDrafts = prepared.recovered.recoverableDrafts;
		this.requestIndex = prepared.recovered.requests;
		this.operationIndex = prepared.recovered.operations;
		this.queuedTurnQueue = new QueuedTurnQueue(prepared.result.session.sessionManager);
		this.submissionDisabled = false;
		this.bindDurableSession(prepared.result.session);
		this.bindSubagents(prepared.result.session);
		await this.subagentManagerValue?.recoverCloseMarkers();
		this.emitQueuedTurns();
	}

	private async prepareCandidate(
		sessionManager: SessionManager,
		getOptions: () => CandidateRuntimeOptions,
	): Promise<PreparedRuntime> {
		try {
			const recovered = recoverSessionManager(sessionManager);
			const result = await this.createRuntime({
				...getOptions(),
				agentDir: this._services.agentDir,
				sessionManager,
				ultraAvailable: true,
			});
			return { result, recovered };
		} catch (error) {
			closeUnadoptedSessionManager(sessionManager, error, "Failed to create and clean up replacement session");
		}
	}

	private async replaceCurrent(
		sessionManager: SessionManager,
		reason: SessionShutdownEvent["reason"],
		getOptions: () => CandidateRuntimeOptions,
	): Promise<unknown | undefined> {
		// Gate A made runtime services independent, so prepare a different target
		// before invalidating the current session. Factory failure is then harmless.
		const result = await this.prepareCandidate(sessionManager, getOptions);
		let teardownError: unknown;
		try {
			await this.teardownCurrent(reason, sessionManager.getSessionFile());
		} catch (error) {
			teardownError = error;
		}
		await this.apply(result);
		return teardownError;
	}

	private async replaceCurrentInPlace(
		previousSessionFile: string,
		createSessionManager: () => SessionManager,
		reason: SessionShutdownEvent["reason"],
		getOptions: (sessionManager: SessionManager) => CandidateRuntimeOptions,
	): Promise<unknown | undefined> {
		const previousCwd = this._services.cwd;
		let teardownError: unknown;
		try {
			await this.teardownCurrent(reason, previousSessionFile);
		} catch (error) {
			teardownError = error;
		}

		try {
			const sessionManager = createSessionManager();
			const result = await this.prepareCandidate(sessionManager, () => getOptions(sessionManager));
			await this.apply(result);
			return teardownError;
		} catch (replacementError) {
			const errors = teardownError === undefined ? [replacementError] : [teardownError, replacementError];
			try {
				const rollbackManager = SessionManager.open(previousSessionFile, undefined, previousCwd);
				try {
					assertSessionCwdExists(rollbackManager, previousCwd);
				} catch (error) {
					closeUnadoptedSessionManager(
						rollbackManager,
						error,
						"Failed to validate and clean up replacement rollback",
					);
				}
				const rollback = await this.prepareCandidate(rollbackManager, () => getOptions(rollbackManager));
				await this.apply(rollback);
				await this.rebindCurrentSession();
			} catch (rollbackError) {
				if (rollbackError instanceof AgentSessionRuntimeTerminalError) throw rollbackError;
				throw this.enterTerminalState(
					"Agent session runtime is unusable after replacement and rollback failed",
					new AggregateError([...errors, rollbackError], "Session replacement rollback failed"),
				);
			}
			if (errors.length === 1) throw errors[0];
			throw new AggregateError(errors, "Session replacement failed and the previous session was restored");
		}
	}

	private async rebindCurrentSession(): Promise<void> {
		if (this.rebindSession) {
			try {
				await this.rebindSession(this._session);
			} catch (error) {
				throw this.enterTerminalState("Agent session runtime is unusable after host rebinding failed", error);
			}
		}
	}

	private async finishReplacement(
		teardownError: unknown | undefined,
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>,
	): Promise<void> {
		await this.rebindCurrentSession();
		if (teardownError !== undefined) {
			this._diagnostics = [
				...this._diagnostics,
				{
					type: "warning",
					message: "The previous session did not shut down cleanly; the replacement session is active.",
				},
			];
		}
		if (withSession) {
			await withSession(this._session.createReplacedSessionContext());
		}
	}

	switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.enqueueLifecycle(() => this.switchSessionOnce(sessionPath, options));
	}

	private async switchSessionOnce(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const targetIsCurrent =
			previousSessionFile !== undefined && pathsReferToSameFile(resolvePath(sessionPath), previousSessionFile);

		let teardownError: unknown;
		if (targetIsCurrent) {
			teardownError = await this.replaceCurrentInPlace(
				previousSessionFile,
				() => {
					const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
					try {
						assertSessionCwdExists(sessionManager, this._services.cwd);
					} catch (error) {
						closeUnadoptedSessionManager(
							sessionManager,
							error,
							"Failed to validate and clean up resumed session",
						);
					}
					return sessionManager;
				},
				"resume",
				(sessionManager) => ({
					cwd: sessionManager.getCwd(),
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
					projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
				}),
			);
		} else {
			const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
			try {
				assertSessionCwdExists(sessionManager, this._services.cwd);
			} catch (error) {
				closeUnadoptedSessionManager(sessionManager, error, "Failed to validate and clean up resumed session");
			}
			teardownError = await this.replaceCurrent(sessionManager, "resume", () => ({
				cwd: sessionManager.getCwd(),
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}));
		}
		await this.finishReplacement(teardownError, options?.withSession);
		return { cancelled: false };
	}

	newSession(options?: {
		parentSession?: string;
		mode?: AgentMode;
		cwd?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.enqueueLifecycle(() => this.newSessionOnce(options));
	}

	private async newSessionOnce(options?: {
		parentSession?: string;
		mode?: AgentMode;
		cwd?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const currentManager = this.session.sessionManager;
		const mode = options?.mode ?? currentManager.getMode();
		const sessionId = createSessionId();
		const workspace = resolveNewSessionWorkspace({
			id: sessionId,
			mode,
			requestedCwd: options?.cwd,
			hostCwd: this.hostCwd,
			agentDir: this._services.agentDir,
		});
		let sessionManager: SessionManager;
		try {
			const reusesCurrentCwd = pathsReferToSameFile(workspace.cwd, currentManager.getCwd());
			const sessionDir =
				reusesCurrentCwd || !currentManager.usesDefaultSessionDir() ? currentManager.getSessionDir() : undefined;
			const newSessionOptions = {
				id: sessionId,
				parentSession: options?.parentSession,
				mode,
				cwdOrigin: workspace.cwdOrigin,
			} as const;
			sessionManager = currentManager.isPersisted()
				? SessionManager.create(workspace.cwd, sessionDir, newSessionOptions)
				: SessionManager.inMemory(workspace.cwd, newSessionOptions);
		} catch (error) {
			removeOwnedManagedWorkspace({
				id: sessionId,
				cwd: workspace.cwd,
				cwdOrigin: workspace.cwdOrigin,
				agentDir: this._services.agentDir,
			});
			throw error;
		}

		let teardownError: unknown;
		try {
			teardownError = await this.replaceCurrent(sessionManager, "new", () => ({
				cwd: workspace.cwd,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}));
		} catch (error) {
			const candidatePath = sessionManager.getSessionFile();
			if (candidatePath) await SessionManager.deleteSession(candidatePath, { agentDir: this._services.agentDir });
			removeOwnedManagedWorkspace({
				id: sessionId,
				cwd: workspace.cwd,
				cwdOrigin: workspace.cwdOrigin,
				agentDir: this._services.agentDir,
			});
			throw error;
		}
		let setupError: unknown;
		try {
			if (options?.setup) {
				await options.setup(this.session.sessionManager);
				this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
			}
		} catch (error) {
			setupError = error;
		}
		await this.finishReplacement(teardownError, setupError === undefined ? options?.withSession : undefined);
		if (setupError !== undefined) throw setupError;
		return { cancelled: false };
	}

	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.enqueueLifecycle(() => this.forkOnce(entryId, options));
	}

	private async forkOnce(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		const currentManager = this.session.sessionManager;
		const sessionManager = currentManager.createBranchedSessionManager(targetLeafId);

		const teardownError = await this.replaceCurrent(sessionManager, "fork", () => ({
			cwd: sessionManager.getCwd(),
			sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
		}));
		await this.finishReplacement(teardownError, options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.enqueueLifecycle(() => this.importFromJsonlOnce(inputPath, cwdOverride));
	}

	private async importFromJsonlOnce(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const targetIsCurrent =
			previousSessionFile !== undefined && pathsReferToSameFile(destinationPath, previousSessionFile);

		let teardownError: unknown;
		if (targetIsCurrent) {
			teardownError = await this.replaceCurrentInPlace(
				previousSessionFile,
				() => {
					const sessionManager = SessionManager.importFrom(resolvedPath, destinationPath, cwdOverride);
					try {
						assertSessionCwdExists(sessionManager, this._services.cwd);
					} catch (error) {
						closeUnadoptedSessionManager(
							sessionManager,
							error,
							"Failed to validate and clean up imported session",
						);
					}
					return sessionManager;
				},
				"resume",
				(sessionManager) => ({
					cwd: sessionManager.getCwd(),
					sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				}),
			);
		} else {
			const sessionManager = SessionManager.importFrom(resolvedPath, destinationPath, cwdOverride);
			try {
				assertSessionCwdExists(sessionManager, this._services.cwd);
			} catch (error) {
				closeUnadoptedSessionManager(sessionManager, error, "Failed to validate and clean up imported session");
			}
			teardownError = await this.replaceCurrent(sessionManager, "resume", () => ({
				cwd: sessionManager.getCwd(),
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}));
		}
		await this.finishReplacement(teardownError);
		return { cancelled: false };
	}

	private async disposeOnce(): Promise<void> {
		const session = this._session;
		session.beginRuntimeTeardown();
		const errors: unknown[] = [];
		try {
			await this.subagentManagerValue?.unload("parent_unloaded");
		} catch (error) {
			errors.push(error);
		}
		this.subagentManagerValue = undefined;
		if (!this.eventPersistenceDrained) {
			try {
				session.abortCompaction();
			} catch (error) {
				errors.push(error);
			}
			try {
				await session.abortAndDrainAgentEventPersistence();
			} catch (error) {
				errors.push(error);
			} finally {
				// Drain errors are reported after teardown. The drain itself has already settled,
				// so a retry must not re-run it or repeat shutdown hooks.
				this.eventPersistenceDrained = true;
			}
		}
		try {
			await this.drainAcceptedTasks();
		} catch (error) {
			errors.push(error);
		}
		if (!this.runtimeRecoveryAttempted && !this.terminalError) {
			try {
				recoverSessionManager(session.sessionManager);
			} catch (error) {
				errors.push(error);
			} finally {
				this.runtimeRecoveryAttempted = true;
			}
		}
		if (!this.shutdownAttempted) {
			this.shutdownAttempted = true;
			try {
				await session.waitForDream();
			} catch (error) {
				errors.push(error);
			}
			try {
				await emitSessionShutdownEvent(session.extensionRunner, {
					type: "session_shutdown",
					reason: "quit",
				});
			} catch (error) {
				errors.push(error);
			}
		}
		if (!this.beforeInvalidateAttempted) {
			try {
				await session.disposeInteractiveExecution();
			} catch (error) {
				errors.push(error);
			}
			this.beforeInvalidateAttempted = true;
			try {
				this.beforeSessionInvalidate?.();
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			session.disposeFromRuntime();
		} catch (error) {
			errors.push(error);
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose agent session runtime");
	}

	dispose(): Promise<void> {
		try {
			this.assertNotInLifecycleOperation();
			this._session.assertCanDrainAgentEventPersistence();
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.disposed) return Promise.resolve();
		if (this.disposePromise) return this.disposePromise;
		this._session.beginRuntimeTeardown();
		this.disposeRequested = true;
		this.pendingSubagentContinuationIds.clear();
		this.attemptedSubagentContinuationIds.clear();
		this.submissionGateOpen = false;
		const attempt = this.lifecycleTail.then(() => this.runLifecycleOperation(() => this.disposeOnce()));
		this.disposePromise = attempt;
		attempt.then(
			() => {
				this.disposed = true;
				if (this.disposePromise === attempt) this.disposePromise = undefined;
			},
			() => {
				if (this.disposePromise === attempt) this.disposePromise = undefined;
			},
		);
		return attempt;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		ultraAvailable?: boolean;
	},
): Promise<AgentSessionRuntime> {
	try {
		assertSessionCwdExists(options.sessionManager, options.cwd);
		const recovered = recoverSessionManager(options.sessionManager);
		const result = await createRuntime({ ...options, ultraAvailable: options.ultraAvailable ?? true });
		const runtime = new AgentSessionRuntime(
			result.session,
			result.services,
			createRuntime,
			result.diagnostics,
			result.modelFallbackMessage,
			recovered,
			options.cwd,
		);
		await runtime.initializeSubagents();
		return runtime;
	} catch (error) {
		closeUnadoptedSessionManager(
			options.sessionManager,
			error,
			"Failed to create and clean up agent session runtime",
		);
	}
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
