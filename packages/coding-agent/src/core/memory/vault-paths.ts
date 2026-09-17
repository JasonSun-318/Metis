import { join } from "node:path";
import { canonicalizePathForCreation, resolvePath } from "../../utils/paths.ts";
import { memoryScopeKey } from "./vault-identity.ts";
import { type MemoryScope, type MemoryTarget, targetKey } from "./vault-types.ts";

/** Vault root; identical to the legacy getAutoMemoryRoot result. */
export function getVaultRoot(agentDir: string): string {
	return join(canonicalizePathForCreation(resolvePath(agentDir)), "memory");
}

export function getScopeDir(root: string, scope: MemoryScope, projectKey?: string): string {
	if (scope === "global") return join(root, "global");
	if (!projectKey) throw new TypeError("projectKey is required for the project scope");
	return join(root, "projects", projectKey);
}

export function getNotesDir(scopeDir: string): string {
	return join(scopeDir, "notes");
}

export function getPinnedDir(scopeDir: string): string {
	return join(scopeDir, "_pinned");
}

export function getIndexPath(scopeDir: string): string {
	return join(scopeDir, "MEMORY.md");
}

export function getNotePath(scopeDir: string, slug: string): string {
	return join(getNotesDir(scopeDir), `${slug}.md`);
}

export function getPinnedPath(scopeDir: string, block: string): string {
	return join(getPinnedDir(scopeDir), `${block}.md`);
}

export function getHistoryDir(root: string): string {
	return join(root, ".history");
}

export function getChangelogPath(root: string): string {
	return join(getHistoryDir(root), "changelog.jsonl");
}

/**
 * Snapshot directory for a target under `.history/v2/`. Snapshots written
 * before project isolation used `.history/<scope>/<targetKey>/`; those paths
 * stay readable through the changelog's relative snapshot references.
 */
export function getSnapshotDir(root: string, scope: MemoryScope, target: MemoryTarget, projectKey?: string): string {
	return join(getHistoryDir(root), "v2", memoryScopeKey(scope, projectKey), targetKey(target));
}

export function getDreamDir(root: string): string {
	return join(root, ".dream");
}

export function getMetaUsagePath(root: string): string {
	return join(root, ".meta", "usage.json");
}

export function getProjectMetaPath(scopeDir: string): string {
	return join(scopeDir, ".project.json");
}
