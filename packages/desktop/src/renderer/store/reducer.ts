import type {
	AgentMode,
	AgentSummaryView,
	ConnectionEventsParams,
	DomainEvent,
	InteractionView,
	ItemView,
	QueuedTurnView,
	SessionSnapshot,
	SessionSummary,
	ThinkingSelectionView,
	TurnView,
} from "@metis/app-protocol";

export type ProjectionSyncStatus = "empty" | "ready" | "resubscribing" | "resnapshot_required";
export type BatchApplyResult = "applied" | "resnapshot_required";

export interface MutableAgentTranscriptState {
	agentId: string | null;
	taskId: string | null;
	readonly itemsById: Map<string, ItemView>;
	itemOrder: string[];
	nextBeforeItemId: string | null;
	journalRevision: number;
}

export type RendererNotification = Extract<DomainEvent, { type: "interaction/notify" }> & {
	readonly translation?: { readonly key: string; readonly values: Record<string, string | number> };
};

export interface MutableSessionProjection {
	readonly turnsById: Map<string, TurnView>;
	turnOrder: string[];
	readonly itemsById: Map<string, ItemView>;
	itemOrder: string[];
	nextBeforeItemId: string | null;
	activeTurnId: string | null;
	syncStatus: "subscribing" | "ready" | "resnapshot_required";
	buffer: { readonly cursor: number; readonly event: DomainEvent }[] | "overflowed" | null;
	focusOnSnapshot: boolean;
	statusBeforeSubscribe: "ready" | "resnapshot_required" | null;
	subscriptionToken: number;
	revision: number;
	collaborationMode: SessionSnapshot["collaborationMode"];
	permissionPreset: SessionSnapshot["permissionPreset"];
	effectiveSettings: SessionSnapshot["effectiveSettings"];
	constrainedByParent: boolean;
	sandboxHealth: SessionSnapshot["sandboxHealth"];
	activeReview: SessionSnapshot["activeReview"];
	thinkingSelection: ThinkingSelectionView;
	actualThinkingLevel: SessionSnapshot["actualThinkingLevel"];
	availableThinkingSelections: ThinkingSelectionView[];
	model: SessionSnapshot["model"];
	availableModels: NonNullable<SessionSnapshot["availableModels"]>;
	agents: AgentSummaryView[];
	nextAgentAfterId: string | null;
	readonly agentTranscript: MutableAgentTranscriptState;
	tasks: SessionSnapshot["tasks"];
	deliveredFiles: SessionSnapshot["deliveredFiles"];
	goal: SessionSnapshot["goal"];
	process: SessionSnapshot["process"];
	queuedTurns: QueuedTurnView[];
}

export interface MutableProjectionState {
	readonly sessionsById: Map<string, SessionSummary>;
	sessionOrder: string[];
	activeSessionId: string | null;
	readonly interactionsById: Map<string, InteractionView>;
	interactionOrder: string[];
	notifications: RendererNotification[];
	serverEpoch: string | null;
	cursor: number;
	readonly sessions: Map<string, MutableSessionProjection>;
	readonly retiredSessions: Map<string, MutableSessionProjection>;
	nextSubscriptionToken: number;
	readonly fallbackProjection: MutableSessionProjection;
}

function clearAgentTranscript(
	state: MutableAgentTranscriptState,
	agentId: string | null = null,
	taskId: string | null = null,
): void {
	state.agentId = agentId;
	state.taskId = taskId;
	state.itemsById.clear();
	state.itemOrder = [];
	state.nextBeforeItemId = null;
	state.journalRevision = 0;
}

export function emptyProjection() {
	return {
		turnsById: new Map<string, TurnView>(),
		turnOrder: [] as string[],
		itemsById: new Map<string, ItemView>(),
		itemOrder: [] as string[],
		nextBeforeItemId: null as string | null,
		activeTurnId: null as string | null,
		collaborationMode: "default" as SessionSnapshot["collaborationMode"],
		permissionPreset: "auto" as SessionSnapshot["permissionPreset"],
		effectiveSettings: {
			sandboxPolicy: "workspace-write",
			approvalPolicy: "auto-review",
		} as SessionSnapshot["effectiveSettings"],
		constrainedByParent: false,
		sandboxHealth: "healthy" as SessionSnapshot["sandboxHealth"],
		activeReview: undefined as SessionSnapshot["activeReview"],
		thinkingSelection: "off" as ThinkingSelectionView,
		actualThinkingLevel: "off" as SessionSnapshot["actualThinkingLevel"],
		availableThinkingSelections: ["off"] as ThinkingSelectionView[],
		model: undefined as SessionSnapshot["model"],
		availableModels: [] as NonNullable<SessionSnapshot["availableModels"]>,
		agents: [] as AgentSummaryView[],
		nextAgentAfterId: null as string | null,
		agentTranscript: {
			agentId: null as string | null,
			taskId: null as string | null,
			itemsById: new Map<string, ItemView>(),
			itemOrder: [] as string[],
			nextBeforeItemId: null as string | null,
			journalRevision: 0,
		},
		tasks: [] as SessionSnapshot["tasks"],
		deliveredFiles: [] as SessionSnapshot["deliveredFiles"],
		goal: null as SessionSnapshot["goal"],
		process: undefined as SessionSnapshot["process"],
		queuedTurns: [] as QueuedTurnView[],
	};
}

