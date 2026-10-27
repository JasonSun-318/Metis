import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserProfile,
	type DesktopBrowserSourceId,
	type DesktopHistoryEntry,
	validateBrowserHistoryEntry,
	validateBrowserProfileList,
} from "../shared/desktop-api.ts";

interface StoredImportedProfile extends DesktopBrowserProfile {
	readonly rootFingerprint: string | null;
}

const PROFILE_FILE = "browser-profiles.json";
const IMPORT_LOCATIONS_FILE = "browser-import-locations.json";
const IMPORT_SOURCE_IDS: readonly DesktopBrowserSourceId[] = ["chrome", "edge", "brave", "chromium"];
const DEFAULT_PROFILE: StoredImportedProfile = {
	profileId: DEFAULT_BROWSER_PROFILE_ID,
	name: "Default",
	sourceId: null,
	sourceProfileId: null,
	rootFingerprint: null,
};

export interface ImportedProfileIdentity {
	readonly sourceId: DesktopBrowserSourceId;
	readonly sourceProfileId: string;
	readonly name: string;
	/** Canonical root realpath. Omitted only for the platform default root. */
	readonly rootPath?: string;
}

export function browserRootFingerprint(rootPath: string): string {
	return createHash("sha256").update(rootPath).digest("hex").slice(0, 32);
}

export function mergeBrowserHistory(
	existing: readonly DesktopHistoryEntry[],
	imported: readonly DesktopHistoryEntry[],
): readonly DesktopHistoryEntry[] {
	const byUrl = new Map<string, DesktopHistoryEntry>();
	for (const entry of [...existing, ...imported]) {
		let url: string;
		try {
			url = new URL(entry.url).toString();
		} catch {
			continue;
		}
		const normalized = { ...entry, url };
		const previous = byUrl.get(url);
		if (!previous || normalized.visitedAt > previous.visitedAt) byUrl.set(url, normalized);
	}
	return [...byUrl.values()].sort((left, right) => right.visitedAt - left.visitedAt).slice(0, 500);
}

function publicProfile(profile: StoredImportedProfile): DesktopBrowserProfile {
	const { rootFingerprint: _rootFingerprint, ...visible } = profile;
	return visible;
}

function storedRootFingerprint(candidate: unknown): string | null {
	if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
	const fingerprint = (candidate as { rootFingerprint?: unknown }).rootFingerprint;
	return typeof fingerprint === "string" && /^[a-f0-9]{32}$/u.test(fingerprint) ? fingerprint : null;
}

function validImportRoot(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4_096 &&
		!value.includes("\0") &&
		isAbsolute(value)
	);
}

export class BrowserProfileStore {
	private readonly userDataPath: string;
	private profiles?: readonly StoredImportedProfile[];
	private importRoots?: Partial<Record<DesktopBrowserSourceId, string>>;

	constructor(userDataPath: string) {
		this.userDataPath = userDataPath;
	}

	listProfiles(): readonly DesktopBrowserProfile[] {
		this.profiles ??= [DEFAULT_PROFILE, ...this.readImportedProfiles()];
		return this.profiles.map(publicProfile);
	}

	getImportRoots(): Partial<Record<DesktopBrowserSourceId, string>> {
		this.importRoots ??= this.readImportRoots();
		return { ...this.importRoots };
	}

	setImportRoot(sourceId: DesktopBrowserSourceId, path: string): void {
		if (!IMPORT_SOURCE_IDS.includes(sourceId) || !validImportRoot(path)) {
			throw new Error("Invalid browser import location");
		}
		const roots = { ...this.getImportRoots(), [sourceId]: path };
		this.writeAtomic(join(this.userDataPath, IMPORT_LOCATIONS_FILE), { schemaVersion: 1, roots });
		this.importRoots = roots;
	}

