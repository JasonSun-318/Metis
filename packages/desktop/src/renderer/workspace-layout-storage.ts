import type { SessionWorkspace, WorkspacePane, WorkspaceTab } from "./workspace-tabs.ts";

/**
 * Safe persistence of split layouts: a strict whitelist schema holding only pane structure,
 * preferred weights, active references and live chat/agent references. Draft (null-session)
 * chats, tool tabs and their payloads are never written; corrupt or stale data falls back to
 * null instead of partially restoring.
 */

export const WORKSPACE_LAYOUT_STORAGE_KEY = "metis.workspace-layout.v1";

const SCHEMA_VERSION = 1;
const MAX_SAVED_PANES = 6;
const MAX_SAVED_TABS_PER_PANE = 64;
const MAX_SAVED_NEXT_NUMBER = 1_000_000;

interface StoredChatRef {
	readonly sessionId: string;
	readonly agentId?: string;
	readonly agentName?: string;
}

interface StoredPane {
	readonly id: string;
	readonly row: 0 | 1;
	readonly weight?: number;
	readonly placeholder?: boolean;
	/** Index of the active chat within this pane's saved chats, or -1 when none. */
	readonly activeIndex: number;
	readonly chats: readonly StoredChatRef[];
}

interface StoredLayout {
	readonly version: 1;
	readonly activePaneId: string;
	readonly nextNumber: number;
	readonly rowWeights?: readonly [number, number];
	readonly panes: readonly StoredPane[];
}

type LayoutStorage = Pick<Storage, "getItem" | "setItem">;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function positiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Serializes the whitelist schema; chat tabs without a live session reference are skipped. */
export function serializeWorkspaceLayout(workspace: SessionWorkspace): string {
	const panes: StoredPane[] = [];
	for (const pane of workspace.panes) {
		// Only chat references to real sessions persist; drafts and tool tabs stay runtime-only.
		const chats: StoredChatRef[] = [];
		let activeIndex = -1;
		for (const tab of pane.tabs.slice(0, MAX_SAVED_TABS_PER_PANE)) {
			if (tab.kind !== "chat" || tab.sessionId === null) continue;
			const sessionId: string = tab.sessionId;
			if (!chats.some((candidate) => candidate.sessionId === sessionId && candidate.agentId === tab.agentId)) {
				chats.push({
					sessionId,
					...(tab.agentId !== undefined ? { agentId: tab.agentId } : {}),
					...(tab.agentName !== undefined ? { agentName: tab.agentName } : {}),
				});
			}
			if (pane.activeId === tab.id) activeIndex = chats.length - 1;
		}
		if (chats.length === 0 && pane.placeholder !== true) continue;
		panes.push({
			id: pane.id,
			row: pane.row,
			...(positiveFinite(pane.weight) ? { weight: pane.weight } : {}),
			...(pane.placeholder === true ? { placeholder: true } : {}),
			activeIndex,
			chats,
		});
	}
	const savedPanes = panes.slice(0, MAX_SAVED_PANES);
	// Draft-only panes are omitted, so the saved layout may lose its active pane or entire top row.
	const hasTopRow = savedPanes.some((pane) => pane.row === 0);
	const normalizedPanes = hasTopRow ? savedPanes : savedPanes.map((pane) => ({ ...pane, row: 0 as const }));
	const activePaneId =
		normalizedPanes.find((pane) => pane.id === workspace.activePaneId)?.id ?? normalizedPanes[0]?.id ?? "";
	const rowWeights = workspace.rowWeights;
	const validRowWeights =
		hasTopRow && rowWeights !== undefined && positiveFinite(rowWeights[0]) && positiveFinite(rowWeights[1])
			? { rowWeights: [rowWeights[0], rowWeights[1]] as readonly [number, number] }
			: {};
	const layout: StoredLayout = {
		version: SCHEMA_VERSION,
		activePaneId,
		nextNumber: Math.max(1, Math.min(Math.floor(workspace.nextNumber) || 1, MAX_SAVED_NEXT_NUMBER)),
		panes: normalizedPanes,
		...validRowWeights,
	};
	return JSON.stringify(layout);
}