function createSessionProjection(): MutableSessionProjection {
	return {
		...emptyProjection(),
		syncStatus: "subscribing",
		buffer: null,
		focusOnSnapshot: false,
		statusBeforeSubscribe: null,
		subscriptionToken: 0,
		revision: 0,
	};
}

export function createProjectionState(): MutableProjectionState {
	return {
		sessionsById: new Map(),
		sessionOrder: [],
		activeSessionId: null,
		interactionsById: new Map(),
		interactionOrder: [],
		notifications: [],
		serverEpoch: null,
		cursor: 0,
		sessions: new Map(),
		retiredSessions: new Map(),
		nextSubscriptionToken: 0,
		fallbackProjection: createSessionProjection(),
	};
}

export function activeProjection(state: MutableProjectionState): MutableSessionProjection | undefined {
	return state.activeSessionId === null ? undefined : state.sessions.get(state.activeSessionId);
}

export function derivedSyncStatus(state: MutableProjectionState): ProjectionSyncStatus {
	for (const session of state.sessions.values()) {
		if (session.syncStatus === "subscribing" && session.focusOnSnapshot) return "resubscribing";
	}
	const active = activeProjection(state);
	if (!active) return "empty";
	if (active.syncStatus === "ready") return "ready";
	if (active.syncStatus === "resnapshot_required") return "resnapshot_required";
	return "resubscribing";
}

export function replaceSessionList(state: MutableProjectionState, sessions: readonly SessionSummary[]): void {
	const active = state.activeSessionId === null ? undefined : state.sessionsById.get(state.activeSessionId);
	state.sessionsById.clear();
	state.sessionOrder = [];
	for (const session of sessions) {
		state.sessionsById.set(session.sessionId, structuredClone(session));
		state.sessionOrder.push(session.sessionId);
	}
	if (active && !state.sessionsById.has(active.sessionId)) {
		state.sessionsById.set(active.sessionId, active);
		state.sessionOrder.unshift(active.sessionId);
	}
}

function retainProjectionFallback(state: MutableProjectionState, session: MutableSessionProjection): void {
	state.fallbackProjection.model = session.model;
	state.fallbackProjection.availableModels = session.availableModels;
	state.fallbackProjection.thinkingSelection = session.thinkingSelection;
	state.fallbackProjection.actualThinkingLevel = session.actualThinkingLevel;
	state.fallbackProjection.availableThinkingSelections = session.availableThinkingSelections;
	state.fallbackProjection.deliveredFiles = session.deliveredFiles;
}

export function removeSession(state: MutableProjectionState, sessionId: string): boolean {
	const removedSummary = state.sessionsById.delete(sessionId);
	const projection = state.sessions.get(sessionId);
	const removedProjection = state.sessions.delete(sessionId);
	state.retiredSessions.delete(sessionId);
	if (!removedSummary && !removedProjection) return false;
	state.sessionOrder = state.sessionOrder.filter((candidate) => candidate !== sessionId);
	state.notifications = state.notifications.filter((notification) => notification.sessionId !== sessionId);
	for (const interactionId of state.interactionOrder) {
		if (state.interactionsById.get(interactionId)?.sessionId === sessionId) {
			state.interactionsById.delete(interactionId);
		}
	}
	state.interactionOrder = state.interactionOrder.filter((interactionId) => state.interactionsById.has(interactionId));
	if (state.activeSessionId !== sessionId) return true;

	state.activeSessionId = null;
	if (projection) retainProjectionFallback(state, projection);
	return true;
}

