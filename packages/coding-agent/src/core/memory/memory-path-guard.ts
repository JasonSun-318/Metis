import { isPathInside, resolvePath } from "../../utils/paths.ts";
import { getAutoMemoryRoot } from "../auto-memory.ts";

/** True when `path` resolves under the agent's long-term memory directory. */
export function isAutoMemoryFsPath(agentDir: string, path: string): boolean {
	return isPathInside(getAutoMemoryRoot(agentDir), resolvePath(path));
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
