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

/**
 * Block host/sandbox bash from using the memory directory as cwd or naming it in the command.
 * Does not parse shell grammar; catches the common absolute-path cases that bypass write/edit.
 */
export function assertBashDoesNotTouchMemory(command: string, cwd: string, memoryRoot: string | undefined): void {
	if (!memoryRoot) return;
	const root = resolvePath(memoryRoot);
	if (isPathInside(root, resolvePath(cwd))) {
		throw new Error(
			"Cannot run bash with cwd under the long-term memory directory; memory is read-only to the session.",
		);
	}
	const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
	const normalizedCommand = command.replaceAll("\\", "/");
	if (
		normalizedCommand.includes(normalizedRoot) ||
		(process.platform === "win32" && normalizedCommand.toLowerCase().includes(normalizedRoot.toLowerCase()))
	) {
		throw new Error("Cannot reference the long-term memory directory from bash; memory is read-only to the session.");
	}
}