export function removeModeProjectSessions(state: MutableProjectionState, mode: AgentMode, cwd: string): boolean {
	const removed = new Set(
		state.sessionOrder.filter((sessionId) => {
			const session = state.sessionsById.get(sessionId);
			return session?.mode === mode && session.cwd === cwd && session.scheduled === undefined;
		}),
	);
	if (removed.size === 0) return false;
	const active =
		state.activeSessionId !== null && removed.has(state.activeSessionId)
			? state.sessions.get(state.activeSessionId)
			: undefined;
	for (const sessionId of removed) {
		state.sessionsById.delete(sessionId);
		state.sessions.delete(sessionId);
		state.retiredSessions.delete(sessionId);
	}
	state.sessionOrder = state.sessionOrder.filter((sessionId) => !removed.has(sessionId));
	state.notifications = state.notifications.filter(
		(notification) => notification.sessionId === undefined || !removed.has(notification.sessionId),
	);
	for (const interactionId of state.interactionOrder) {
		const interaction = state.interactionsById.get(interactionId);
		if (interaction?.sessionId !== undefined && removed.has(interaction.sessionId)) {
			state.interactionsById.delete(interactionId);
		}
	}
	state.interactionOrder = state.interactionOrder.filter((interactionId) => state.interactionsById.has(interactionId));
	if (!state.activeSessionId || !removed.has(state.activeSessionId)) return true;

	state.activeSessionId = null;
	if (active) retainProjectionFallback(state, active);
	return true;
}

// A hidden projection is retired instead of destroyed, so a pane that becomes
// visible again repaints its last known content while the new subscription
// resnapshots. retiredSessions holds at most RETIRED_PROJECTION_LIMIT buckets
// in recency order (Map insertion order); epoch changes clear it entirely, so
// anything still present is compatible with the current server generation.
const RETIRED_PROJECTION_LIMIT = 8;

export function retireProjection(state: MutableProjectionState, sessionId: string): boolean {
	const session = state.sessions.get(sessionId);
	if (!session || state.activeSessionId === sessionId) return false;
	state.sessions.delete(sessionId);
	state.retiredSessions.delete(sessionId);
	state.retiredSessions.set(sessionId, session);
	while (state.retiredSessions.size > RETIRED_PROJECTION_LIMIT) {
		const oldest = state.retiredSessions.keys().next().value;
		if (oldest === undefined) break;
		state.retiredSessions.delete(oldest);
	}
	return true;
}

export function beginProjectionSubscription(state: MutableProjectionState, sessionId: string, focus: boolean): number {
	let session = state.sessions.get(sessionId);
	if (!session) {
		// Adopt a retired bucket so stale content stays painted until the
		// snapshot lands; only same-epoch buckets survive to this point.
		session = state.retiredSessions.get(sessionId);
		if (session) {
			state.retiredSessions.delete(sessionId);
			state.sessions.set(sessionId, session);
		}
	}
	if (!session) {
		session = createSessionProjection();
		state.sessions.set(sessionId, session);
	}
	if (focus) {
		for (const other of state.sessions.values()) {
			if (other !== session && other.syncStatus === "subscribing" && other.focusOnSnapshot) {
				other.focusOnSnapshot = false;
				other.revision += 1;
			}
		}
	}
	if (session.syncStatus !== "subscribing") session.statusBeforeSubscribe = session.syncStatus;
	session.syncStatus = "subscribing";
	session.buffer = [];
	session.focusOnSnapshot = focus;
	session.subscriptionToken = ++state.nextSubscriptionToken;
	session.revision += 1;
	return session.subscriptionToken;
}

export function cancelProjectionSubscription(state: MutableProjectionState, sessionId: string, token: number): boolean {
	const session = state.sessions.get(sessionId);
	if (!session || session.syncStatus !== "subscribing" || session.subscriptionToken !== token) return false;
	const buffered = session.buffer;
	session.buffer = null;
	if (session.statusBeforeSubscribe === null) {
		if (state.activeSessionId === sessionId) {
			session.syncStatus = "resnapshot_required";
		} else {
			state.sessions.delete(sessionId);
			return true;
		}
	} else {
		session.syncStatus = session.statusBeforeSubscribe;
		if (session.syncStatus === "ready") {
			if (buffered === "overflowed") {
				session.syncStatus = "resnapshot_required";
			} else if (buffered && buffered.length > 0) {
				const replay = buffered.map((entry) => entry.event);
				if (!canApplyEvents(session, replay)) {
					session.syncStatus = "resnapshot_required";
				} else {
					for (const event of replay) applyEvent(state, session, event);
				}
			}
		}
	}
	session.statusBeforeSubscribe = null;
	session.focusOnSnapshot = false;
	session.revision += 1;
	return true;
}

