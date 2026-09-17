import { MemoryVault, type UndoRunResult } from "./vault.ts";
import type { MemoryEvents } from "./vault-events.ts";
import { readChangelog } from "./vault-history.ts";
import { getVaultRoot } from "./vault-paths.ts";
import { listStoredVaultProjects } from "./vault-project.ts";
import type { MemoryActor } from "./vault-types.ts";

/**
 * Roll back an entire Dream run across every scope it touched, newest change
 * first. The root lock is not held across the loop: each operation's preflight
 * and file changes run inside `MemoryVault.undo`'s own lock, so writes from
 * other processes that land mid-rollback surface as per-operation conflicts
 * instead of corrupting the vault. Entries are processed in global changelog
 * order — never batched per project — so cross-scope ordering is preserved.
 */
export async function undoMemoryRun(options: {
	agentDir: string;
	runId: string;
	actor: MemoryActor;
	events?: MemoryEvents;
}): Promise<UndoRunResult> {
	const root = getVaultRoot(options.agentDir);
	const initial = readChangelog(root).filter(
		(entry) =>
			entry.actor.kind === "dream" &&
			entry.actor.runId === options.runId &&
			entry.op !== "undo" &&
			entry.op !== "migrate",
	);
	const undone: string[] = [];
	const skipped: UndoRunResult["skipped"] = [];
	const visited = new Set<string>();
	for (const original of initial) {
		const groupId = original.operationId ?? original.id;
		if (visited.has(groupId)) continue;
		visited.add(groupId);
		const fresh = readChangelog(root);
		const entry = fresh.find((item) => item.id === groupId) ?? fresh.find((item) => item.id === original.id);
		if (!entry || entry.undoneBy) continue;
		if (entry.scope === "project" && !entry.projectKey) {
			skipped.push({ changeId: entry.id, reason: "project identity is missing from this historical change" });
			continue;
		}
		const project =
			entry.scope === "project"
				? listStoredVaultProjects(root).find((item) => item.projectKey === entry.projectKey)
				: undefined;
		if (entry.scope === "project" && !project) {
			skipped.push({ changeId: entry.id, reason: "owning project vault is unavailable" });
			continue;
		}
		const vault = new MemoryVault({
			agentDir: options.agentDir,
			...(project !== undefined ? { project } : {}),
			...(options.events !== undefined ? { events: options.events } : {}),
		});
		const result = await vault.undo(entry.id, options.actor);
		if (result.ok) undone.push(entry.id);
		else skipped.push({ changeId: entry.id, reason: result.error ?? "undo failed" });
	}
	return { undone, skipped };
}
