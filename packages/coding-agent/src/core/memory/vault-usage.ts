import { dirname } from "node:path";
import { ensureDirectoryDurablySync, readSingleLinkTextFileSync, replaceFileAtomicallySync } from "../durable-file.ts";
import { withMemoryRootLock } from "./memory-lock.ts";
import { getMetaUsagePath } from "./vault-paths.ts";

export interface UsageRecord {
	useCount: number;
	lastUsed: string;
}

export type UsageMap = Record<string, UsageRecord>;

/** Read `.meta/usage.json`; missing or corrupt data reads as empty. */
export function readUsage(root: string): UsageMap {
	const raw = readSingleLinkTextFileSync(getMetaUsagePath(root), { maxBytes: 1024 * 1024 });
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

function writeUsage(root: string, usage: UsageMap): void {
	const path = getMetaUsagePath(root);
	ensureDirectoryDurablySync(dirname(path));
	replaceFileAtomicallySync(path, JSON.stringify(usage, null, "\t"), { mode: 0o600 });
}

/** Increment useCount for `<scope>/<slug>` keys; takes the vault lock and writes atomically. */
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