// Moves the projected session onto an already-subscribed bucket. Used by the
// open fast path, which skips beginSubscription/applySnapshot so the bucket's
// live state is never blanked or rebuilt during a focus switch.
export function activateProjection(
	state: MutableProjectionState,
	sessionId: string,
	summary?: SessionSummary,
): boolean {
	const session = state.sessions.get(sessionId);
	if (!session || session.syncStatus !== "ready") return false;
	if (summary) {
		state.sessionsById.set(sessionId, structuredClone(summary));
		if (!state.sessionOrder.includes(sessionId)) state.sessionOrder.unshift(sessionId);
	}
	if (state.activeSessionId === sessionId) return true;
	state.activeSessionId = sessionId;
	session.revision += 1;
	return true;
}

// Marks a non-active bucket stale so the live-session reconcile loop
// resubscribes it. Used when a mutation failed against a background session.
export function requireProjectionResnapshot(state: MutableProjectionState, sessionId: string): boolean {
	const session = state.sessions.get(sessionId);
	if (!session || session.syncStatus === "resnapshot_required") return false;
	session.syncStatus = "resnapshot_required";
	session.revision += 1;
	return true;
}

export function replaceProjectionSnapshot(state: MutableProjectionState, snapshotValue: SessionSnapshot): void {
	const snapshot = structuredClone(snapshotValue);
	const sessionId = snapshot.session.sessionId;
	const existed = state.sessions.has(sessionId);
	let session = state.sessions.get(sessionId);
	state.retiredSessions.delete(sessionId);
	if (!session) {
		session = createSessionProjection();
		state.sessions.set(sessionId, session);
	}
	state.sessionsById.set(sessionId, snapshot.session);
	if (!state.sessionOrder.includes(sessionId)) state.sessionOrder.unshift(sessionId);

	session.turnsById.clear();
	session.turnOrder = [];
	for (const turn of snapshot.turns) {
		session.turnsById.set(turn.turnId, turn);
		session.turnOrder.push(turn.turnId);
	}

	session.itemsById.clear();
	session.itemOrder = [];
	for (const item of snapshot.recentItems) {
		session.itemsById.set(item.itemId, item);
		session.itemOrder.push(item.itemId);
	}

	for (const interactionId of state.interactionOrder) {
		if (state.interactionsById.get(interactionId)?.sessionId === sessionId) {
			state.interactionsById.delete(interactionId);
		}
	}
	state.interactionOrder = state.interactionOrder.filter((interactionId) => state.interactionsById.has(interactionId));
	for (const interaction of snapshot.pendingInteractions) {
		if (!state.interactionsById.has(interaction.interactionId))
			state.interactionOrder.push(interaction.interactionId);
		state.interactionsById.set(interaction.interactionId, interaction);
	}

	session.nextBeforeItemId = snapshot.nextBeforeItemId;
	session.activeTurnId = snapshot.activeTurnId;
	if (snapshot.serverEpoch !== state.serverEpoch || state.cursor === 0) {
		const epochChanged = snapshot.serverEpoch !== state.serverEpoch;
		state.serverEpoch = snapshot.serverEpoch;
		state.cursor = snapshot.cursor;
		if (epochChanged) {
			state.retiredSessions.clear();
			for (const [otherId, other] of state.sessions) {
				if (otherId === sessionId || other.syncStatus === "resnapshot_required") continue;
				other.syncStatus = "resnapshot_required";
				other.buffer = null;
				other.revision += 1;
			}
		}
	}
	session.collaborationMode = snapshot.collaborationMode;
	session.permissionPreset = snapshot.permissionPreset;
	session.effectiveSettings = snapshot.effectiveSettings;
	session.constrainedByParent = snapshot.constrainedByParent;
	session.sandboxHealth = snapshot.sandboxHealth;
	session.activeReview = snapshot.activeReview;
	session.thinkingSelection = snapshot.thinkingSelection;
	session.actualThinkingLevel = snapshot.actualThinkingLevel;
	session.availableThinkingSelections = snapshot.availableThinkingSelections;
	session.model = snapshot.model;
	session.availableModels = snapshot.availableModels ?? [];
	session.agents = snapshot.agents;
	session.nextAgentAfterId =
		snapshot.nextAgentAfterId ?? (snapshot.agents.length >= 100 ? (snapshot.agents.at(-1)?.agentId ?? null) : null);
	session.tasks = snapshot.tasks;
	session.deliveredFiles = snapshot.deliveredFiles;
	session.goal = snapshot.goal;
	session.process = snapshot.process;
	session.queuedTurns = snapshot.queuedTurns;

	if (!existed || session.syncStatus !== "subscribing" || session.focusOnSnapshot) {
		state.activeSessionId = sessionId;
	}
	// The snapshot replaced this bucket's contents; a selected transcript must refetch.
	if (session.agentTranscript.agentId) session.agentTranscript.journalRevision += 1;

	const buffered = session.buffer;
	session.buffer = null;
	if (buffered === "overflowed") {
		session.syncStatus = "resnapshot_required";
	} else {
		const replay = (buffered ?? []).filter((entry) => entry.cursor > snapshot.cursor).map((entry) => entry.event);
		if (!canApplyEvents(session, replay)) {
			session.syncStatus = "resnapshot_required";
		} else {
			session.syncStatus = "ready";
			for (const event of replay) applyEvent(state, session, event);
		}
	}
	session.statusBeforeSubscribe = null;
	session.focusOnSnapshot = false;
	session.revision += 1;
}

