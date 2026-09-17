import { canonicalizeActionPath, isPathInside, resolvePath } from "../../utils/paths.ts";
import { getVaultRoot } from "./vault-paths.ts";

/** True when `path` resolves under the agent's long-term memory vault. */
export function isAutoMemoryFsPath(agentDir: string, path: string): boolean {
	return isPathInside(getVaultRoot(agentDir), resolvePath(path));
}

/**
 * Hard-deny main-session writes under restricted roots (e.g. long-term memory).
 * Call after resolveToCwd with an absolute path.
 */
export function assertNotRestrictedFsWrite(absolutePath: string, restrictedRoots?: readonly string[]): void {
	if (!restrictedRoots?.length) return;
	for (const root of restrictedRoots) {
		if (isPathInside(root, absolutePath)) {
			throw new Error(
				"Cannot write or edit files under the long-term memory directory; memory is read-only to the session.",
			);
		}
	}
}

export interface MemoryReadBoundary {
	memoryRoot: string;
	allowedRoots: readonly string[];
}

export function assertMemoryReadAllowed(path: string, boundary?: MemoryReadBoundary): void {
	if (!boundary) return;
	const target = canonicalizeActionPath(path, path);
	if (!isPathInside(boundary.memoryRoot, target)) return;
	if (boundary.allowedRoots.some((root) => isPathInside(root, target))) return;
	throw new Error("Memory path is outside the current memory scope.");
}