	ensureImportedProfile(source: ImportedProfileIdentity): DesktopBrowserProfile {
		const fingerprint = source.rootPath ? browserRootFingerprint(source.rootPath) : null;
		const profiles = this.storedProfiles().slice(1);
		const existing = profiles.find(
			(profile) =>
				profile.sourceId === source.sourceId &&
				profile.sourceProfileId === source.sourceProfileId &&
				profile.rootFingerprint === fingerprint,
		);
		const name = source.name.trim().slice(0, 128) || source.sourceProfileId;
		const profile: StoredImportedProfile = existing
			? { ...existing, name }
			: {
					profileId: randomUUID(),
					name,
					sourceId: source.sourceId,
					sourceProfileId: source.sourceProfileId,
					rootFingerprint: fingerprint,
				};
		this.writeProfiles(
			existing
				? profiles.map((candidate) => (candidate.profileId === profile.profileId ? profile : candidate))
				: [...profiles, profile],
		);
		return publicProfile(profile);
	}

	loadHistory(profileId: string): readonly DesktopHistoryEntry[] {
		if (!this.hasProfile(profileId)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.historyPath(profileId), "utf8"));
			if (!Array.isArray(parsed)) return [];
			const entries: DesktopHistoryEntry[] = [];
			for (const candidate of parsed) {
				try {
					entries.push(validateBrowserHistoryEntry(candidate));
				} catch {
					// Keep valid siblings in a partially corrupted history file.
				}
			}
			return mergeBrowserHistory([], entries);
		} catch {
			return [];
		}
	}

	saveHistory(profileId: string, entries: readonly DesktopHistoryEntry[]): void {
		if (!this.hasProfile(profileId)) throw new Error("Browser profile does not exist");
		this.writeAtomic(this.historyPath(profileId), mergeBrowserHistory([], entries));
	}

	private hasProfile(profileId: string): boolean {
		return this.listProfiles().some((profile) => profile.profileId === profileId);
	}

	private historyPath(profileId: string): string {
		return join(
			this.userDataPath,
			profileId === DEFAULT_BROWSER_PROFILE_ID ? "browser-history.json" : `browser-history-${profileId}.json`,
		);
	}

	private readImportRoots(): Partial<Record<DesktopBrowserSourceId, string>> {
		try {
			const value = JSON.parse(readFileSync(join(this.userDataPath, IMPORT_LOCATIONS_FILE), "utf8"));
			if (value?.schemaVersion !== 1 || typeof value.roots !== "object" || value.roots === null) return {};
			const roots: Partial<Record<DesktopBrowserSourceId, string>> = {};
			for (const sourceId of IMPORT_SOURCE_IDS) {
				const path = (value.roots as Record<string, unknown>)[sourceId];
				if (validImportRoot(path)) roots[sourceId] = path;
			}
			return roots;
		} catch {
			return {};
		}
	}

	private storedProfiles(): readonly StoredImportedProfile[] {
		this.profiles ??= [DEFAULT_PROFILE, ...this.readImportedProfiles()];
		return this.profiles;
	}

	private readImportedProfiles(): readonly StoredImportedProfile[] {
		try {
			const value = JSON.parse(readFileSync(join(this.userDataPath, PROFILE_FILE), "utf8"));
			if (value?.schemaVersion !== 1 || !Array.isArray(value.profiles)) return [];
			const profiles: StoredImportedProfile[] = [];
			for (const candidate of value.profiles.slice(0, 127)) {
				try {
					const fingerprint = storedRootFingerprint(candidate);
					const visible = publicProfile({
						...(candidate as object),
						rootFingerprint: fingerprint,
					} as StoredImportedProfile);
					const profile = validateBrowserProfileList([visible])[0]!;
					if (profile.profileId !== DEFAULT_BROWSER_PROFILE_ID && profile.sourceId && profile.sourceProfileId) {
						profiles.push({ ...profile, rootFingerprint: fingerprint });
					}
				} catch {
					// Keep valid sibling profiles.
				}
			}
			return profiles;
		} catch {
			return [];
		}
	}

	private writeProfiles(profiles: readonly StoredImportedProfile[]): void {
		this.writeAtomic(join(this.userDataPath, PROFILE_FILE), { schemaVersion: 1, profiles });
		this.profiles = [DEFAULT_PROFILE, ...profiles];
	}

	private writeAtomic(path: string, value: unknown): void {
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	}
}