export function eventSessionId(event: DomainEvent): string | undefined {
	switch (event.type) {
		case "session/updated":
			return event.session.sessionId;
		case "session/invalidated":
			return event.sessionId;
		case "turn/started":
		case "turn/completed":
		case "turn/interrupted":
			return event.turn.sessionId;
		case "item/started":
		case "item/completed":
			return event.item.sessionId;
		case "item/delta":
			return event.sessionId;
		case "session/permissionPresetChanged":
		case "session/permissionReviewStarted":
		case "session/permissionReviewCompleted":
		case "session/collaborationModeChanged":
		case "session/thinkingSelectionChanged":
		case "agent/updated":
		case "agent/deleted":
		case "agent/item/started":
		case "agent/item/delta":
		case "agent/item/completed":
		case "agent/itemsChanged":
		case "session/modelChanged":
		case "session/tasksChanged":
		case "session/deliveredFilesChanged":
		case "session/goalChanged":
		case "session/processChanged":
		case "turn/queueChanged":
			return event.sessionId;
		case "interaction/notify":
			return event.sessionId;
		case "project/invalidated":
		case "server/state":
		case "memory/changed":
		case "memory/dreamCompleted":
			return undefined;
	}
}

function targetsSessionProject(
	session: SessionSummary | undefined,
	event: Extract<DomainEvent, { type: "project/invalidated" }>,
): boolean {
	return session?.scheduled === undefined && session?.mode === event.mode && session.cwd === event.cwd;
}

function isSelectedAgentLiveTask(session: MutableSessionProjection, agentId: string, taskId?: string): boolean {
	const transcript = session.agentTranscript;
	if (transcript.agentId !== agentId) return false;
	if (transcript.taskId === null) return true;
	if (taskId !== undefined) return taskId === transcript.taskId;
	return session.agents.find((agent) => agent.agentId === agentId)?.currentTask?.taskId === transcript.taskId;
}

function canApplyEvents(session: MutableSessionProjection, events: readonly DomainEvent[]): boolean {
	const itemStates = new Map<string, ItemView["state"]>();
	for (const event of events) {
		if (event.type === "session/invalidated") continue;
		switch (event.type) {
			case "item/started":
			case "item/completed":
				itemStates.set(event.item.itemId, event.item.state);
				break;
			case "item/delta": {
				const stateBeforeDelta = itemStates.get(event.itemId) ?? session.itemsById.get(event.itemId)?.state;
				if (stateBeforeDelta !== "streaming") return false;
				break;
			}
		}
	}
	return true;
}

function upsertOrdered<T>(map: Map<string, T>, order: string[], id: string, value: T): string[] {
	if (map.has(id)) {
		map.set(id, value);
		return order;
	}
	map.set(id, value);
	return [...order, id];
}

function appendItemDelta(
	item: ItemView,
	delta: { readonly type: "text" | "thinking"; readonly text: string },
): ItemView {
	const content = [...item.content];
	const last = content.at(-1);
	if (last?.type === delta.type) content[content.length - 1] = { ...last, text: last.text + delta.text };
	else content.push({ type: delta.type, text: delta.text });
	return { ...item, content };
}

