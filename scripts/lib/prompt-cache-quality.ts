import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "../../packages/agent/src/types.ts";

/** A normal model stop is necessary, but task-specific evidence is authoritative. */
export function assertTaskOutcome(messages: readonly AgentMessage[], verify: () => string | null = () => null): void {
	const last = messages.at(-1);
	if (last?.role !== "assistant" || last.stopReason !== "stop") {
		throw new Error(
			`Agent did not finish successfully: ${last?.role === "assistant" ? (last.errorMessage ?? last.stopReason) : last?.role}`,
		);
	}
	const failure = verify();
	if (failure) throw new Error(failure);
}

/** Harness state has its own reserved directory; every project entry is checked. */
export function snapshotProject(root: string): Map<string, string> {
	const snapshot = new Map<string, string>();
	const visit = (relative: string) => {
		for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
			if (!relative && entry.name === ".bench") continue;
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			const absolute = join(root, path);
			if (entry.isDirectory()) {
				snapshot.set(path, "directory");
				visit(path);
			} else if (entry.isSymbolicLink()) {
				snapshot.set(path, `link:${readlinkSync(absolute)}`);
			} else if (entry.isFile()) {
				snapshot.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
			} else snapshot.set(path, "special");
		}
	};
	visit("");
	return snapshot;
}

export function unapprovedProjectChanges(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
	allowed: ReadonlySet<string>,
): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((path) => !allowed.has(path) && before.get(path) !== after.get(path))
		.sort();
}
