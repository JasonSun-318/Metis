import { createHash } from "node:crypto";
import { canonicalizePathForCreation, encodePathForStorage } from "../../utils/paths.ts";

export interface MemoryProjectIdentity {
	canonicalCwd: string;
	projectKey: string;
	legacyKey: string;
}

/** Stable exact-cwd identity shared by Chat and Code sessions. */
export function memoryProjectIdentity(cwd: string): MemoryProjectIdentity {
	const canonicalCwd = canonicalizePathForCreation(cwd);
	return {
		canonicalCwd,
		projectKey: createHash("sha256").update(canonicalCwd).digest("hex"),
		legacyKey: encodePathForStorage(canonicalCwd),
	};
}
