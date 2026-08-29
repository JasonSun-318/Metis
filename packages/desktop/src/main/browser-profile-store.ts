import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserProfile,
	type DesktopBrowserSourceId,
	type DesktopHistoryEntry,
	validateBrowserHistoryEntry,
	validateBrowserProfileList,
} from "../shared/desktop-api.ts";

const PROFILE_FILE = "browser-profiles.json";
const DEFAULT_PROFILE: DesktopBrowserProfile = {
	profileId: DEFAULT_BROWSER_PROFILE_ID,
	name: "Default",
	sourceId: null,
	sourceProfileId: null,
};

export interface ImportedProfileIdentity {
	readonly sourceId: DesktopBrowserSourceId;
	readonly sourceProfileId: string;
	readonly name: string;
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

export class BrowserProfileStore {
	private readonly userDataPath: string;
	private profiles?: readonly DesktopBrowserProfile[];

	constructor(userDataPath: string) {
		this.userDataPath = userDataPath;
	}

	listProfiles(): readonly DesktopBrowserProfile[] {
		this.profiles ??= [DEFAULT_PROFILE, ...this.readImportedProfiles()];
		return this.profiles;
	}

	ensureImportedProfile(source: ImportedProfileIdentity): DesktopBrowserProfile {
		const profiles = this.listProfiles().slice(1);
		const existing = profiles.find(
			(profile) => profile.sourceId === source.sourceId && profile.sourceProfileId === source.sourceProfileId,
		);
		const name = source.name.trim().slice(0, 128) || source.sourceProfileId;
		const profile: DesktopBrowserProfile = existing
			? { ...existing, name }
			: {
					profileId: randomUUID(),
					name,
					sourceId: source.sourceId,
					sourceProfileId: source.sourceProfileId,
				};
		this.writeProfiles(
			existing
				? profiles.map((candidate) => (candidate.profileId === profile.profileId ? profile : candidate))
				: [...profiles, profile],
		);
		return profile;
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

	private readImportedProfiles(): readonly DesktopBrowserProfile[] {
		try {
			const value = JSON.parse(readFileSync(join(this.userDataPath, PROFILE_FILE), "utf8"));
			if (value?.schemaVersion !== 1 || !Array.isArray(value.profiles)) return [];
			const profiles: DesktopBrowserProfile[] = [];
			for (const candidate of value.profiles.slice(0, 127)) {
				try {
					const profile = validateBrowserProfileList([candidate])[0]!;
					if (profile.profileId !== DEFAULT_BROWSER_PROFILE_ID && profile.sourceId && profile.sourceProfileId) {
						profiles.push(profile);
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

	private writeProfiles(profiles: readonly DesktopBrowserProfile[]): void {
		this.writeAtomic(join(this.userDataPath, PROFILE_FILE), { schemaVersion: 1, profiles });
		this.profiles = [DEFAULT_PROFILE, ...profiles];
	}

	private writeAtomic(path: string, value: unknown): void {
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	}
}
