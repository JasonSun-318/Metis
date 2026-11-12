const STORAGE_KEY = "metis.projectPreferences.v3";
const MAX_ALIAS_CODE_POINTS = 80;

export interface ProjectPreference {
	readonly cwd: string;
	readonly alias?: string;
	readonly pinned: boolean;
}

export type ProjectPreferenceMap = ReadonlyMap<string, ProjectPreference>;

interface StoredProjectPreferences {
	readonly version: 1;
	readonly entries: readonly ProjectPreference[];
}

function normalizeAlias(alias: string): string | undefined {
	const normalized = [...alias.trim()].slice(0, MAX_ALIAS_CODE_POINTS).join("");
	return normalized || undefined;
}

function parsePreference(value: unknown): ProjectPreference | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (Object.keys(entry).some((key) => !["cwd", "alias", "pinned"].includes(key))) return undefined;
	if (typeof entry.cwd !== "string" || !entry.cwd.trim()) return undefined;
	if (typeof entry.pinned !== "boolean" || (entry.alias !== undefined && typeof entry.alias !== "string")) {
		return undefined;
	}
	const alias = entry.alias === undefined ? undefined : normalizeAlias(entry.alias);
	return { cwd: entry.cwd, pinned: entry.pinned, ...(alias ? { alias } : {}) };
}

function parseDocument(raw: string): readonly unknown[] | undefined {
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	if (Object.keys(record).some((key) => !["version", "entries"].includes(key))) return undefined;
	if (record.version !== 1 || !Array.isArray(record.entries)) return undefined;
	return record.entries;
}

export function loadProjectPreferences(storage: Pick<Storage, "getItem">): ProjectPreferenceMap {
	try {
		const raw = storage.getItem(STORAGE_KEY);
		const entries = raw === null ? undefined : parseDocument(raw);
		if (entries) {
			const preferences = new Map<string, ProjectPreference>();
			for (const value of entries) {
				const preference = parsePreference(value);
				if (preference) preferences.set(preference.cwd, preference);
			}
			return preferences;
		}
		return new Map();
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

export function setProjectAlias(preferences: ProjectPreferenceMap, cwd: string, alias: string): ProjectPreferenceMap {
	const next = new Map(preferences);
	const existing = next.get(cwd);
	const normalized = normalizeAlias(alias);
	if (!normalized && !existing?.pinned) {
		next.delete(cwd);
	} else {
		next.set(cwd, { cwd, pinned: existing?.pinned ?? false, ...(normalized ? { alias: normalized } : {}) });
	}
	return next;
}

export function setProjectPinned(
	preferences: ProjectPreferenceMap,
	cwd: string,
	pinned: boolean,
): ProjectPreferenceMap {
	const next = new Map(preferences);
	const existing = next.get(cwd);
	if (!pinned && !existing?.alias) {
		next.delete(cwd);
	} else {
		next.set(cwd, { cwd, pinned, ...(existing?.alias ? { alias: existing.alias } : {}) });
	}
	return next;
}

export function removeProjectPreference(preferences: ProjectPreferenceMap, cwd: string): ProjectPreferenceMap {
	const next = new Map(preferences);
	next.delete(cwd);
	return next;
}
