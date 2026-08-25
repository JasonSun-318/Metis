import type {
	AgentMode,
	ConnectionEventsParams,
	DomainEvent,
	InteractionView,
	ItemView,
	QueuedTurnView,
	SessionSnapshot,
	SessionSummary,
	SubagentSummaryView,
	ThinkingSelectionView,
	TurnView,
} from "@metis/app-protocol";

export type ProjectionSyncStatus = "empty" | "ready" | "resubscribing" | "resnapshot_required";
export type BatchApplyResult = "applied" | "resnapshot_required";

export interface MutableSubagentTranscriptState {
	agentId: string | null;
	readonly itemsById: Map<string, ItemView>;
	itemOrder: string[];
	nextBeforeItemId: string | null;
	journalRevision: number;
}

export interface MutableProjectionState {
	readonly sessionsById: Map<string, SessionSummary>;
	sessionOrder: string[];
	activeSessionId: string | null;
	readonly turnsById: Map<string, TurnView>;
	turnOrder: string[];
	readonly itemsById: Map<string, ItemView>;
	itemOrder: string[];
	readonly interactionsById: Map<string, InteractionView>;
	interactionOrder: string[];
	notifications: Array<Extract<DomainEvent, { type: "interaction/notify" }>>;
	nextBeforeItemId: string | null;
	activeTurnId: string | null;
	serverEpoch: string | null;
	cursor: number;
	syncStatus: ProjectionSyncStatus;
	collaborationMode: SessionSnapshot["collaborationMode"];
	permissionMode: SessionSnapshot["permissionMode"];
	thinkingSelection: ThinkingSelectionView;
	actualThinkingLevel: Exclude<ThinkingSelectionView, "ultra">;
	availableThinkingSelections: ThinkingSelectionView[];
	model: SessionSnapshot["model"];
	availableModels: NonNullable<SessionSnapshot["availableModels"]>;
	subagents: SubagentSummaryView[];
	tasks: SessionSnapshot["tasks"];
	deliveredFiles: SessionSnapshot["deliveredFiles"];
	goal: SessionSnapshot["goal"];
	queuedTurns: QueuedTurnView[];
	readonly subagentTranscript: MutableSubagentTranscriptState;
}

function clearSubagentTranscript(state: MutableSubagentTranscriptState, agentId: string | null = null): void {
	state.agentId = agentId;
	state.itemsById.clear();
	state.itemOrder = [];
	state.nextBeforeItemId = null;
	state.journalRevision = 0;
}