function restorePane(raw: unknown, canRestoreSession: (id: string) => boolean): WorkspacePane | null {
	if (!isPlainObject(raw)) return null;
	const { id, row, chats, activeIndex } = raw;
	if (!nonemptyString(id)) return null;
	if (row !== 0 && row !== 1) return null;
	const active = typeof activeIndex === "number" && Number.isInteger(activeIndex) ? activeIndex : -1;
	if (active < -1 || active >= MAX_SAVED_TABS_PER_PANE) return null;
	if (raw.weight !== undefined && !positiveFinite(raw.weight)) return null;
	if (raw.placeholder !== undefined && typeof raw.placeholder !== "boolean") return null;
	if (chats !== undefined && !Array.isArray(chats)) return null;
	const chatRefs = (chats ?? []) as unknown[];
	if (chatRefs.length > MAX_SAVED_TABS_PER_PANE) return null;
	const tabs: WorkspaceTab[] = [];
	let activeId = "";
	for (const [index, entry] of chatRefs.entries()) {
		if (!isPlainObject(entry) || !nonemptyString(entry.sessionId)) return null;
		if (entry.agentId !== undefined && !nonemptyString(entry.agentId)) return null;
		if (entry.agentName !== undefined && typeof entry.agentName !== "string") return null;
		if (!canRestoreSession(entry.sessionId)) continue;
		tabs.push({
			kind: "chat",
			id: `chat-${crypto.randomUUID()}`,
			sessionId: entry.sessionId,
			...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
			...(entry.agentName !== undefined ? { agentName: entry.agentName } : {}),
		});
		if (index === active) activeId = tabs.at(-1)!.id;
	}
	const placeholder = raw.placeholder === true;
	if (tabs.length === 0 && !placeholder) return null;
	return {
		id,
		row,
		tabs,
		activeId,
		...(positiveFinite(raw.weight) ? { weight: raw.weight } : {}),
		...(placeholder ? { placeholder: true } : {}),
	};
}

/**
 * Parses and validates a stored layout. Chats whose session is no longer live (per
 * `canRestoreSession`) are dropped; panes left without content or placeholders, duplicate pane
 * IDs, row overflows, dead active-pane references or any malformed value return null.
 */
export function restoreWorkspaceLayout(
	raw: string | null,
	canRestoreSession: (id: string) => boolean,
): SessionWorkspace | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(parsed) || parsed.version !== SCHEMA_VERSION) return null;
	if (!Array.isArray(parsed.panes) || parsed.panes.length === 0 || parsed.panes.length > MAX_SAVED_PANES) return null;
	const activePaneId: unknown = parsed.activePaneId;
	if (!nonemptyString(activePaneId)) return null;
	const nextNumber: unknown = parsed.nextNumber;
	if (
		typeof nextNumber !== "number" ||
		!Number.isInteger(nextNumber) ||
		nextNumber < 1 ||
		nextNumber > MAX_SAVED_NEXT_NUMBER
	) {
		return null;
	}
	const rawRowWeights: unknown = parsed.rowWeights;
	let rowWeights: readonly [number, number] | undefined;
	if (rawRowWeights !== undefined) {
		if (
			!Array.isArray(rawRowWeights) ||
			rawRowWeights.length !== 2 ||
			typeof rawRowWeights[0] !== "number" ||
			typeof rawRowWeights[1] !== "number" ||
			!positiveFinite(rawRowWeights[0]) ||
			!positiveFinite(rawRowWeights[1])
		) {
			return null;
		}
		rowWeights = [rawRowWeights[0], rawRowWeights[1]];
	}
	const panes: WorkspacePane[] = [];
	const seenIds = new Set<string>();
	for (const entry of parsed.panes) {
		const pane = restorePane(entry, canRestoreSession);
		if (!pane || seenIds.has(pane.id)) return null;
		seenIds.add(pane.id);
		panes.push(pane);
	}
	if (panes.length === 0) return null;
	for (const row of [0, 1] as const) {
		if (panes.filter((pane) => pane.row === row).length > 3) return null;
	}
	if (!panes.some((pane) => pane.row === 0)) return null;
	// The stored active pane must reference a live pane in the restored layout.
	if (!seenIds.has(activePaneId)) return null;
	return {
		panes,
		activePaneId,
		nextNumber,
		tools: new Map(),
		...(rowWeights !== undefined ? { rowWeights } : {}),
	};
}

/** Reads and validates the layout from storage; unreadable or missing entries yield null. */
export function loadWorkspaceLayout(
	storage: LayoutStorage,
	predicate: (id: string) => boolean,
): SessionWorkspace | null {
	let raw: string | null = null;
	try {
		raw = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
	} catch {
		return null;
	}
	return restoreWorkspaceLayout(raw, predicate);
}

/**
 * Persists the layout whitelist. Storage failures (quota, private mode, unavailable backend)
 * leave existing data untouched; layout persistence is best-effort and never blocks the app.
 */
export function saveWorkspaceLayout(storage: LayoutStorage, workspace: SessionWorkspace): void {
	try {
		storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, serializeWorkspaceLayout(workspace));
	} catch {
		// Unavailable or full storage must not surface in the workspace lifecycle.
	}
}