function applyEvent(state: MutableProjectionState, session: MutableSessionProjection | null, event: DomainEvent): void {
	switch (event.type) {
		case "session/processChanged":
			session!.process = structuredClone(event.process);
			return;
		case "server/state":
			return;
		case "interaction/notify":
			state.notifications = [...state.notifications.slice(-99), structuredClone(event)];
			return;
		case "session/invalidated":
			if (event.reason === "deleted") removeSession(state, event.sessionId);
			else if (session) session.syncStatus = "resnapshot_required";
			return;
		case "project/invalidated":
			if (event.reason === "deleted") removeModeProjectSessions(state, event.mode, event.cwd);
			else if (session) session.syncStatus = "resnapshot_required";
			return;
		case "session/updated":
			state.sessionOrder = upsertOrdered(
				state.sessionsById,
				state.sessionOrder,
				event.session.sessionId,
				structuredClone(event.session),
			);
			return;
		case "session/permissionPresetChanged":
			session!.permissionPreset = event.permissionPreset;
			session!.effectiveSettings = event.effectiveSettings;
			session!.constrainedByParent = event.constrainedByParent;
			session!.sandboxHealth = event.sandboxHealth;
			return;
		case "session/permissionReviewStarted":
			session!.activeReview = {
				actionId: event.actionId,
				reviewer: event.reviewer,
				riskLevel: event.riskLevel,
			};
			return;
		case "session/permissionReviewCompleted":
			if (session!.activeReview?.actionId === event.actionId) session!.activeReview = undefined;
			return;
		case "session/collaborationModeChanged":
			session!.collaborationMode = event.collaborationMode;
			return;
		case "session/thinkingSelectionChanged":
			session!.thinkingSelection = event.thinkingSelection;
			session!.actualThinkingLevel = event.actualThinkingLevel;
			session!.availableThinkingSelections = event.availableThinkingSelections;
			return;
		case "session/modelChanged":
			session!.model = event.model;
			session!.thinkingSelection = event.thinkingSelection;
			session!.actualThinkingLevel = event.actualThinkingLevel;
			session!.availableThinkingSelections = event.availableThinkingSelections;
			return;
		case "session/tasksChanged":
			session!.tasks = structuredClone(event.tasks);
			return;
		case "session/deliveredFilesChanged":
			session!.deliveredFiles = structuredClone(event.deliveredFiles);
			return;
		case "session/goalChanged":
			session!.goal = structuredClone(event.goal);
			return;
		case "turn/queueChanged":
			session!.queuedTurns = structuredClone(event.queuedTurns);
			return;
		case "agent/updated": {
			const index = session!.agents.findIndex((candidate) => candidate.agentId === event.agent.agentId);
			session!.agents =
				index < 0
					? [...session!.agents, structuredClone(event.agent)]
					: session!.agents.map((candidate, current) =>
							current === index ? structuredClone(event.agent) : candidate,
						);
			return;
		}
		case "agent/deleted": {
			const deleted = new Set(event.deletedAgentIds);
			session!.agents = session!.agents.filter((agent) => !deleted.has(agent.agentId));
			const transcript = session!.agentTranscript;
			if (transcript.agentId && deleted.has(transcript.agentId)) clearAgentTranscript(transcript);
			return;
		}
		case "agent/item/started":
		case "agent/item/completed":
			if (isSelectedAgentLiveTask(session!, event.agentId)) {
				session!.agentTranscript.itemOrder = upsertOrdered(
					session!.agentTranscript.itemsById,
					session!.agentTranscript.itemOrder,
					event.item.itemId,
					structuredClone(event.item),
				);
			}
			return;
		case "agent/item/delta": {
			if (!isSelectedAgentLiveTask(session!, event.agentId)) return;
			const transcript = session!.agentTranscript;
			const item = transcript.itemsById.get(event.itemId);
			if (item?.state === "streaming") {
				transcript.itemsById.set(event.itemId, appendItemDelta(item, event.delta));
			}
			return;
		}
		case "agent/itemsChanged":
			if (isSelectedAgentLiveTask(session!, event.agentId, event.taskId)) {
				session!.agentTranscript.journalRevision += 1;
			}
			return;
		case "turn/started":
		case "turn/completed":
		case "turn/interrupted":
			session!.turnOrder = upsertOrdered(
				session!.turnsById,
				session!.turnOrder,
				event.turn.turnId,
				structuredClone(event.turn),
			);
			if (event.turn.state === "running") session!.activeTurnId = event.turn.turnId;
			else if (session!.activeTurnId === event.turn.turnId) session!.activeTurnId = null;
			return;
		case "item/started":
		case "item/completed":
			session!.itemOrder = upsertOrdered(
				session!.itemsById,
				session!.itemOrder,
				event.item.itemId,
				structuredClone(event.item),
			);
			return;
		case "item/delta":
			session!.itemsById.set(event.itemId, appendItemDelta(session!.itemsById.get(event.itemId)!, event.delta));
			return;
		case "memory/changed": {
			// Vault writes are connection-level; surface them like the agent's
			// "Saved memory: ..." tool text so user/dream edits also toast.
			const target =
				"slug" in event.entry.target
					? `note "${event.entry.target.slug}"`
					: `pinned block "${event.entry.target.block}"`;
			state.notifications = [
				...state.notifications.slice(-99),
				{
					type: "interaction/notify",
					notificationId: event.entry.id,
					level: "info",
					message: event.entry.op === "undo" ? `Reverted memory: ${target}` : `Saved memory: ${target}`,
					createdAt: event.entry.ts,
					translation:
						"slug" in event.entry.target
							? {
									key:
										event.entry.op === "undo"
											? 'Reverted memory: note "{{slug}}"'
											: 'Saved memory: note "{{slug}}"',
									values: { slug: event.entry.target.slug },
								}
							: {
									key:
										event.entry.op === "undo"
											? 'Reverted memory: pinned block "{{block}}"'
											: 'Saved memory: pinned block "{{block}}"',
									values: { block: event.entry.target.block },
								},
				},
			];
			return;
		}
		case "memory/dreamCompleted":
			state.notifications = [
				...state.notifications.slice(-99),
				{
					type: "interaction/notify",
					notificationId: crypto.randomUUID(),
					level: "info",
					message: `Memory consolidated: ${event.added} added, ${event.updated} updated, ${event.deleted} deleted`,
					translation: {
						key: "Memory consolidated: {{added}} added, {{updated}} updated, {{deleted}} deleted",
						values: { added: event.added, updated: event.updated, deleted: event.deleted },
					},
					createdAt: new Date().toISOString(),
				},
			];
	}
}