export function createProjectionState(): MutableProjectionState {
	return {
		sessionsById: new Map(),
		sessionOrder: [],
		activeSessionId: null,
		turnsById: new Map(),
		turnOrder: [],
		itemsById: new Map(),
		itemOrder: [],
		interactionsById: new Map(),
		interactionOrder: [],
		notifications: [],
		nextBeforeItemId: null,
		activeTurnId: null,
		serverEpoch: null,
		cursor: 0,
		syncStatus: "empty",
		collaborationMode: "default",
		permissionMode: "auto",
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		model: undefined,
		availableModels: [],
		subagents: [],
		tasks: [],
		deliveredFiles: [],
		goal: null,
		queuedTurns: [],
		subagentTranscript: {
			agentId: null,
			itemsById: new Map(),
			itemOrder: [],
			nextBeforeItemId: null,
			journalRevision: 0,
		},
	};
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

export function removeSession(state: MutableProjectionState, sessionId: string): boolean {
	if (!state.sessionsById.delete(sessionId)) return false;
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
	state.turnsById.clear();
	state.turnOrder = [];
	state.itemsById.clear();
	state.itemOrder = [];
	state.nextBeforeItemId = null;
	state.activeTurnId = null;
	state.serverEpoch = null;
	state.cursor = 0;
	state.syncStatus = "empty";
	state.collaborationMode = "default";
	state.permissionMode = "auto";
	state.subagents = [];
	state.tasks = [];
	state.goal = null;
	state.queuedTurns = [];
	clearSubagentTranscript(state.subagentTranscript);
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
	for (const sessionId of removed) {
		state.sessionsById.delete(sessionId);
	}
	state.sessionOrder = state.sessionOrder.filter((sessionId) => !removed.has(sessionId));
	state.notifications = state.notifications.filter(
		(notification) => notification.sessionId === undefined || !removed.has(notification.sessionId),
	);
	if (!state.activeSessionId || !removed.has(state.activeSessionId)) return true;

	state.activeSessionId = null;
	state.turnsById.clear();
	state.turnOrder = [];
	state.itemsById.clear();
	state.itemOrder = [];
	state.interactionsById.clear();
	state.interactionOrder = [];
	state.nextBeforeItemId = null;
	state.activeTurnId = null;
	state.serverEpoch = null;
	state.cursor = 0;
	state.syncStatus = "empty";
	state.collaborationMode = "default";
	state.permissionMode = "auto";
	state.subagents = [];
	state.tasks = [];
	state.goal = null;
	state.queuedTurns = [];
	clearSubagentTranscript(state.subagentTranscript);
	return true;
}

export function replaceProjectionSnapshot(state: MutableProjectionState, snapshotValue: SessionSnapshot): void {
	const snapshot = structuredClone(snapshotValue);
	const sessionId = snapshot.session.sessionId;
	const sessionChanged = state.activeSessionId !== sessionId;
	state.sessionsById.set(sessionId, snapshot.session);
	if (!state.sessionOrder.includes(sessionId)) state.sessionOrder.unshift(sessionId);
	state.activeSessionId = sessionId;

	state.turnsById.clear();
	state.turnOrder = [];
	for (const turn of snapshot.turns) {
		state.turnsById.set(turn.turnId, turn);
		state.turnOrder.push(turn.turnId);
	}

	state.itemsById.clear();
	state.itemOrder = [];
	for (const item of snapshot.recentItems) {
		state.itemsById.set(item.itemId, item);
		state.itemOrder.push(item.itemId);
	}

	state.interactionsById.clear();
	state.interactionOrder = [];
	for (const interaction of snapshot.pendingInteractions) {
		state.interactionsById.set(interaction.interactionId, interaction);
		state.interactionOrder.push(interaction.interactionId);
	}
	state.notifications = [];

	state.nextBeforeItemId = snapshot.nextBeforeItemId;
	state.activeTurnId = snapshot.activeTurnId;
	state.serverEpoch = snapshot.serverEpoch;
	state.cursor = snapshot.cursor;
	state.syncStatus = "ready";
	state.collaborationMode = snapshot.collaborationMode;
	state.permissionMode = snapshot.permissionMode;
	state.thinkingSelection = snapshot.thinkingSelection;
	state.actualThinkingLevel = snapshot.actualThinkingLevel;
	state.availableThinkingSelections = snapshot.availableThinkingSelections;
	state.model = snapshot.model;
	state.availableModels = snapshot.availableModels ?? [];
	state.subagents = snapshot.subagents;
	state.tasks = snapshot.tasks;
	state.deliveredFiles = snapshot.deliveredFiles;
	state.goal = snapshot.goal;
	state.queuedTurns = snapshot.queuedTurns;
	if (sessionChanged) clearSubagentTranscript(state.subagentTranscript);
	else if (state.subagentTranscript.agentId) state.subagentTranscript.journalRevision += 1;
}

export function markProjectionResubscribing(state: MutableProjectionState): void {
	state.syncStatus = "resubscribing";
}

export function restoreProjectionSyncStatus(
	state: MutableProjectionState,
	previous: Pick<MutableProjectionState, "activeSessionId" | "serverEpoch" | "syncStatus">,
): boolean {
	if (
		state.syncStatus !== "resubscribing" ||
		state.activeSessionId !== previous.activeSessionId ||
		state.serverEpoch !== previous.serverEpoch
	) {
		return false;
	}
	state.syncStatus = previous.syncStatus;
	return true;
}

function eventSessionId(event: DomainEvent): string | undefined {
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
		case "session/permissionModeChanged":
		case "session/collaborationModeChanged":
		case "session/thinkingSelectionChanged":
		case "subagent/updated":
		case "subagent/item/started":
		case "subagent/item/delta":
		case "subagent/item/completed":
		case "subagent/itemsChanged":
		case "session/modelChanged":
		case "session/tasksChanged":
		case "session/deliveredFilesChanged":
		case "session/goalChanged":
		case "turn/queueChanged":
			return event.sessionId;
		case "interaction/notify":
			return event.sessionId;
		case "project/invalidated":
		case "server/state":
			return undefined;
	}
}

