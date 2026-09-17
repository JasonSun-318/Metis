import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createFileAtomicallySync,
	ensureDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
} from "../durable-file.ts";
import { withMemoryRootLock } from "./memory-lock.ts";
import { memoryUsageKey } from "./vault-identity.ts";
import { getMetaUsagePath } from "./vault-paths.ts";
import { PROJECT_KEY_PATTERN } from "./vault-project.ts";
import { isSafeSlug } from "./vault-types.ts";

export interface UsageRecord {
	useCount: number;
	lastUsed: string;
}

export type UsageMap = Record<string, UsageRecord>;

function usageBackupPath(root: string): string {
	return join(root, ".meta", "usage-v1.json");
}

function parseUsage(raw: string | undefined): UsageMap {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as Record<string, { useCount?: unknown; lastUsed?: unknown }>;
		const usage: UsageMap = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value?.useCount !== "number" || typeof value?.lastUsed !== "string") continue;
			usage[key] = { useCount: value.useCount, lastUsed: value.lastUsed };
		}
		return usage;
	} catch {
		return {};
	}
}

/** Existing project keys whose notes dir currently contains `<slug>.md`. */
function projectsHolding(root: string, slug: string): string[] {
	let names: string[];
	try {
		names = readdirSync(join(root, "projects"));
	} catch {
		return [];
	}
	return names.filter(
		(name) => PROJECT_KEY_PATTERN.test(name) && existsSync(join(root, "projects", name, "notes", `${slug}.md`)),
	);
}

/**
 * Normalize the on-disk map to project-aware keys. Legacy `global/<slug>` keys
 * move to `global/notes/<slug>`; legacy `project/<slug>` keys cannot be
 * attributed to one project, so their counts are copied as a baseline onto
 * every project note with that slug. New-format keys always win.
 */
function normalizeUsage(root: string, usage: UsageMap): UsageMap {
	const normalized: UsageMap = {};
	for (const [key, record] of Object.entries(usage)) {
		const globalLegacy = key.startsWith("global/") && !key.startsWith("global/notes/");
		const projectLegacy = key.startsWith("project/");
		if (globalLegacy) {
			const slug = key.slice("global/".length);
			if (!isSafeSlug(slug)) continue;
			const nextKey = memoryUsageKey("global", slug);
			if (normalized[nextKey] === undefined) normalized[nextKey] = { ...record };
			continue;
		}
		if (projectLegacy) {
			const slug = key.slice("project/".length);
			if (!isSafeSlug(slug)) continue;
			for (const projectKey of projectsHolding(root, slug)) {
				const nextKey = memoryUsageKey("project", slug, projectKey);
				if (normalized[nextKey] === undefined) normalized[nextKey] = { ...record };
			}
			continue;
		}
		normalized[key] = record;
	}
	return normalized;
}

/** Read `.meta/usage.json`; missing or corrupt data reads as empty. Keys are normalized. */
export function readUsage(root: string): UsageMap {
	const raw = readSingleLinkTextFileSync(getMetaUsagePath(root), { maxBytes: 1024 * 1024 });
	return normalizeUsage(root, parseUsage(raw));
}

function writeUsage(root: string, usage: UsageMap): void {
	const path = getMetaUsagePath(root);
	ensureDirectoryDurablySync(dirname(path));
	// Preserve the pre-migration file once before the first normalized rewrite.
	const backup = usageBackupPath(root);
	if (!existsSync(backup)) {
		const raw = readSingleLinkTextFileSync(path, { maxBytes: 1024 * 1024 });
		if (raw !== undefined) {
			try {
				createFileAtomicallySync(backup, raw, { mode: 0o600 });
			} catch {
				// A concurrent backup is fine; never block the usage write on it.
			}
		}
	}
	replaceFileAtomicallySync(path, JSON.stringify(usage, null, "\t"), { mode: 0o600 });
}

/** Increment useCount for usage keys; takes the vault lock and writes atomically. */
export async function recordUsage(root: string, keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	const now = new Date().toISOString();
	await withMemoryRootLock(root, () => {
		const usage = readUsage(root);
		for (const key of new Set(keys)) {
			const record = usage[key] ?? { useCount: 0, lastUsed: now };
			record.useCount += 1;
			record.lastUsed = now;
			usage[key] = record;
		}
		writeUsage(root, usage);
	});
}

/** Drop usage rows for deleted notes; takes the vault lock and writes atomically. */
export async function removeUsage(root: string, keys: string[]): Promise<void> {
	if (keys.length === 0) return;
	await withMemoryRootLock(root, () => {
		const usage = readUsage(root);
		let changed = false;
		for (const key of keys) {
			if (key in usage) {
				delete usage[key];
				changed = true;
			}
		}
		if (changed) writeUsage(root, usage);
	});
}