function bufferSessionEvent(session: MutableSessionProjection, cursor: number, event: DomainEvent): void {
	if (session.buffer === "overflowed") return;
	if (session.buffer === null) session.buffer = [];
	const buffer = session.buffer;
	buffer.push({ cursor, event });
	if (buffer.length > 5000) session.buffer = "overflowed";
	session.revision += 1;
}

function bufferOrInvalidate(session: MutableSessionProjection, cursor: number, event: DomainEvent): void {
	if (session.syncStatus === "subscribing") {
		bufferSessionEvent(session, cursor, event);
	} else if (session.syncStatus === "ready") {
		session.syncStatus = "resnapshot_required";
		session.revision += 1;
	}
}

export function applyConnectionEvents(state: MutableProjectionState, batch: ConnectionEventsParams): BatchApplyResult {
	const invalid =
		batch.serverEpoch !== state.serverEpoch || batch.fromCursor <= state.cursor || batch.toCursor < batch.fromCursor;
	if (invalid) {
		// Retired projections only ever repaint same-epoch content.
		if (batch.serverEpoch !== state.serverEpoch) state.retiredSessions.clear();
		if (
			batch.serverEpoch === state.serverEpoch &&
			batch.fromCursor > state.cursor &&
			batch.toCursor >= batch.fromCursor
		) {
			for (const event of batch.events) {
				if (event.type === "session/updated") applyEvent(state, null, event);
			}
		}
		const active = activeProjection(state);
		if (active?.syncStatus === "ready") {
			active.syncStatus = "resnapshot_required";
			active.revision += 1;
		}
		return "resnapshot_required";
	}

	const pending = new Map<MutableSessionProjection, DomainEvent[]>();
	for (let index = 0; index < batch.events.length; index += 1) {
		const event = batch.events[index]!;
		const cursor = batch.fromCursor + index;
		const sessionId = eventSessionId(event);
		if (sessionId === undefined) {
			if (event.type === "project/invalidated" && event.reason === "reload_required") {
				for (const [bucketId, bucket] of state.sessions) {
					if (targetsSessionProject(state.sessionsById.get(bucketId), event)) {
						bufferOrInvalidate(bucket, cursor, event);
					}
				}
			} else {
				applyEvent(state, null, event);
			}
			continue;
		}
		if (event.type === "session/updated") {
			applyEvent(state, null, event);
			continue;
		}
		if (event.type === "interaction/notify") {
			if (sessionId === state.activeSessionId) applyEvent(state, null, event);
			continue;
		}
		if (event.type === "session/invalidated") {
			if (event.reason === "deleted") {
				removeSession(state, sessionId);
			} else {
				const session = state.sessions.get(sessionId);
				if (session) bufferOrInvalidate(session, cursor, event);
			}
			continue;
		}
		const session = state.sessions.get(sessionId);
		if (!session) continue;
		if (session.syncStatus === "subscribing") {
			bufferSessionEvent(session, cursor, event);
			continue;
		}
		if (session.syncStatus !== "ready") continue;
		const list = pending.get(session);
		if (list) list.push(event);
		else pending.set(session, [event]);
	}
	for (const [session, events] of pending) {
		if (!canApplyEvents(session, events)) {
			session.syncStatus = "resnapshot_required";
			session.revision += 1;
			continue;
		}
		for (const event of events) {
			applyEvent(state, session, event);
			session.revision += 1;
		}
	}
	state.cursor = batch.toCursor;
	return activeProjection(state)?.syncStatus === "resnapshot_required" ? "resnapshot_required" : "applied";
}

