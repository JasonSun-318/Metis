import { isWorkMode, WORK_MODE_KEY } from "./work-mode.ts";

const PROJECT_PREFERENCES_KEY = "metis.projectPreferences.v3";
const LEGACY_PROJECT_KEYS = ["metis.projectPreferences.v2", "metis.projectPreferences.v1"] as const;
const SESSION_GROUPING_KEY = "metis.session-grouping.v2";
const LEGACY_SESSION_GROUPING_KEY = "metis.session-grouping.v1";
const GROUPING_VALUES = ["date", "project", "status", "unread", "none"] as const;
const MAX_ALIAS_CODE_POINTS = 80;

function parseDocument(raw: string | null): Record<string, unknown>[] | undefined {
	if (raw === null) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || !Array.isArray(record.entries)) return undefined;
		return record.entries as Record<string, unknown>[];
	} catch {
		return undefined;
	}
}

function isValidProjectPreferences(raw: string | null): boolean {
	return parseDocument(raw) !== undefined;
}

function migrateProjectPreferences(storage: Storage, workMode: string): boolean {
	if (isValidProjectPreferences(storage.getItem(PROJECT_PREFERENCES_KEY))) return false;
	let legacy: Record<string, unknown>[] | undefined;
	let legacyKey: string | undefined;
	for (const key of LEGACY_PROJECT_KEYS) {
		const entries = parseDocument(storage.getItem(key));
		if (!entries) continue;
		legacy = entries;
		legacyKey = key;
		break;
	}
	if (!legacy || !legacyKey) return false;
	const merged = new Map<string, Record<string, unknown>>();
	const ranked = [...legacy].sort((left, right) => Number(right.mode === workMode) - Number(left.mode === workMode));
	for (const entry of ranked) {
		const cwd = entry.cwd;
		if (typeof cwd !== "string" || !cwd.trim() || merged.has(cwd)) continue;
		if (typeof entry.pinned !== "boolean") continue;
		const alias =
			typeof entry.alias === "string" && entry.alias.trim()
				? [...entry.alias.trim()].slice(0, MAX_ALIAS_CODE_POINTS).join("")
				: undefined;
		merged.set(cwd, { cwd, pinned: entry.pinned, ...(alias ? { alias } : {}) });
	}
	for (const key of LEGACY_PROJECT_KEYS) storage.removeItem(key);
	if (merged.size === 0) return false;
	storage.setItem(
		PROJECT_PREFERENCES_KEY,
		JSON.stringify({
			version: 1,
			entries: [...merged.values()].sort((left, right) => String(left.cwd).localeCompare(String(right.cwd))),
		}),
	);
	return true;
}

function migrateSessionGrouping(storage: Storage, workMode: string): boolean {
	const current = storage.getItem(SESSION_GROUPING_KEY);
	if (current !== null && GROUPING_VALUES.includes(current as (typeof GROUPING_VALUES)[number])) return false;
	const legacyRaw = storage.getItem(LEGACY_SESSION_GROUPING_KEY);
	if (legacyRaw === null) return false;
	let selected: string = "date";
	try {
		const legacy = JSON.parse(legacyRaw) as Record<string, unknown> | null;
		const candidate = legacy?.[workMode];
		if (typeof candidate === "string" && GROUPING_VALUES.includes(candidate as (typeof GROUPING_VALUES)[number])) {
			selected = candidate;
		}
	} catch {
		// Keep daily grouping.
	}
	storage.removeItem(LEGACY_SESSION_GROUPING_KEY);
	storage.setItem(SESSION_GROUPING_KEY, selected);
	return true;
}

/**
 * Convert preferences written before the unified session model.
 *
 * Older builds stored project preferences and session grouping per chat/code
 * mode; the unified app keeps one value of each. The UI work mode is preserved,
 * so the user lands on the same lens they last used. Runs once and is a no-op
 * for fresh installs and for already migrated profiles.
 */
export function migrateLegacyDesktopPreferences(storage: Storage = localStorage): void {
	try {
		const stored = storage.getItem(WORK_MODE_KEY);
		const workMode = isWorkMode(stored)
			? stored
			: storage.getItem("metis.activeSessionId.code") === null
				? "chat"
				: "code";
		if (stored !== workMode) storage.setItem(WORK_MODE_KEY, workMode);
		migrateProjectPreferences(storage, workMode);
		migrateSessionGrouping(storage, workMode);
	} catch {
		// Preferences are best-effort; the app falls back to defaults.
	}
}
