import type {
	AgentMode,
	ClientResult,
	ConnectionEventsParams,
	InteractionView,
	ItemView,
	QueuedTurnView,
	SessionSnapshot,
	SessionSummary,
	TurnView,
} from "@metis/app-protocol";
import type { SupervisorView } from "../../shared/desktop-api.ts";
import {
	activateProjection,
	activeProjection,
	addPendingInteraction,
	applyConnectionEvents,
	type BatchApplyResult,
	beginProjectionSubscription,
	cancelProjectionSubscription,
	createProjectionState,
	derivedSyncStatus,
	type MutableSessionProjection,
	prependAgentItems,
	prependProjectionItems,
	type RendererNotification,
	removeModeProjectSessions,
	removePendingInteraction,
	removeSession,
	replaceAgentItems,
	replaceProjectionSnapshot,
	replaceSessionList,
	requireProjectionResnapshot,
	retireProjection,
	selectAgentTranscript,
} from "./reducer.ts";

export interface AgentTranscriptState {
	readonly agentId: string | null;
	readonly taskId: string | null;
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly itemOrder: readonly string[];
	readonly nextBeforeItemId: string | null;
	readonly journalRevision: number;
}

export interface AppStoreSnapshot {
	readonly version: number;
	readonly sidebarRevision: number;
	readonly sessionsById: ReadonlyMap<string, SessionSummary>;
	readonly sessionOrder: readonly string[];
	readonly activeSessionId: string | null;
	readonly turnsById: ReadonlyMap<string, TurnView>;
	readonly turnOrder: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly itemOrder: readonly string[];
	readonly interactionsById: ReadonlyMap<string, InteractionView>;
	readonly interactionOrder: readonly string[];
	readonly notifications: readonly RendererNotification[];
	readonly nextBeforeItemId: string | null;
	readonly activeTurnId: string | null;
	readonly serverEpoch: string | null;
	readonly cursor: number;
	readonly syncStatus: "empty" | "ready" | "resubscribing" | "resnapshot_required";
	readonly collaborationMode: SessionSnapshot["collaborationMode"];
	readonly permissionPreset: SessionSnapshot["permissionPreset"];
	readonly effectiveSettings: SessionSnapshot["effectiveSettings"];
	readonly constrainedByParent: boolean;
	readonly sandboxHealth: SessionSnapshot["sandboxHealth"];
	readonly activeReview: SessionSnapshot["activeReview"];
	readonly thinkingSelection: SessionSnapshot["thinkingSelection"];
	readonly actualThinkingLevel: SessionSnapshot["actualThinkingLevel"];
	readonly availableThinkingSelections: SessionSnapshot["availableThinkingSelections"];
	readonly model: SessionSnapshot["model"];
	readonly availableModels: NonNullable<SessionSnapshot["availableModels"]>;
	readonly agents: SessionSnapshot["agents"];
	readonly nextAgentAfterId: string | null;
	readonly agentCollectionRevision: number;
	readonly tasks: SessionSnapshot["tasks"];
	readonly deliveredFiles: SessionSnapshot["deliveredFiles"];
	readonly goal: SessionSnapshot["goal"];
	readonly process: SessionSnapshot["process"];
	readonly queuedTurns: readonly QueuedTurnView[];
	readonly agentTranscript: AgentTranscriptState;
	readonly sessions: ReadonlyMap<string, MutableSessionProjection>;
	readonly retiredSessions: ReadonlyMap<string, MutableSessionProjection>;
	readonly supervisor: SupervisorView;
}

export class AppStore {
	private readonly state = createProjectionState();
	private readonly listeners = new Set<() => void>();
	private version = 0;
	private sidebarRevision = 0;
	private agentCollectionRevision = 0;
	private supervisor: SupervisorView = {
		state: "stopped",
		serverEpoch: null,
		restartAttempt: 0,
		failure: null,
	};
	private snapshot = this.createSnapshot();
	private pendingNotification?: {
		kind: "animation-frame" | "timeout";
		handle: number | ReturnType<typeof setTimeout>;
	};

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AppStoreSnapshot => this.snapshot;