export function prependProjectionItems(
	state: MutableProjectionState,
	sessionId: string,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): void {
	const session = state.sessions.get(sessionId);
	if (!session || page.items.some((item) => item.sessionId !== sessionId)) {
		throw new TypeError("History page does not belong to the session");
	}
	const added: string[] = [];
	for (const item of page.items) {
		if (!session.itemsById.has(item.itemId)) added.push(item.itemId);
		session.itemsById.set(item.itemId, structuredClone(item));
	}
	session.itemOrder = [...added, ...session.itemOrder];
	session.nextBeforeItemId = page.nextBeforeItemId;
	session.revision += 1;
}

export function selectAgentTranscript(
	state: MutableProjectionState,
	sessionId: string,
	agentId: string | null,
	taskId: string | null = null,
): boolean {
	const session = state.sessions.get(sessionId);
	if (!session) return false;
	const transcript = session.agentTranscript;
	if (transcript.agentId === agentId && transcript.taskId === taskId) return false;
	clearAgentTranscript(transcript, agentId, taskId);
	session.revision += 1;
	return true;
}

export function replaceAgentItems(
	state: MutableProjectionState,
	sessionId: string,
	agentId: string,
	taskId: string | null,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): boolean {
	const session = state.sessions.get(sessionId);
	if (!session) return false;
	const transcript = session.agentTranscript;
	if (transcript.agentId !== agentId || transcript.taskId !== taskId) return false;
	if (page.items.some((item) => item.sessionId !== agentId))
		throw new TypeError("History page does not belong to child");
	transcript.itemsById.clear();
	transcript.itemOrder = [];
	for (const item of page.items) {
		transcript.itemsById.set(item.itemId, structuredClone(item));
		transcript.itemOrder.push(item.itemId);
	}
	transcript.nextBeforeItemId = page.nextBeforeItemId;
	session.revision += 1;
	return true;
}

export function prependAgentItems(
	state: MutableProjectionState,
	sessionId: string,
	agentId: string,
	taskId: string | null,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): boolean {
	const session = state.sessions.get(sessionId);
	if (!session) return false;
	const transcript = session.agentTranscript;
	if (transcript.agentId !== agentId || transcript.taskId !== taskId) return false;
	if (page.items.some((item) => item.sessionId !== agentId))
		throw new TypeError("History page does not belong to child");
	const added: string[] = [];
	for (const item of page.items) {
		if (!transcript.itemsById.has(item.itemId)) added.push(item.itemId);
		transcript.itemsById.set(item.itemId, structuredClone(item));
	}
	transcript.itemOrder = [...added, ...transcript.itemOrder];
	transcript.nextBeforeItemId = page.nextBeforeItemId;
	session.revision += 1;
	return true;
}

export function addPendingInteraction(state: MutableProjectionState, interaction: InteractionView): void {
	if (!state.interactionsById.has(interaction.interactionId)) {
		state.interactionOrder = [...state.interactionOrder, interaction.interactionId];
	}
	state.interactionsById.set(interaction.interactionId, structuredClone(interaction));
}

export function removePendingInteraction(state: MutableProjectionState, interactionId: string): void {
	if (!state.interactionsById.delete(interactionId)) return;
	state.interactionOrder = state.interactionOrder.filter((id) => id !== interactionId);
}
