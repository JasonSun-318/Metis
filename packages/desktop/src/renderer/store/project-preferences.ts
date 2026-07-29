import type { AgentMode } from "@arcmind/app-protocol";

const STORAGE_KEY = "arcmind.projectPreferences.v1";
const MAX_ALIAS_CODE_POINTS = 80;

export interface ProjectPreference {
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly alias?: string;
	readonly pinned: boolean;
}

export type ProjectPreferenceMap = ReadonlyMap<string, ProjectPreference>;

interface StoredProjectPreferences {
	readonly version: 1;
	readonly entries: readonly ProjectPreference[];
}

function preferenceKey(mode: AgentMode, cwd: string): string {
	return JSON.stringify([mode, cwd]);
}

function normalizeAlias(alias: string): string | undefined {
	const normalized = [...alias.trim()].slice(0, MAX_ALIAS_CODE_POINTS).join("");
	return normalized || undefined;
}

function parsePreference(value: unknown): ProjectPreference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (Object.keys(entry).some((key) => !["mode", "cwd", "alias", "pinned"].includes(key))) return undefined;
	if ((entry.mode !== "chat" && entry.mode !== "code") || typeof entry.cwd !== "string" || !entry.cwd.trim()) {
		return undefined;
	}
	if (typeof entry.pinned !== "boolean" || (entry.alias !== undefined && typeof entry.alias !== "string")) {
		return undefined;
	}
	const alias = entry.alias === undefined ? undefined : normalizeAlias(entry.alias);
	return { mode: entry.mode, cwd: entry.cwd, pinned: entry.pinned, ...(alias ? { alias } : {}) };
}

export function loadProjectPreferences(storage: Pick<Storage, "getItem">): ProjectPreferenceMap {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		if (raw === null) return new Map();
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
		const record = parsed as Record<string, unknown>;
		if (Object.keys(record).some((key) => !["version", "entries"].includes(key))) return new Map();
		if (record.version !== 1 || !Array.isArray(record.entries)) return new Map();
		const preferences = new Map<string, ProjectPreference>();
		for (const value of record.entries) {
			const preference = parsePreference(value);
			if (preference) preferences.set(preferenceKey(preference.mode, preference.cwd), preference);
		}
		return preferences;
	} catch {
		return new Map();
	}
}

export function saveProjectPreferences(storage: Pick<Storage, "setItem">, preferences: ProjectPreferenceMap): void {
	const document: StoredProjectPreferences = {
		version: 1,
		entries: [...preferences.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, preference]) => preference),
	};
	storage.setItem(STORAGE_KEY, JSON.stringify(document));
}

export function setProjectAlias(
	preferences: ProjectPreferenceMap,
	mode: AgentMode,
	cwd: string,
	alias: string,
): ProjectPreferenceMap {
	const next = new Map(preferences);
	const key = preferenceKey(mode, cwd);
	const existing = next.get(key);
	const normalized = normalizeAlias(alias);
	if (!normalized && !existing?.pinned) {
		next.delete(key);
	} else {
		next.set(key, { mode, cwd, pinned: existing?.pinned ?? false, ...(normalized ? { alias: normalized } : {}) });
	}
	return next;
}

export function setProjectPinned(
	preferences: ProjectPreferenceMap,
	mode: AgentMode,
	cwd: string,
	pinned: boolean,
): ProjectPreferenceMap {
	const next = new Map(preferences);
	const key = preferenceKey(mode, cwd);
	const existing = next.get(key);
	if (!pinned && !existing?.alias) {
		next.delete(key);
	} else {
		next.set(key, { mode, cwd, pinned, ...(existing?.alias ? { alias: existing.alias } : {}) });
	}
	return next;
}

export function removeProjectPreference(
	preferences: ProjectPreferenceMap,
	mode: AgentMode,
	cwd: string,
): ProjectPreferenceMap {
	const next = new Map(preferences);
	next.delete(preferenceKey(mode, cwd));
	return next;
}