	dismissNotifications(notificationIds: readonly string[]): void {
		const dismissed = new Set(notificationIds);
		const remaining = this.state.notifications.filter((notice) => !dismissed.has(notice.notificationId));
		if (remaining.length === this.state.notifications.length) return;
		this.state.notifications = remaining;
		this.commit();
	}

	setOptimisticThinkingSelection(sessionId: string, selection: SessionSnapshot["thinkingSelection"]): void {
		const session = this.state.sessions.get(sessionId);
		if (!session || session.thinkingSelection === selection) return;
		session.thinkingSelection = selection;
		session.revision += 1;
		this.commit();
	}

	setSessions(result: ClientResult<"session/list">): void {
		replaceSessionList(this.state, result.sessions);
		this.sidebarRevision += 1;
		this.commit();
	}

	upsertSession(session: SessionSummary): void {
		const existed = this.state.sessionsById.has(session.sessionId);
		this.state.sessionsById.set(session.sessionId, structuredClone(session));
		if (!existed) this.state.sessionOrder.unshift(session.sessionId);
		this.sidebarRevision += 1;
		this.commit();
	}

	removeModeProject(mode: AgentMode, cwd: string): void {
		if (removeModeProjectSessions(this.state, mode, cwd)) {
			this.sidebarRevision += 1;
			this.commit();
		}
	}

	removeSession(sessionId: string): void {
		if (removeSession(this.state, sessionId)) {
			this.sidebarRevision += 1;
			this.commit();
		}
	}

	applySnapshot(snapshot: SessionSnapshot): void {
		replaceProjectionSnapshot(this.state, snapshot);
		this.agentCollectionRevision += 1;
		this.sidebarRevision += 1;
		this.commit();
	}

	applyBatch(batch: ConnectionEventsParams): BatchApplyResult {
		const previousStatus = derivedSyncStatus(this.state);
		const result = applyConnectionEvents(this.state, batch);
		if (result === "applied" && batch.events.some((event) => event.type === "agent/deleted")) {
			this.agentCollectionRevision += 1;
		}
		if (
			result === "applied" &&
			batch.events.some(
				(event) =>
					event.type === "session/updated" ||
					event.type === "session/invalidated" ||
					event.type === "project/invalidated" ||
					event.type === "turn/started" ||
					event.type === "turn/completed" ||
					event.type === "turn/interrupted",
			)
		) {
			this.sidebarRevision += 1;
		}
		if (result === "applied" || previousStatus !== derivedSyncStatus(this.state)) {
			const streamingOnly =
				result === "applied" &&
				batch.events.length > 0 &&
				batch.events.every((event) => event.type === "item/delta" || event.type === "agent/item/delta");
			this.commit(streamingOnly);
		}
		return result;
	}

	prependItems(sessionId: string, page: ClientResult<"session/readItems">): void {
		prependProjectionItems(this.state, sessionId, page);
		this.commit();
	}

	// Focuses an already-subscribed bucket without rebuilding it. Returns false
	// when the bucket is not ready, so callers fall back to a full snapshot.
	activateProjection(sessionId: string, summary?: SessionSummary): void {
		if (activateProjection(this.state, sessionId, summary)) this.commit();
	}

	requireProjectionResnapshot(sessionId: string): void {
		if (requireProjectionResnapshot(this.state, sessionId)) this.commit();
	}

	selectAgentTranscript(sessionId: string, agentId: string | null, taskId: string | null = null): void {
		if (selectAgentTranscript(this.state, sessionId, agentId, taskId)) this.commit();
	}

	replaceAgentItems(
		sessionId: string,
		agentId: string,
		taskId: string | null,
		page: ClientResult<"agent/readItems">,
	): void {
		if (replaceAgentItems(this.state, sessionId, agentId, taskId, page)) this.commit();
	}

	prependAgentItems(
		sessionId: string,
		agentId: string,
		taskId: string | null,
		page: ClientResult<"agent/readItems">,
	): void {
		if (prependAgentItems(this.state, sessionId, agentId, taskId, page)) this.commit();
	}

