import type {
	AgentMode,
	ClientResult,
	ConnectionEventsParams,
	DomainEvent,
	InteractionView,
	ItemView,
	SessionSnapshot,
	SessionSummary,
	TurnView,
} from "@arcmind/app-protocol";
import type { SupervisorView } from "../../shared/desktop-api.ts";
import {
	addPendingInteraction,
	applyConnectionEvents,
	type BatchApplyResult,
	createProjectionState,
	markProjectionResubscribing,
	prependProjectionItems,
	removeModeProjectSessions,
	removePendingInteraction,
	removeSession,
	replaceProjectionSnapshot,
	replaceSessionList,
	restoreProjectionSyncStatus,
} from "./reducer.ts";

export interface AppStoreSnapshot {
	readonly version: number;
	readonly sessionsById: ReadonlyMap<string, SessionSummary>;
	readonly sessionOrder: readonly string[];
	readonly activeSessionId: string | null;
	readonly turnsById: ReadonlyMap<string, TurnView>;
	readonly turnOrder: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly itemOrder: readonly string[];
	readonly interactionsById: ReadonlyMap<string, InteractionView>;
	readonly interactionOrder: readonly string[];
	readonly notifications: readonly Extract<DomainEvent, { type: "interaction/notify" }>[];
	readonly nextBeforeItemId: string | null;
	readonly activeTurnId: string | null;
	readonly serverEpoch: string | null;
	readonly cursor: number;
	readonly syncStatus: "empty" | "ready" | "resubscribing" | "resnapshot_required";
	readonly permissionMode: SessionSnapshot["permissionMode"];
	readonly thinkingSelection: SessionSnapshot["thinkingSelection"];
	readonly actualThinkingLevel: SessionSnapshot["actualThinkingLevel"];
	readonly availableThinkingSelections: SessionSnapshot["availableThinkingSelections"];
	readonly model: SessionSnapshot["model"];
	readonly availableModels: NonNullable<SessionSnapshot["availableModels"]>;
	readonly subagents: SessionSnapshot["subagents"];
	readonly supervisor: SupervisorView;
}

export class AppStore {
	private readonly state = createProjectionState();
	private readonly listeners = new Set<() => void>();
	private version = 0;
	private supervisor: SupervisorView = {
		state: "stopped",
		serverEpoch: null,
		restartAttempt: 0,
		failure: null,
	};
	private snapshot = this.createSnapshot();

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AppStoreSnapshot => this.snapshot;

	setOptimisticThinkingSelection(selection: SessionSnapshot["thinkingSelection"]): void {
		if (this.state.thinkingSelection === selection) return;
		this.state.thinkingSelection = selection;
		this.commit();
	}

	setSessions(result: ClientResult<"session/list">): void {
		replaceSessionList(this.state, result.sessions);
		this.commit();
	}

	removeModeProject(mode: AgentMode, cwd: string): void {
		if (removeModeProjectSessions(this.state, mode, cwd)) this.commit();
	}

	removeSession(sessionId: string): void {
		if (removeSession(this.state, sessionId)) this.commit();
	}

	applySnapshot(snapshot: SessionSnapshot): void {
		replaceProjectionSnapshot(this.state, snapshot);
		this.commit();
	}

	applyBatch(batch: ConnectionEventsParams): BatchApplyResult {
		const previousStatus = this.state.syncStatus;
		const result = applyConnectionEvents(this.state, batch);
		if (result === "applied" || previousStatus !== this.state.syncStatus) this.commit();
		return result;
	}

	prependItems(page: ClientResult<"session/readItems">): void {
		prependProjectionItems(this.state, page);
		this.commit();
	}

	markResubscribing(): void {
		if (this.state.syncStatus === "resubscribing") return;
		markProjectionResubscribing(this.state);
		this.commit();
	}

	restoreSyncStatusAfterFailedOpen(
		previous: Pick<AppStoreSnapshot, "activeSessionId" | "serverEpoch" | "syncStatus">,
	): void {
		if (restoreProjectionSyncStatus(this.state, previous)) this.commit();
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
		this.commit();
	}

	removeInteraction(interactionId: string): void {
		const existed = this.state.interactionsById.has(interactionId);
		removePendingInteraction(this.state, interactionId);
		if (existed) this.commit();
	}

	private commit(): void {
		this.version += 1;
		this.snapshot = this.createSnapshot();
		for (const listener of this.listeners) listener();
	}

	private createSnapshot(): AppStoreSnapshot {
		return {
			version: this.version,
			sessionsById: this.state.sessionsById,
			sessionOrder: this.state.sessionOrder,
			activeSessionId: this.state.activeSessionId,
			turnsById: this.state.turnsById,
			turnOrder: this.state.turnOrder,
			itemsById: this.state.itemsById,
			itemOrder: this.state.itemOrder,
			interactionsById: this.state.interactionsById,
			interactionOrder: this.state.interactionOrder,
			notifications: this.state.notifications,
			nextBeforeItemId: this.state.nextBeforeItemId,
			activeTurnId: this.state.activeTurnId,
			serverEpoch: this.state.serverEpoch,
			cursor: this.state.cursor,
			syncStatus: this.state.syncStatus,
			permissionMode: this.state.permissionMode,
			thinkingSelection: this.state.thinkingSelection,
			actualThinkingLevel: this.state.actualThinkingLevel,
			availableThinkingSelections: this.state.availableThinkingSelections,
			model: this.state.model,
			availableModels: this.state.availableModels,
			subagents: this.state.subagents,
			supervisor: this.supervisor,
		};
	}
}
