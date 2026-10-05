import type { WorkspaceTab } from "./workspace-tabs.ts";

export const FILE_BROWSER_STORAGE_PREFIX = "metis.file-browser.v1:";

interface StoredFileWorkspace {
	readonly version: 1;
	readonly cwd: string;
	readonly fixedPaths: readonly string[];
	readonly expandedPaths: readonly string[];
}

function isRelativeWorkspacePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4_096 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

export function loadStoredFiles(sessionId: string, cwd: string): StoredFileWorkspace {
	const empty: StoredFileWorkspace = { version: 1, cwd, fixedPaths: [], expandedPaths: [] };
	try {
		const value = JSON.parse(
			localStorage.getItem(`${FILE_BROWSER_STORAGE_PREFIX}${sessionId}`) ?? "null",
		) as Partial<StoredFileWorkspace> | null;
		if (value?.version !== 1 || value.cwd !== cwd) return empty;
		return {
			version: 1,
			cwd,
			fixedPaths: Array.isArray(value.fixedPaths)
				? value.fixedPaths.filter(isRelativeWorkspacePath).slice(0, 64)
				: [],
			expandedPaths: Array.isArray(value.expandedPaths)
				? value.expandedPaths.filter(isRelativeWorkspacePath).slice(0, 256)
				: [],
		};
	} catch {
		return empty;
	}
}

export function saveStoredFiles(
	sessionId: string,
	cwd: string,
	tabs: readonly WorkspaceTab[],
	expandedPaths: readonly string[],
): void {
	const value: StoredFileWorkspace = {
		version: 1,
		cwd,
		fixedPaths: tabs
			.flatMap((tab) =>
				tab.kind === "file" && tab.sessionId === sessionId && tab.fixed && tab.relativePath
					? [tab.relativePath]
					: [],
			)
			.slice(0, 64),
		expandedPaths: expandedPaths.filter(isRelativeWorkspacePath).slice(0, 256),
	};
	localStorage.setItem(`${FILE_BROWSER_STORAGE_PREFIX}${sessionId}`, JSON.stringify(value));
}

export function displayFileName(relativePath: string): string {
	return relativePath.split("/").at(-1) ?? relativePath;
}

export function pathIsWithin(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

export function remapPath(path: string, previous: string, next: string): string {
	return path === previous ? next : `${next}${path.slice(previous.length)}`;
}