function targetsActiveProject(
	state: MutableProjectionState,
	event: Extract<DomainEvent, { type: "project/invalidated" }>,
): boolean {
	const active = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	return active?.scheduled === undefined && active?.mode === event.mode && active.cwd === event.cwd;
}

function canApplyEvents(state: MutableProjectionState, events: readonly DomainEvent[]): boolean {
	const activeSessionId = state.activeSessionId;
	if (!activeSessionId) return false;
	const itemStates = new Map<string, ItemView["state"]>();
	for (const event of events) {
		const sessionId = eventSessionId(event);
		if (event.type === "session/invalidated") continue;
		if (sessionId !== undefined && sessionId !== activeSessionId && event.type !== "session/updated") return false;
		switch (event.type) {
			case "item/started":
			case "item/completed":
				itemStates.set(event.item.itemId, event.item.state);
				break;
			case "item/delta": {
				const stateBeforeDelta = itemStates.get(event.itemId) ?? state.itemsById.get(event.itemId)?.state;
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

function applyEvent(state: MutableProjectionState, event: DomainEvent): void {
	switch (event.type) {
		case "server/state":
			return;
		case "interaction/notify":
			state.notifications = [...state.notifications.slice(-99), structuredClone(event)];
			return;
		case "session/invalidated":
			if (event.reason === "deleted") removeSession(state, event.sessionId);
			else if (state.activeSessionId === event.sessionId) state.syncStatus = "resnapshot_required";
			return;
		case "project/invalidated":
			if (event.reason === "deleted") removeModeProjectSessions(state, event.mode, event.cwd);
			else if (targetsActiveProject(state, event)) state.syncStatus = "resnapshot_required";
			return;
		case "session/updated":
			state.sessionOrder = upsertOrdered(
				state.sessionsById,
				state.sessionOrder,
				event.session.sessionId,
				structuredClone(event.session),
			);
			return;
		case "session/permissionModeChanged":
			state.permissionMode = event.permissionMode;
			return;
		case "session/collaborationModeChanged":
			state.collaborationMode = event.collaborationMode;
			return;
		case "session/thinkingSelectionChanged":
			state.thinkingSelection = event.thinkingSelection;
			state.actualThinkingLevel = event.actualThinkingLevel;
			state.availableThinkingSelections = event.availableThinkingSelections;
			return;
		case "session/modelChanged":
			state.model = event.model;
			state.thinkingSelection = event.thinkingSelection;
			state.actualThinkingLevel = event.actualThinkingLevel;
			state.availableThinkingSelections = event.availableThinkingSelections;
			return;
		case "session/tasksChanged":
			state.tasks = structuredClone(event.tasks);
			return;
		case "session/deliveredFilesChanged":
			state.deliveredFiles = structuredClone(event.deliveredFiles);
			return;
		case "session/goalChanged":
			state.goal = structuredClone(event.goal);
			return;
		case "turn/queueChanged":
			state.queuedTurns = structuredClone(event.queuedTurns);
			return;
		case "subagent/updated": {
			const index = state.subagents.findIndex((candidate) => candidate.agentId === event.subagent.agentId);
			state.subagents =
				index < 0
					? [...state.subagents, structuredClone(event.subagent)]
					: state.subagents.map((candidate, current) =>
							current === index ? structuredClone(event.subagent) : candidate,
						);
			return;
		}
		case "subagent/item/started":
		case "subagent/item/completed":
			if (state.subagentTranscript.agentId === event.agentId) {
				state.subagentTranscript.itemOrder = upsertOrdered(
					state.subagentTranscript.itemsById,
					state.subagentTranscript.itemOrder,
					event.item.itemId,
					structuredClone(event.item),
				);
			}
			return;
		case "subagent/item/delta": {
			if (state.subagentTranscript.agentId !== event.agentId) return;
			const item = state.subagentTranscript.itemsById.get(event.itemId);
			if (item?.state === "streaming") {
				state.subagentTranscript.itemsById.set(event.itemId, appendItemDelta(item, event.delta));
			}
			return;
		}
		case "subagent/itemsChanged":
			if (state.subagentTranscript.agentId === event.agentId) state.subagentTranscript.journalRevision += 1;
			return;
		case "turn/started":
		case "turn/completed":
		case "turn/interrupted":
			state.turnOrder = upsertOrdered(
				state.turnsById,
				state.turnOrder,
				event.turn.turnId,
				structuredClone(event.turn),
			);
			if (event.turn.state === "running") state.activeTurnId = event.turn.turnId;
			else if (state.activeTurnId === event.turn.turnId) state.activeTurnId = null;
			return;
		case "item/started":
		case "item/completed":
			state.itemOrder = upsertOrdered(
				state.itemsById,
				state.itemOrder,
				event.item.itemId,
				structuredClone(event.item),
			);
			return;
		case "item/delta":
			state.itemsById.set(event.itemId, appendItemDelta(state.itemsById.get(event.itemId)!, event.delta));
	}
}

export function applyConnectionEvents(state: MutableProjectionState, batch: ConnectionEventsParams): BatchApplyResult {
	const invalid =
		state.syncStatus !== "ready" ||
		batch.serverEpoch !== state.serverEpoch ||
		batch.fromCursor !== state.cursor + 1 ||
		batch.toCursor < batch.fromCursor ||
		!canApplyEvents(state, batch.events);
	if (invalid) {
		if (
			batch.serverEpoch === state.serverEpoch &&
			batch.fromCursor > state.cursor &&
			batch.toCursor >= batch.fromCursor
		) {
			for (const event of batch.events) {
				if (event.type === "session/updated") applyEvent(state, event);
			}
		}
		state.syncStatus = "resnapshot_required";
		return "resnapshot_required";
	}

	const reloadRequired = batch.events.some(
		(event) =>
			(event.type === "session/invalidated" &&
				event.reason === "reload_required" &&
				event.sessionId === state.activeSessionId) ||
			(event.type === "project/invalidated" &&
				event.reason === "reload_required" &&
				targetsActiveProject(state, event)),
	);
	for (const event of batch.events) applyEvent(state, event);
	if (reloadRequired) return "resnapshot_required";
	state.cursor = batch.toCursor;
	return "applied";
}

export function prependProjectionItems(
	state: MutableProjectionState,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): void {
	const activeSessionId = state.activeSessionId;
	if (!activeSessionId || page.items.some((item) => item.sessionId !== activeSessionId)) {
		throw new TypeError("History page does not belong to the active session");
	}
	const added: string[] = [];
	for (const item of page.items) {
		if (!state.itemsById.has(item.itemId)) added.push(item.itemId);
		state.itemsById.set(item.itemId, structuredClone(item));
	}
	state.itemOrder = [...added, ...state.itemOrder];
	state.nextBeforeItemId = page.nextBeforeItemId;
}

export function selectSubagentTranscript(state: MutableProjectionState, agentId: string | null): boolean {
	if (state.subagentTranscript.agentId === agentId) return false;
	clearSubagentTranscript(state.subagentTranscript, agentId);
	return true;
}

export function replaceSubagentItems(
	state: MutableProjectionState,
	agentId: string,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): boolean {
	if (state.subagentTranscript.agentId !== agentId) return false;
	if (page.items.some((item) => item.sessionId !== agentId))
		throw new TypeError("History page does not belong to child");
	state.subagentTranscript.itemsById.clear();
	state.subagentTranscript.itemOrder = [];
	for (const item of page.items) {
		state.subagentTranscript.itemsById.set(item.itemId, structuredClone(item));
		state.subagentTranscript.itemOrder.push(item.itemId);
	}
	state.subagentTranscript.nextBeforeItemId = page.nextBeforeItemId;
	return true;
}

export function prependSubagentItems(
	state: MutableProjectionState,
	agentId: string,
	page: { readonly items: readonly ItemView[]; readonly nextBeforeItemId: string | null },
): boolean {
	if (state.subagentTranscript.agentId !== agentId) return false;
	if (page.items.some((item) => item.sessionId !== agentId))
		throw new TypeError("History page does not belong to child");
	const added: string[] = [];
	for (const item of page.items) {
		if (!state.subagentTranscript.itemsById.has(item.itemId)) added.push(item.itemId);
		state.subagentTranscript.itemsById.set(item.itemId, structuredClone(item));
	}
	state.subagentTranscript.itemOrder = [...added, ...state.subagentTranscript.itemOrder];
	state.subagentTranscript.nextBeforeItemId = page.nextBeforeItemId;
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