	beginSubscription(sessionId: string, options?: { focus?: boolean }): number {
		const token = beginProjectionSubscription(this.state, sessionId, options?.focus ?? true);
		this.commit();
		return token;
	}

	cancelSubscription(sessionId: string, token: number): void {
		if (cancelProjectionSubscription(this.state, sessionId, token)) this.commit();
	}

	dropProjection(sessionId: string): void {
		if (retireProjection(this.state, sessionId)) this.commit();
	}

	setSupervisor(view: SupervisorView): void {
		if (
			view.state === this.supervisor.state &&
			view.serverEpoch === this.supervisor.serverEpoch &&
			view.restartAttempt === this.supervisor.restartAttempt &&
			view.failure === this.supervisor.failure
		) {
			return;
		}
		this.supervisor = structuredClone(view);
		this.commit();
	}

	addInteraction(interaction: InteractionView): void {
		addPendingInteraction(this.state, interaction);
		this.sidebarRevision += 1;
		this.commit();
	}

	removeInteraction(interactionId: string): void {
		const existed = this.state.interactionsById.has(interactionId);
		removePendingInteraction(this.state, interactionId);
		if (existed) {
			this.sidebarRevision += 1;
			this.commit();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private cancelPendingNotification(): void {
		const pending = this.pendingNotification;
		if (!pending) return;
		this.pendingNotification = undefined;
		if (pending.kind === "animation-frame") globalThis.cancelAnimationFrame?.(pending.handle as number);
		else clearTimeout(pending.handle as ReturnType<typeof setTimeout>);
	}

	private scheduleNotification(): void {
		if (this.pendingNotification) return;
		const flush = () => {
			this.pendingNotification = undefined;
			this.notify();
		};
		if (typeof globalThis.requestAnimationFrame === "function") {
			this.pendingNotification = { kind: "animation-frame", handle: globalThis.requestAnimationFrame(flush) };
		} else {
			this.pendingNotification = { kind: "timeout", handle: setTimeout(flush, 16) };
		}
	}

	private commit(deferNotification = false): void {
		this.version += 1;
		this.snapshot = this.createSnapshot();
		if (deferNotification) {
			this.scheduleNotification();
			return;
		}
		this.cancelPendingNotification();
		this.notify();
	}

	private createSnapshot(): AppStoreSnapshot {
		const projection = activeProjection(this.state) ?? this.state.fallbackProjection;
		return {
			version: this.version,
			sidebarRevision: this.sidebarRevision,
			sessionsById: this.state.sessionsById,
			sessionOrder: this.state.sessionOrder,
			activeSessionId: this.state.activeSessionId,
			turnsById: projection.turnsById,
			turnOrder: projection.turnOrder,
			itemsById: projection.itemsById,
			itemOrder: projection.itemOrder,
			interactionsById: this.state.interactionsById,
			interactionOrder: this.state.interactionOrder,
			notifications: this.state.notifications,
			nextBeforeItemId: projection.nextBeforeItemId,
			activeTurnId: projection.activeTurnId,
			serverEpoch: this.state.serverEpoch,
			cursor: this.state.cursor,
			syncStatus: derivedSyncStatus(this.state),
			collaborationMode: projection.collaborationMode,
			permissionPreset: projection.permissionPreset,
			effectiveSettings: projection.effectiveSettings,
			constrainedByParent: projection.constrainedByParent,
			sandboxHealth: projection.sandboxHealth,
			activeReview: projection.activeReview,
			thinkingSelection: projection.thinkingSelection,
			actualThinkingLevel: projection.actualThinkingLevel,
			availableThinkingSelections: projection.availableThinkingSelections,
			model: projection.model,
			availableModels: projection.availableModels,
			agents: projection.agents,
			nextAgentAfterId: projection.nextAgentAfterId,
			agentCollectionRevision: this.agentCollectionRevision,
			tasks: projection.tasks,
			deliveredFiles: projection.deliveredFiles,
			goal: projection.goal,
			process: projection.process,
			queuedTurns: projection.queuedTurns,
			agentTranscript: projection.agentTranscript,
			sessions: this.state.sessions,
			retiredSessions: this.state.retiredSessions,
			supervisor: this.supervisor,
		};
	}
}
