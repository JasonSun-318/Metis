import type { AgentMode, ClientResult, DomainEvent, PermissionPresetView, SessionSummary } from "@metis/app-protocol";
import { RPC_ERROR_CODES as ERROR_CODES } from "@metis/app-protocol";
import type { DesktopApiEvent, MetisDesktopApi, SupervisorView } from "../shared/desktop-api.ts";
import { type ConversationSubmission, composerPayload, composerRequestKey } from "./composer-submission.ts";
import { rpcErrorCode, shouldReuseMutationRequest } from "./rpc-error.ts";
import type { AppStore, AppStoreSnapshot } from "./store/app-store.ts";
import {
	loadProjectPreferences,
	type ProjectPreferenceMap,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "./store/project-preferences.ts";
import { loadSessionPins, saveSessionPins, setSessionPinned } from "./store/session-pins.ts";

type SessionWorkspaceApi = Partial<Pick<MetisDesktopApi, "setModel" | "setThinkingSelection">> &
	Pick<
		MetisDesktopApi,
		| "createSession"
		| "deleteProject"
		| "deleteSession"
		| "forkSession"
		| "getServerState"
		| "listSessions"
		| "markSessionRead"
		| "openSession"
		| "focusSession"
		| "subscribeSession"
		| "previewProjectDelete"
		| "renameSession"
		| "selectProjectFolder"
		| "startTurn"
		| "subscribe"
	>;

export interface NewTaskDraft {
	readonly mode: AgentMode;
	readonly folder: string | null;
	readonly sessionId: string | null;
	readonly permissionPreset: PermissionPresetView;
}

export interface SessionWorkspaceError {
	readonly operation: string;
	readonly reason: string;
	readonly retryable: boolean;
	readonly cause: unknown;
}

export interface SessionWorkspaceSnapshot {
	readonly version: number;
	readonly mode: AgentMode;
	readonly draft: NewTaskDraft | null;
	readonly draftBusy: boolean;
	readonly draftCreatePending: boolean;
	readonly bootstrapped: boolean;
	readonly openingSessionId: string | null;
	readonly busyProjectKeys: ReadonlySet<string>;
	readonly projectPreferences: ProjectPreferenceMap;
	readonly pinnedSessionIds: ReadonlySet<string>;
	readonly dirtySessionIds: ReadonlySet<string>;
	readonly cleanupSessionIds: readonly string[];
	readonly message: string;
	readonly failure: SessionWorkspaceError | null;
}

export interface SessionWorkspaceWorkflowOptions {
	readonly api: SessionWorkspaceApi;
	readonly store: AppStore;
	readonly storage: Pick<Storage, "getItem" | "removeItem" | "setItem">;
	readonly onDesktopEvent?: (event: DesktopApiEvent) => void;
	readonly getVisibleSessionId?: () => string | null;
	readonly requestId?: () => string;
}

export interface SessionProjectTarget {
	readonly mode: AgentMode;
	readonly cwd: string;
}

function activeSessionKey(mode: AgentMode): string {
	return `metis.activeSessionId.${mode}`;
}

function emptyDraft(mode: AgentMode): NewTaskDraft {
	return { mode, folder: null, sessionId: null, permissionPreset: "auto" };
}

function failure(operation: string, cause: unknown): SessionWorkspaceError {
	return {
		operation,
		reason: cause instanceof Error ? cause.message : "Metis could not complete the request.",
		retryable: true,
		cause,
	};
}

function projectFailure(operation: string, cause: unknown): SessionWorkspaceError {
	const code = rpcErrorCode(cause);
	const reason =
		code === ERROR_CODES.BUSY
			? "The project changed or is busy. Load a fresh preview and retry."
			: code === ERROR_CODES.SESSION_IN_USE
				? "A project session is still in use. Close it and retry."
				: code === ERROR_CODES.SESSION_CORRUPT
					? "A project session is corrupt or ambiguous. Nothing was removed."
					: code === ERROR_CODES.SCHEDULE_STORE_CORRUPT
						? "Scheduled tasks could not be checked safely. Repair them before retrying."
						: code === ERROR_CODES.OPERATION_FAILED
							? "The project could not be moved to Trash. Nothing was permanently deleted."
							: cause instanceof Error
								? cause.message
								: "The project operation could not be completed.";
	return { operation, reason, retryable: true, cause };
}

function sessionFailure(operation: "delete-session" | "rename-session", cause: unknown): SessionWorkspaceError {
	const code = rpcErrorCode(cause);
	const reason =
		code === ERROR_CODES.SESSION_IN_USE
			? "This session is still running or waiting for input."
			: code === ERROR_CODES.READ_ONLY_SESSION
				? "Scheduled sessions are read-only."
				: code === ERROR_CODES.OPERATION_FAILED
					? operation === "delete-session"
						? "The session could not be moved to Trash."
						: "The session could not be renamed."
					: cause instanceof Error
						? cause.message
						: "The session operation could not be completed.";
	return { operation, reason, retryable: true, cause };
}

export function sessionProjectKey(mode: AgentMode, cwd: string): string {
	return JSON.stringify([mode, cwd]);
}

export function shouldResnapshotAfterReady(before: AppStoreSnapshot, next: SupervisorView): boolean {
	return (
		next.state === "ready" &&
		before.activeSessionId !== null &&
		(before.supervisor.state !== "ready" || before.serverEpoch !== next.serverEpoch)
	);
}

export class SessionWorkspaceWorkflow {
	private readonly api: SessionWorkspaceApi;
	private readonly store: AppStore;
	private readonly storage: SessionWorkspaceWorkflowOptions["storage"];
	private readonly onDesktopEvent: SessionWorkspaceWorkflowOptions["onDesktopEvent"];
	private readonly getVisibleSessionId: SessionWorkspaceWorkflowOptions["getVisibleSessionId"];
	private readonly requestId: () => string;
	private readonly listeners = new Set<() => void>();
	private readonly resnapshots = new Map<string, Promise<void>>();
	private readonly markReadRequests = new Map<string, Promise<void>>();
	private readonly projectCreateRequests = new Map<string, { requestId: string; promise?: Promise<void> }>();
	private readonly projectDeleteRequests = new Map<
		string,
		{ requestId: string; revision: string; promise?: Promise<void> }
	>();
	private readonly sessionRenameRequests = new Map<string, { name: string; requestId: string }>();
	private readonly sessionDeleteRequests = new Map<string, { requestId: string; promise?: Promise<void> }>();
	private readonly sessionForkRequests = new Map<
		string,
		{ requestId: string; promise?: Promise<SessionSummary | undefined> }
	>();
	private newTaskCreateRequest: { key: string; requestId: string } | null = null;
	private newTaskTurnRequest: { key: string; requestId: string } | null = null;
	private readonly liveSessions = new Set<string>();
	private readonly liveSubscriptions = new Map<string, Promise<void>>();
	private unsubscribe: (() => void) | null = null;
	private startRequest: Promise<void> | null = null;
	private lifecycleGeneration = 0;
	private openGeneration = 0;
	private intentGeneration = 0;
	private sessionListGeneration = 0;
	private disposed = false;
	private state: SessionWorkspaceSnapshot;

	constructor(options: SessionWorkspaceWorkflowOptions) {
		this.api = options.api;
		this.store = options.store;
		this.storage = options.storage;
		this.onDesktopEvent = options.onDesktopEvent;
		this.getVisibleSessionId = options.getVisibleSessionId;
		this.requestId = options.requestId ?? (() => crypto.randomUUID());
		this.state = {
			version: 0,
			mode: "chat",
			draft: emptyDraft("chat"),
			draftBusy: false,
			draftCreatePending: false,
			bootstrapped: false,
			openingSessionId: null,
			busyProjectKeys: new Set(),
			projectPreferences: loadProjectPreferences(this.storage),
			pinnedSessionIds: loadSessionPins(this.storage),
			dirtySessionIds: new Set(),
			cleanupSessionIds: [],
			message: "Starting Metis…",
			failure: null,
		};
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly getSnapshot = (): SessionWorkspaceSnapshot => this.state;

	dismissFailure(): void {
		this.commit({ failure: null });
	}

	start(): Promise<void> {
		if (this.startRequest) return this.startRequest;
		if (this.unsubscribe) return Promise.resolve();
		this.disposed = false;
		this.commit({
			draftBusy: false,
			openingSessionId: null,
			busyProjectKeys: new Set(),
		});
		const lifecycle = ++this.lifecycleGeneration;
		this.unsubscribe = this.api.subscribe((event) => {
			if (!this.isCurrentLifecycle(lifecycle)) return;
			this.handleDesktopEvent(event);
			this.onDesktopEvent?.(event);
		});
		let pending!: Promise<void>;
		pending = this.bootstrap(lifecycle).finally(() => {
			if (this.startRequest === pending) this.startRequest = null;
		});
		this.startRequest = pending;
		return pending;
	}

	dispose(): void {
		this.disposed = true;
		this.lifecycleGeneration += 1;
		this.openGeneration += 1;
		this.sessionListGeneration += 1;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.startRequest = null;
		this.resnapshots.clear();
		this.markReadRequests.clear();
		this.liveSubscriptions.clear();
		this.liveSessions.clear();
		this.projectCreateRequests.clear();
		this.projectDeleteRequests.clear();
		this.sessionRenameRequests.clear();
		this.sessionDeleteRequests.clear();
		this.sessionForkRequests.clear();
		this.clearDraftRequests();
	}

	async openSession(sessionId: string): Promise<void> {
		const projectionBeforeOpen = this.store.getSnapshot();
		const generation = ++this.openGeneration;
		const lifecycle = this.lifecycleGeneration;
		this.invalidateSessionLists();
		this.commit({ openingSessionId: sessionId, failure: null });
		// A live bucket that is already ready only needs focus: no subscribing
		// flag and no snapshot rebuild, so the pane never flashes. The broker
		// moves focus and releases hidden sessions without building a snapshot.
		const ready =
			projectionBeforeOpen.activeSessionId !== sessionId &&
			projectionBeforeOpen.sessions.get(sessionId)?.syncStatus === "ready";
		let subscription = ready ? null : this.store.beginSubscription(sessionId);
		try {
			let session: SessionSummary | undefined;
			if (subscription === null) {
				// A conflict means the broker no longer streams this session; any other
				// failure is a real open failure and surfaces like one.
				const focused = await this.api.focusSession({ sessionId }).then(
					() => true,
					(cause: unknown) => {
						if (rpcErrorCode(cause) === ERROR_CODES.CONFLICT) return false;
						throw cause;
					},
				);
				if (!this.isCurrentOpen(generation, lifecycle)) return;
				// The bucket may have left the ready state while focus moved; then open it fully.
				if (focused && this.store.activateProjection(sessionId)) {
					session = this.store.getSnapshot().sessionsById.get(sessionId);
				}
			}
			if (!session) {
				// Claiming a bucket that a live resubscribe still holds keeps its buffered events.
				subscription ??= this.store.beginSubscription(sessionId);
				const snapshot = await this.api.openSession({ sessionId });
				if (!this.isCurrentOpen(generation, lifecycle)) {
					this.store.cancelSubscription(sessionId, subscription);
					return;
				}
				this.store.applySnapshot(snapshot);
				session = snapshot.session;
			}
			this.invalidateSessionLists();
			this.reconcileLiveSessions();
			if (session.unread) await this.markSessionRead(sessionId);
			if (!this.isCurrentOpen(generation, lifecycle)) return;
			this.writeRememberedSession(session.mode, sessionId);
			this.commit({ mode: session.mode, message: "Session ready" });
		} catch (cause) {
			if (subscription !== null) this.store.cancelSubscription(sessionId, subscription);
			if (this.isCurrentOpen(generation, lifecycle)) {
				await this.recoverProjectionAfterFailedOpen(projectionBeforeOpen, generation, lifecycle);
				this.commit({ failure: failure("open-session", cause) });
			}
			throw cause;
		} finally {
			if (this.isCurrentOpen(generation, lifecycle)) this.commit({ openingSessionId: null });
		}
	}

	async openVisibleSession(sessionId: string): Promise<void> {
		this.clearDraftRequests();
		const intent = this.intentGeneration;
		const lifecycle = this.lifecycleGeneration;
		if (!(await this.openSessionForIntent(sessionId, intent, lifecycle))) return;
		if (!this.isCurrentIntent(intent, lifecycle)) return;
		this.commit({ draft: null, draftCreatePending: false });
	}

	resnapshotSession(sessionId: string): Promise<void> {
		if (this.store.getSnapshot().activeSessionId === sessionId) return this.requestResnapshot(sessionId);
		// A non-active bucket resyncs through the live-session reconcile loop
		// instead of a focus-changing open.
		if (this.store.getSnapshot().sessions.get(sessionId)?.syncStatus === "ready") {
			this.store.requireProjectionResnapshot(sessionId);
			this.reconcileLiveSessions();
		}
		return Promise.resolve();
	}

	readonly setLiveSessions = (sessionIds: readonly string[]): void => {
		this.liveSessions.clear();
		for (const sessionId of sessionIds) this.liveSessions.add(sessionId);
		this.reconcileLiveSessions();
	};

	private reconcileLiveSessions(): void {
		const snapshot = this.store.getSnapshot();
		for (const sessionId of this.liveSessions) {
			if (sessionId === snapshot.activeSessionId) continue;
			const bucket = snapshot.sessions.get(sessionId);
			if (!bucket || bucket.syncStatus === "resnapshot_required") this.subscribeLive(sessionId);
		}
		for (const [sessionId, bucket] of snapshot.sessions) {
			if (
				sessionId === snapshot.activeSessionId ||
				this.liveSessions.has(sessionId) ||
				bucket.syncStatus === "subscribing"
			) {
				continue;
			}
			this.store.dropProjection(sessionId);
		}
	}

	private subscribeLive(sessionId: string): void {
		if (!this.liveSessions.has(sessionId) || this.liveSubscriptions.has(sessionId)) return;
		const lifecycle = this.lifecycleGeneration;
		const token = this.store.beginSubscription(sessionId, { focus: false });
		let pending!: Promise<void>;
		pending = this.api
			.subscribeSession({ sessionId })
			.then((snapshot) => {
				if (!this.isCurrentLifecycle(lifecycle)) return;
				const bucket = this.store.getSnapshot().sessions.get(sessionId);
				if (
					this.liveSessions.has(sessionId) &&
					bucket?.syncStatus === "subscribing" &&
					bucket.subscriptionToken === token
				) {
					this.store.applySnapshot(snapshot);
					return;
				}
				this.store.cancelSubscription(sessionId, token);
			})
			.catch(() => {
				if (this.isCurrentLifecycle(lifecycle)) this.store.cancelSubscription(sessionId, token);
			})
			.finally(() => {
				if (this.liveSubscriptions.get(sessionId) === pending) this.liveSubscriptions.delete(sessionId);
			});
		this.liveSubscriptions.set(sessionId, pending);
	}

	async selectMode(mode: AgentMode): Promise<void> {
		this.openGeneration += 1;
		this.clearDraftRequests();
		const intent = this.intentGeneration;
		const lifecycle = this.lifecycleGeneration;
		this.commit({ mode, failure: null, draftBusy: false, draftCreatePending: false });
		const remembered = this.readRememberedSession(mode);
		if (remembered && this.store.getSnapshot().sessionsById.has(remembered)) {
			try {
				if (!(await this.openSessionForIntent(remembered, intent, lifecycle))) return;
				this.commit({ draft: null, draftCreatePending: false });
				return;
			} catch {
				if (!this.isCurrentIntent(intent, lifecycle)) return;
				// Keep the selected mode usable by falling back to a fresh draft.
			}
		}
		if (!this.isCurrentIntent(intent, lifecycle)) return;
		this.commit({ draft: emptyDraft(mode), message: `Start a new ${mode === "chat" ? "Chat" : "Code"} task` });
	}

	startNewTask(mode: AgentMode = this.state.mode): void {
		this.openGeneration += 1;
		this.clearDraftRequests();
		this.commit({
			mode,
			draft: emptyDraft(mode),
			draftBusy: false,
			draftCreatePending: false,
			openingSessionId: null,
			failure: null,
		});
	}

	cancelNewTask(): void {
		this.openGeneration += 1;
		this.clearDraftRequests();
		this.commit({ draft: null, draftBusy: false, draftCreatePending: false, failure: null });
	}

	setDraftFolder(folder: string | null): void {
		if (!this.state.draft || this.state.draft.sessionId) return;
		this.commit({ draft: { ...this.state.draft, folder } });
	}

	setDraftPermission(permissionPreset: PermissionPresetView): void {
		if (!this.state.draft || this.state.draft.sessionId) return;
		this.commit({ draft: { ...this.state.draft, permissionPreset } });
	}

	async chooseDraftFolder(): Promise<void> {
		const mode = this.state.draft?.mode;
		if (!mode) return;
		const lifecycle = this.lifecycleGeneration;
		const intent = this.intentGeneration;
		this.commit({ draftBusy: true, failure: null });
		try {
			const folder = await this.api.selectProjectFolder();
			if (!this.isCurrentIntent(intent, lifecycle)) return;
			if (folder && this.state.draft?.mode === mode && this.state.draft.sessionId === null) {
				this.setDraftFolder(folder);
			}
		} catch (cause) {
			if (!this.isCurrentIntent(intent, lifecycle)) return;
			this.commit({ failure: failure("choose-project-folder", cause) });
			throw cause;
		} finally {
			if (this.isCurrentIntent(intent, lifecycle)) this.commit({ draftBusy: false });
		}
	}

	private async createDraftSession(
		draft: NewTaskDraft,
		sessionName: string | undefined,
		intent: number,
		lifecycle: number,
	): Promise<string | null> {
		let sessionId = draft.sessionId;
		if (!sessionId) {
			const createKey = JSON.stringify({
				mode: draft.mode,
				cwd: draft.folder,
				name: sessionName ?? null,
				permissionPreset: draft.permissionPreset,
			});
			const request =
				this.newTaskCreateRequest?.key === createKey
					? this.newTaskCreateRequest
					: { key: createKey, requestId: this.requestId() };
			this.newTaskCreateRequest = request;
			this.commit({ draftCreatePending: true });
			const created = await this.api.createSession({
				requestId: request.requestId,
				mode: draft.mode,
				...(draft.folder ? { cwd: draft.folder } : {}),
				...(sessionName ? { name: sessionName } : {}),
				permissionPreset: draft.permissionPreset,
			});
			if (!this.isCurrentIntent(intent, lifecycle)) return null;
			sessionId = created.session.sessionId;
			if (this.state.draft?.mode === draft.mode) {
				this.commit({ draft: { ...this.state.draft, sessionId }, draftCreatePending: false });
			}
			this.newTaskCreateRequest = null;
		}
		return sessionId;
	}

	async prepareNewTask(): Promise<string | null> {
		const draft = this.state.draft;
		if (!draft || this.state.draftBusy || (draft.mode === "code" && !draft.folder)) return null;
		const lifecycle = this.lifecycleGeneration;
		const intent = this.intentGeneration;
		this.commit({ draftBusy: true, failure: null });
		try {
			const sessionId = await this.createDraftSession(draft, undefined, intent, lifecycle);
			if (!sessionId) return null;
			await this.refreshSessions();
			if (!this.isCurrentIntent(intent, lifecycle)) return null;
			if (!(await this.openSessionForIntent(sessionId, intent, lifecycle))) return null;
			return sessionId;
		} catch (cause) {
			if (!this.isCurrentIntent(intent, lifecycle)) return null;
			if (!shouldReuseMutationRequest(cause)) this.newTaskCreateRequest = null;
			this.commit({
				failure: failure("prepare-new-task", cause),
				draftCreatePending: this.newTaskCreateRequest !== null && this.state.draft?.sessionId === null,
			});
			throw cause;
		} finally {
			if (this.isCurrentIntent(intent, lifecycle)) this.commit({ draftBusy: false });
		}
	}

	async submitNewTask(
		input: ConversationSubmission,
		sessionName?: string,
		settings?: {
			readonly model?: AppStoreSnapshot["model"];
			readonly thinkingSelection?: AppStoreSnapshot["thinkingSelection"];
		},
	): Promise<void> {
		const draft = this.state.draft;
		if (!draft) return;
		if (draft.mode === "code" && !draft.folder) return;
		const lifecycle = this.lifecycleGeneration;
		const intent = this.intentGeneration;
		this.commit({ draftBusy: true, failure: null });
		try {
			const sessionId = await this.createDraftSession(draft, sessionName, intent, lifecycle);
			if (!sessionId) return;
			await this.refreshSessions();
			if (!this.isCurrentIntent(intent, lifecycle)) return;
			if (!(await this.openSessionForIntent(sessionId, intent, lifecycle))) return;
			if (settings?.model) {
				if (!this.api.setModel) throw new Error("Model configuration is unavailable");
				await this.api.setModel({ sessionId, requestId: this.requestId(), ...settings.model });
				if (!this.isCurrentIntent(intent, lifecycle)) return;
			}
			if (settings?.thinkingSelection !== undefined) {
				if (!this.api.setThinkingSelection) throw new Error("Thinking configuration is unavailable");
				await this.api.setThinkingSelection({
					sessionId,
					requestId: this.requestId(),
					selection: settings.thinkingSelection,
				});
				if (!this.isCurrentIntent(intent, lifecycle)) return;
			}
			const turnKey = JSON.stringify({ sessionId, input: composerRequestKey(input) });
			const turnRequest =
				this.newTaskTurnRequest?.key === turnKey
					? this.newTaskTurnRequest
					: { key: turnKey, requestId: this.requestId() };
			this.newTaskTurnRequest = turnRequest;
			await this.api.startTurn({ sessionId, requestId: turnRequest.requestId, ...composerPayload(input) });
			if (!this.isCurrentIntent(intent, lifecycle)) return;
			this.newTaskCreateRequest = null;
			this.newTaskTurnRequest = null;
			this.commit({ draft: null, draftCreatePending: false });
		} catch (cause) {
			if (!this.isCurrentIntent(intent, lifecycle)) return;
			if (!shouldReuseMutationRequest(cause)) {
				this.newTaskCreateRequest = null;
				this.newTaskTurnRequest = null;
			}
			this.commit({
				failure: failure("submit-new-task", cause),
				draftCreatePending: this.newTaskCreateRequest !== null && this.state.draft?.sessionId === null,
			});
			throw cause;
		} finally {
			if (this.isCurrentIntent(intent, lifecycle)) this.commit({ draftBusy: false });
		}
	}

	createSessionInProject(mode: AgentMode, cwd: string): Promise<void> {
		const lifecycle = this.lifecycleGeneration;
		const key = sessionProjectKey(mode, cwd);
		const existing = this.projectCreateRequests.get(key);
		if (existing?.promise) return existing.promise;
		this.clearDraftRequests();
		const intent = this.intentGeneration;
		const requestId = existing?.requestId ?? this.requestId();
		this.commit({ failure: null });
		this.setProjectBusy(key, true);
		const pending = (async () => {
			let createCompleted = false;
			try {
				const created = await this.api.createSession({ requestId, mode, cwd });
				createCompleted = true;
				if (!this.isCurrentProjectCreate(key, requestId, lifecycle)) return;
				if (!this.isCurrentIntent(intent, lifecycle)) {
					await this.refreshSessions(() => this.isCurrentProjectCreate(key, requestId, lifecycle)).catch(
						() => undefined,
					);
					if (this.isCurrentProjectCreate(key, requestId, lifecycle)) this.projectCreateRequests.delete(key);
					return;
				}
				this.commit({ mode, failure: null });
				if (!(await this.openSessionForIntent(created.session.sessionId, intent, lifecycle))) {
					if (!this.isCurrentProjectCreate(key, requestId, lifecycle)) return;
					await this.refreshSessions(() => this.isCurrentProjectCreate(key, requestId, lifecycle)).catch(
						() => undefined,
					);
					if (this.isCurrentProjectCreate(key, requestId, lifecycle)) this.projectCreateRequests.delete(key);
					return;
				}
				if (!this.isCurrentProjectCreate(key, requestId, lifecycle)) return;
				this.commit({ draft: null, draftCreatePending: false });
				await this.refreshSessions(
					() => this.isCurrentProjectCreate(key, requestId, lifecycle),
					(cause) => this.commit({ failure: failure("list-sessions", cause) }),
				);
				if (this.isCurrentProjectCreate(key, requestId, lifecycle)) this.projectCreateRequests.delete(key);
			} catch (cause) {
				if (!this.isCurrentProjectCreate(key, requestId, lifecycle)) throw cause;
				if (createCompleted || shouldReuseMutationRequest(cause)) {
					this.projectCreateRequests.set(key, { requestId });
				} else this.projectCreateRequests.delete(key);
				this.commit({ failure: failure("create-project-session", cause) });
				throw cause;
			} finally {
				const current = this.projectCreateRequests.get(key);
				if (this.isCurrentLifecycle(lifecycle) && (!current || current.requestId === requestId)) {
					this.setProjectBusy(key, false);
				}
			}
		})();
		this.projectCreateRequests.set(key, { requestId, promise: pending });
		return pending;
	}

	async previewProjectDelete(target: SessionProjectTarget): Promise<ClientResult<"project/deletePreview">> {
		try {
			const outcome = await this.api.previewProjectDelete(target);
			if (!outcome.ok) throw outcome.error;
			return outcome.result;
		} catch (cause) {
			const normalized = projectFailure("preview-project-delete", cause);
			throw new Error(normalized.reason, { cause });
		}
	}

	deleteProject(target: SessionProjectTarget, preview: ClientResult<"project/deletePreview">): Promise<void> {
		const lifecycle = this.lifecycleGeneration;
		const projectSessions = [...this.store.getSnapshot().sessionsById.values()].filter(
			(session) => session.mode === target.mode && session.cwd === target.cwd && session.scheduled === undefined,
		);
		if (projectSessions.some((session) => this.state.dirtySessionIds.has(session.sessionId))) {
			const cause = new Error("Save or close unsaved files before deleting this task or project.");
			this.commit({ failure: failure("delete-project", cause) });
			return Promise.reject(cause);
		}
		const key = sessionProjectKey(target.mode, target.cwd);
		const existing = this.projectDeleteRequests.get(key);
		if (existing?.revision === preview.revision && existing.promise) return existing.promise;
		const requestId = existing?.revision === preview.revision ? existing.requestId : this.requestId();
		this.commit({ failure: null });
		this.setProjectBusy(key, true);
		const pending = (async () => {
			try {
				const outcome = await this.api.deleteProject({
					requestId,
					mode: target.mode,
					cwd: target.cwd,
					expectedRevision: preview.revision,
				});
				if (!this.isCurrentProjectDelete(key, requestId, lifecycle)) return;
				if (!outcome.ok) {
					this.projectDeleteRequests.delete(key);
					throw outcome.error;
				}
				const before = this.store.getSnapshot();
				const active = before.activeSessionId ? before.sessionsById.get(before.activeSessionId) : undefined;
				const removedActive =
					active?.mode === target.mode && active.cwd === target.cwd && active.scheduled === undefined;
				for (const session of projectSessions) this.setSessionPin(session.sessionId, false, false);
				this.persistSessionPins();
				this.queueCleanup(projectSessions.map((session) => session.sessionId));
				this.invalidateSessionLists();
				this.store.removeModeProject(target.mode, target.cwd);
				const rememberedId = this.readRememberedSession(target.mode);
				const remembered = rememberedId ? before.sessionsById.get(rememberedId) : undefined;
				if (remembered?.cwd === target.cwd && remembered.scheduled === undefined) {
					this.clearRememberedSession(target.mode, remembered.sessionId);
				}
				this.updateProjectPreferences(
					removeProjectPreference(this.state.projectPreferences, target.mode, target.cwd),
				);
				if (removedActive) this.handleActiveDeletion(active);
				await this.refreshAfterMutation(() => this.isCurrentProjectDelete(key, requestId, lifecycle));
				if (this.isCurrentProjectDelete(key, requestId, lifecycle)) this.projectDeleteRequests.delete(key);
			} catch (cause) {
				if (this.isCurrentProjectDelete(key, requestId, lifecycle) && shouldReuseMutationRequest(cause)) {
					this.projectDeleteRequests.set(key, { requestId, revision: preview.revision });
				} else if (this.isCurrentProjectDelete(key, requestId, lifecycle)) {
					this.projectDeleteRequests.delete(key);
				}
				const normalized = projectFailure("delete-project", cause);
				if (this.isCurrentLifecycle(lifecycle)) this.commit({ failure: normalized });
				throw new Error(normalized.reason, { cause });
			} finally {
				const current = this.projectDeleteRequests.get(key);
				if (this.isCurrentLifecycle(lifecycle) && (!current || current.requestId === requestId)) {
					this.setProjectBusy(key, false);
				}
			}
		})();
		this.projectDeleteRequests.set(key, { requestId, revision: preview.revision, promise: pending });
		return pending;
	}

	renameProject(target: SessionProjectTarget, alias: string): void {
		this.updateProjectPreferences(setProjectAlias(this.state.projectPreferences, target.mode, target.cwd, alias));
	}

	pinProject(target: SessionProjectTarget, pinned: boolean): void {
		this.updateProjectPreferences(setProjectPinned(this.state.projectPreferences, target.mode, target.cwd, pinned));
	}

	pinSession(session: SessionSummary, pinned: boolean): void {
		this.setSessionPin(session.sessionId, pinned, true);
	}

	async renameSession(session: SessionSummary, name: string): Promise<void> {
		const lifecycle = this.lifecycleGeneration;
		const existing = this.sessionRenameRequests.get(session.sessionId);
		const requestId = existing?.name === name ? existing.requestId : this.requestId();
		this.sessionRenameRequests.set(session.sessionId, { name, requestId });
		this.commit({ failure: null });
		try {
			const result = await this.api.renameSession({ sessionId: session.sessionId, requestId, name });
			if (!this.isCurrentSessionRename(session.sessionId, requestId, lifecycle)) return;
			this.invalidateSessionLists();
			this.store.upsertSession(result.session);
			await this.refreshAfterMutation(() => this.isCurrentSessionRename(session.sessionId, requestId, lifecycle));
			if (this.isCurrentSessionRename(session.sessionId, requestId, lifecycle)) {
				this.sessionRenameRequests.delete(session.sessionId);
			}
		} catch (cause) {
			if (!this.isCurrentSessionRename(session.sessionId, requestId, lifecycle)) return;
			const normalized = sessionFailure("rename-session", cause);
			if (!shouldReuseMutationRequest(cause)) this.sessionRenameRequests.delete(session.sessionId);
			this.commit({ failure: normalized });
			throw new Error(normalized.reason, { cause });
		}
	}

	deleteSession(session: SessionSummary): Promise<void> {
		const lifecycle = this.lifecycleGeneration;
		const intent = this.intentGeneration;
		if (this.state.dirtySessionIds.has(session.sessionId)) {
			const cause = new Error("Save or close unsaved files before deleting this task or project.");
			this.commit({ failure: failure("delete-session", cause) });
			return Promise.reject(cause);
		}
		const existing = this.sessionDeleteRequests.get(session.sessionId);
		if (existing?.promise) return existing.promise;
		const requestId = existing?.requestId ?? this.requestId();
		this.commit({ failure: null });
		const pending = (async () => {
			try {
				const result = await this.api.deleteSession({ sessionId: session.sessionId, requestId });
				if (!this.isCurrentSessionDelete(session.sessionId, requestId, lifecycle)) return;
				this.setSessionPin(session.sessionId, false, true);
				this.queueCleanup([session.sessionId]);
				const shouldHandleActiveDeletion = this.store.getSnapshot().activeSessionId === session.sessionId;
				this.invalidateSessionLists();
				this.store.removeSession(session.sessionId);
				this.clearRememberedSession(session.mode, session.sessionId);
				const shouldReportWarning = this.isCurrentIntent(intent, lifecycle);
				if (shouldHandleActiveDeletion) this.handleActiveDeletion(session);
				if (result.warning && shouldReportWarning) {
					this.commit({
						failure: {
							operation: "delete-session-warning",
							reason: result.warning,
							retryable: false,
							cause: null,
						},
					});
				}
				await this.refreshAfterMutation(() => this.isCurrentSessionDelete(session.sessionId, requestId, lifecycle));
				if (this.isCurrentSessionDelete(session.sessionId, requestId, lifecycle)) {
					this.sessionDeleteRequests.delete(session.sessionId);
				}
			} catch (cause) {
				if (!this.isCurrentSessionDelete(session.sessionId, requestId, lifecycle)) throw cause;
				if (
					this.store.getSnapshot().activeSessionId === session.sessionId &&
					rpcErrorCode(cause) === ERROR_CODES.OPERATION_FAILED
				) {
					await this.requestResnapshot(session.sessionId);
				}
				const normalized = sessionFailure("delete-session", cause);
				if (!this.isCurrentSessionDelete(session.sessionId, requestId, lifecycle))
					throw new Error(normalized.reason, { cause });
				if (shouldReuseMutationRequest(cause)) this.sessionDeleteRequests.set(session.sessionId, { requestId });
				else this.sessionDeleteRequests.delete(session.sessionId);
				if (this.isCurrentIntent(intent, lifecycle)) this.commit({ failure: normalized });
				throw new Error(normalized.reason, { cause });
			}
		})();
		this.sessionDeleteRequests.set(session.sessionId, { requestId, promise: pending });
		return pending;
	}

	forkSession(
		entryId: string,
		sessionId = this.store.getSnapshot().activeSessionId,
	): Promise<SessionSummary | undefined> {
		if (!sessionId) return Promise.resolve(undefined);
		const lifecycle = this.lifecycleGeneration;
		const intent = this.intentGeneration;
		const key = JSON.stringify([sessionId, entryId]);
		const existing = this.sessionForkRequests.get(key);
		if (existing?.promise) return existing.promise;
		const requestId = existing?.requestId ?? this.requestId();
		this.commit({ failure: null });
		const pending = (async () => {
			let forkCompleted = false;
			try {
				const result = await this.api.forkSession({ sessionId, requestId, entryId });
				forkCompleted = true;
				if (!this.isCurrentSessionFork(key, requestId, lifecycle)) return undefined;
				await this.refreshAfterMutation(() => this.isCurrentSessionFork(key, requestId, lifecycle));
				if (!this.isCurrentSessionFork(key, requestId, lifecycle)) return undefined;
				if (!this.isCurrentIntent(intent, lifecycle)) {
					this.sessionForkRequests.delete(key);
					return result.session;
				}
				if (!(await this.openSessionForIntent(result.session.sessionId, intent, lifecycle))) {
					if (this.isCurrentSessionFork(key, requestId, lifecycle)) this.sessionForkRequests.delete(key);
					return result.session;
				}
				if (!this.isCurrentSessionFork(key, requestId, lifecycle)) return undefined;
				this.commit({ draft: null, draftCreatePending: false, message: "Forked conversation" });
				this.sessionForkRequests.delete(key);
				return result.session;
			} catch (cause) {
				if (!this.isCurrentSessionFork(key, requestId, lifecycle)) throw cause;
				if (forkCompleted || shouldReuseMutationRequest(cause)) {
					this.sessionForkRequests.set(key, { requestId });
				} else {
					this.sessionForkRequests.delete(key);
				}
				if (this.isCurrentIntent(intent, lifecycle)) this.commit({ failure: failure("fork-session", cause) });
				throw cause;
			}
		})();
		this.sessionForkRequests.set(key, { requestId, promise: pending });
		return pending;
	}

	reportDirtySessionIds(sessionIds: readonly string[]): void {
		const next = new Set(sessionIds);
		if (
			next.size === this.state.dirtySessionIds.size &&
			[...next].every((sessionId) => this.state.dirtySessionIds.has(sessionId))
		) {
			return;
		}
		this.commit({ dirtySessionIds: next });
	}

	acknowledgeCleanup(sessionIds: readonly string[]): void {
		const handled = new Set(sessionIds);
		this.commit({ cleanupSessionIds: this.state.cleanupSessionIds.filter((sessionId) => !handled.has(sessionId)) });
	}

	private async bootstrap(lifecycle: number): Promise<void> {
		const intent = this.intentGeneration;
		try {
			const supervisor = await this.api.getServerState();
			if (!this.isCurrentLifecycle(lifecycle)) return;
			this.store.setSupervisor(supervisor);
			let sessions: Awaited<ReturnType<SessionWorkspaceApi["listSessions"]>> | undefined;
			while (this.isCurrentLifecycle(lifecycle) && !sessions) sessions = await this.refreshSessions();
			if (!sessions || !this.isCurrentLifecycle(lifecycle)) return;
			const remembered = this.readRememberedSession("chat");
			if (
				this.isCurrentIntent(intent, lifecycle) &&
				remembered &&
				sessions.sessions.some((session) => session.mode === "chat" && session.sessionId === remembered)
			) {
				if (await this.openSessionForIntent(remembered, intent, lifecycle)) this.commit({ draft: null });
			} else if (this.isCurrentIntent(intent, lifecycle)) {
				this.commit({ message: "Start a new Chat task" });
			}
		} catch (cause) {
			if (this.isCurrentLifecycle(lifecycle)) this.commit({ failure: failure("bootstrap", cause) });
		} finally {
			if (this.isCurrentLifecycle(lifecycle)) this.commit({ bootstrapped: true });
		}
	}

	private handleDesktopEvent(event: DesktopApiEvent): void {
		if (event.type === "open-session") {
			this.clearDraftRequests();
			const intent = this.intentGeneration;
			const lifecycle = this.lifecycleGeneration;
			this.commit({ mode: event.mode });
			void this.openSessionForIntent(event.sessionId, intent, lifecycle).then(
				(opened) => {
					if (opened && this.isCurrentIntent(intent, lifecycle)) {
						this.commit({ draft: null, draftCreatePending: false });
					}
				},
				() => undefined,
			);
			return;
		}
		if (event.type === "interaction-cancelled") {
			this.store.removeInteraction(event.interactionId);
			return;
		}
		if (event.type === "supervisor") {
			const before = this.store.getSnapshot();
			this.store.setSupervisor(event.view);
			if (shouldResnapshotAfterReady(before, event.view) && this.state.openingSessionId === null) {
				void this.requestResnapshot(before.activeSessionId!);
			}
			return;
		}
		// Tab shortcuts belong to the workspace view, not the session workflow.
		if (event.type === "close-tab") return;
		if ("id" in event.envelope) {
			this.store.addInteraction(event.envelope.params.interaction);
			return;
		}
		this.applyConnectionEvents(event.envelope.params.events, event.envelope.params);
	}

	private applyConnectionEvents(events: readonly DomainEvent[], batch: Parameters<AppStore["applyBatch"]>[0]): void {
		const before = this.store.getSnapshot();
		if (
			events.some(
				(event) =>
					event.type === "session/updated" ||
					event.type === "session/invalidated" ||
					event.type === "project/invalidated",
			)
		) {
			this.invalidateSessionLists();
		}
		const activeBefore = before.activeSessionId ? before.sessionsById.get(before.activeSessionId) : undefined;
		const deletedSessions = events.filter(
			(event): event is Extract<DomainEvent, { type: "session/invalidated" }> =>
				event.type === "session/invalidated" && event.reason === "deleted",
		);
		const deletedProjects = events.filter(
			(event): event is Extract<DomainEvent, { type: "project/invalidated" }> =>
				event.type === "project/invalidated" && event.reason === "deleted",
		);
		const cleanup = new Set(deletedSessions.map((event) => event.sessionId));
		for (const project of deletedProjects) {
			for (const session of before.sessionsById.values()) {
				if (session.mode === project.mode && session.cwd === project.cwd && session.scheduled === undefined) {
					cleanup.add(session.sessionId);
				}
			}
		}
		this.queueCleanup([...cleanup]);
		this.cleanupDeletedPreferences(before, deletedSessions, deletedProjects, cleanup);

		if (before.activeSessionId === null) {
			for (const event of events) if (event.type === "session/updated") this.store.upsertSession(event.session);
			for (const event of deletedSessions) this.store.removeSession(event.sessionId);
			for (const event of deletedProjects) this.store.removeModeProject(event.mode, event.cwd);
			this.reconcileLiveSessions();
			return;
		}

		const sessionInvalidations = events.filter(
			(event): event is Extract<DomainEvent, { type: "session/invalidated" }> =>
				event.type === "session/invalidated" && event.sessionId === before.activeSessionId,
		);
		const sessionInvalidation =
			sessionInvalidations.find((event) => event.reason === "deleted") ?? sessionInvalidations[0];
		const projectInvalidations =
			activeBefore?.scheduled === undefined
				? events.filter(
						(event): event is Extract<DomainEvent, { type: "project/invalidated" }> =>
							event.type === "project/invalidated" &&
							event.mode === activeBefore?.mode &&
							event.cwd === activeBefore.cwd,
					)
				: [];
		const projectInvalidation =
			projectInvalidations.find((event) => event.reason === "deleted") ?? projectInvalidations[0];
		const applyResult = this.store.applyBatch(batch);
		this.reconcileLiveSessions();
		for (const event of deletedSessions) this.store.removeSession(event.sessionId);
		for (const event of deletedProjects) this.store.removeModeProject(event.mode, event.cwd);

		const visibleSessionId = this.getVisibleSessionId ? this.getVisibleSessionId() : before.activeSessionId;
		const visibleUnread = events.find(
			(event): event is Extract<DomainEvent, { type: "session/updated" }> =>
				event.type === "session/updated" &&
				this.state.openingSessionId === null &&
				event.session.sessionId === visibleSessionId &&
				event.session.unread,
		);
		if (visibleUnread) void this.markSessionRead(visibleUnread.session.sessionId);

		if (
			(sessionInvalidation?.reason === "deleted" && before.activeSessionId === sessionInvalidation.sessionId) ||
			projectInvalidation?.reason === "deleted"
		) {
			this.handleActiveDeletion(activeBefore);
			return;
		}
		if (applyResult === "resnapshot_required" && this.state.openingSessionId === null) {
			const activeSessionId = this.store.getSnapshot().activeSessionId;
			if (activeSessionId) void this.requestResnapshot(activeSessionId);
		}
	}

	private handleActiveDeletion(session: SessionSummary | undefined): void {
		this.openGeneration += 1;
		if (!session) return;
		this.clearDraftRequests();
		this.clearRememberedSession(session.mode, session.sessionId);
		this.commit({
			mode: session.mode,
			draft: emptyDraft(session.mode),
			draftCreatePending: false,
			openingSessionId: null,
		});
	}

	private requestResnapshot(sessionId: string): Promise<void> {
		if (this.state.openingSessionId !== null || this.store.getSnapshot().activeSessionId !== sessionId) {
			return Promise.resolve();
		}
		const existing = this.resnapshots.get(sessionId);
		if (existing) return existing;
		let pending!: Promise<void>;
		pending = this.openSession(sessionId)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (this.resnapshots.get(sessionId) === pending) this.resnapshots.delete(sessionId);
			});
		this.resnapshots.set(sessionId, pending);
		return pending;
	}

	private markSessionRead(sessionId: string): Promise<void> {
		const existing = this.markReadRequests.get(sessionId);
		if (existing) return existing;
		if (!this.store.getSnapshot().sessionsById.get(sessionId)?.unread) return Promise.resolve();
		const lifecycle = this.lifecycleGeneration;
		let pending!: Promise<void>;
		pending = this.api
			.markSessionRead({ sessionId })
			.then((result) => {
				if (this.isCurrentLifecycle(lifecycle)) {
					this.invalidateSessionLists();
					this.store.upsertSession(result.session);
				}
			})
			.catch((cause) => {
				if (this.isCurrentLifecycle(lifecycle) && this.markReadRequests.get(sessionId) === pending) {
					this.commit({ failure: failure("mark-session-read", cause) });
				}
			})
			.finally(() => {
				if (this.markReadRequests.get(sessionId) === pending) this.markReadRequests.delete(sessionId);
			});
		this.markReadRequests.set(sessionId, pending);
		return pending;
	}

	private async recoverProjectionAfterFailedOpen(
		before: AppStoreSnapshot,
		generation: number,
		lifecycle: number,
	): Promise<void> {
		const afterFailure = this.store.getSnapshot();
		if (afterFailure.syncStatus !== "resnapshot_required" || !before.activeSessionId) return;
		this.invalidateSessionLists();
		const subscription = this.store.beginSubscription(before.activeSessionId);
		try {
			const recovered = await this.api.openSession({ sessionId: before.activeSessionId });
			if (this.isCurrentOpen(generation, lifecycle)) {
				this.invalidateSessionLists();
				this.store.applySnapshot(recovered);
				this.reconcileLiveSessions();
				return;
			}
		} catch {
			// Preserve resnapshot_required so a later server event retries recovery.
		}
		this.store.cancelSubscription(before.activeSessionId, subscription);
	}

	private queueCleanup(sessionIds: readonly string[]): void {
		if (sessionIds.length === 0) return;
		this.commit({ cleanupSessionIds: [...new Set([...this.state.cleanupSessionIds, ...sessionIds])] });
	}

	private invalidateSessionLists(): void {
		this.sessionListGeneration += 1;
	}

	private async refreshSessions(
		isCurrent: () => boolean = () => true,
		onFailure?: (cause: unknown) => void,
	): Promise<Awaited<ReturnType<SessionWorkspaceApi["listSessions"]>> | undefined> {
		const generation = ++this.sessionListGeneration;
		const lifecycle = this.lifecycleGeneration;
		try {
			const sessions = await this.api.listSessions({ limit: 200 });
			if (!this.isCurrentLifecycle(lifecycle) || generation !== this.sessionListGeneration || !isCurrent()) {
				return undefined;
			}
			this.store.setSessions(sessions);
			return sessions;
		} catch (cause) {
			if (!this.isCurrentLifecycle(lifecycle) || generation !== this.sessionListGeneration || !isCurrent()) {
				return undefined;
			}
			if (!onFailure) throw cause;
			onFailure(cause);
			return undefined;
		}
	}

	private clearDraftRequests(): void {
		this.intentGeneration += 1;
		this.newTaskCreateRequest = null;
		this.newTaskTurnRequest = null;
	}

	private cleanupDeletedPreferences(
		before: AppStoreSnapshot,
		deletedSessions: readonly Extract<DomainEvent, { type: "session/invalidated" }>[],
		deletedProjects: readonly Extract<DomainEvent, { type: "project/invalidated" }>[],
		cleanup: ReadonlySet<string>,
	): void {
		let pins = this.state.pinnedSessionIds;
		for (const sessionId of cleanup) pins = setSessionPinned(pins, sessionId, false);
		if (pins.size !== this.state.pinnedSessionIds.size) {
			this.commit({ pinnedSessionIds: pins });
			this.persistSessionPins();
		}
		let preferences = this.state.projectPreferences;
		for (const project of deletedProjects) {
			preferences = removeProjectPreference(preferences, project.mode, project.cwd);
			const rememberedId = this.readRememberedSession(project.mode);
			const remembered = rememberedId ? before.sessionsById.get(rememberedId) : undefined;
			if (remembered?.cwd === project.cwd && remembered.scheduled === undefined) {
				this.clearRememberedSession(project.mode, remembered.sessionId);
			}
		}
		if (preferences !== this.state.projectPreferences) this.updateProjectPreferences(preferences);
		for (const deleted of deletedSessions) {
			const session = before.sessionsById.get(deleted.sessionId);
			if (session) this.clearRememberedSession(session.mode, session.sessionId);
		}
	}

	private async refreshAfterMutation(isCurrent: () => boolean = () => true): Promise<void> {
		await this.refreshSessions(isCurrent, (cause) => this.commit({ failure: failure("list-sessions", cause) }));
	}

	private updateProjectPreferences(preferences: ProjectPreferenceMap): void {
		this.commit({ projectPreferences: preferences });
		try {
			saveProjectPreferences(this.storage, preferences);
		} catch (cause) {
			this.commit({ failure: failure("save-project-preferences", cause) });
		}
	}

	private setSessionPin(sessionId: string, pinned: boolean, persist: boolean): void {
		const next = setSessionPinned(this.state.pinnedSessionIds, sessionId, pinned);
		this.commit({ pinnedSessionIds: next });
		if (persist) this.persistSessionPins();
	}

	private persistSessionPins(): void {
		try {
			saveSessionPins(this.storage, this.state.pinnedSessionIds);
		} catch (cause) {
			this.commit({ failure: failure("save-session-pins", cause) });
		}
	}

	private setProjectBusy(key: string, busy: boolean): void {
		const next = new Set(this.state.busyProjectKeys);
		if (busy) next.add(key);
		else next.delete(key);
		this.commit({ busyProjectKeys: next });
	}

	private readRememberedSession(mode: AgentMode): string | null {
		try {
			return this.storage.getItem(activeSessionKey(mode));
		} catch (cause) {
			this.commit({ failure: failure("read-session-preference", cause) });
			return null;
		}
	}

	private writeRememberedSession(mode: AgentMode, sessionId: string): void {
		try {
			this.storage.setItem(activeSessionKey(mode), sessionId);
		} catch (cause) {
			this.commit({ failure: failure("write-session-preference", cause) });
		}
	}

	private clearRememberedSession(mode: AgentMode, sessionId: string): void {
		try {
			if (this.storage.getItem(activeSessionKey(mode)) === sessionId) {
				this.storage.removeItem(activeSessionKey(mode));
			}
		} catch (cause) {
			this.commit({ failure: failure("clear-session-preference", cause) });
		}
	}

	private isCurrentLifecycle(generation: number): boolean {
		return !this.disposed && generation === this.lifecycleGeneration;
	}

	private isCurrentSessionRename(sessionId: string, requestId: string, lifecycle: number): boolean {
		return this.isCurrentLifecycle(lifecycle) && this.sessionRenameRequests.get(sessionId)?.requestId === requestId;
	}

	private isCurrentProjectCreate(key: string, requestId: string, lifecycle: number): boolean {
		return this.isCurrentLifecycle(lifecycle) && this.projectCreateRequests.get(key)?.requestId === requestId;
	}

	private isCurrentProjectDelete(key: string, requestId: string, lifecycle: number): boolean {
		return this.isCurrentLifecycle(lifecycle) && this.projectDeleteRequests.get(key)?.requestId === requestId;
	}

	private isCurrentSessionDelete(sessionId: string, requestId: string, lifecycle: number): boolean {
		return this.isCurrentLifecycle(lifecycle) && this.sessionDeleteRequests.get(sessionId)?.requestId === requestId;
	}

	private isCurrentSessionFork(key: string, requestId: string, lifecycle: number): boolean {
		return this.isCurrentLifecycle(lifecycle) && this.sessionForkRequests.get(key)?.requestId === requestId;
	}

	private isCurrentOpen(generation: number, lifecycle: number): boolean {
		return !this.disposed && generation === this.openGeneration && lifecycle === this.lifecycleGeneration;
	}

	private isCurrentIntent(generation: number, lifecycle: number): boolean {
		return !this.disposed && generation === this.intentGeneration && lifecycle === this.lifecycleGeneration;
	}

	private async openSessionForIntent(sessionId: string, intent: number, lifecycle: number): Promise<boolean> {
		const generation = this.openGeneration + 1;
		try {
			await this.openSession(sessionId);
			return this.isCurrentIntent(intent, lifecycle) && this.isCurrentOpen(generation, lifecycle);
		} catch (cause) {
			if (!this.isCurrentIntent(intent, lifecycle) || !this.isCurrentOpen(generation, lifecycle)) return false;
			throw cause;
		}
	}

	private commit(patch: Partial<Omit<SessionWorkspaceSnapshot, "version">>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch, version: this.state.version + 1 };
		for (const listener of this.listeners) listener();
	}
}
