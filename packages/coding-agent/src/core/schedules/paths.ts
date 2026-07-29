import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import { ensureRealDirectoryDurablySync } from "../durable-file.ts";
import { assertValidSessionId } from "../session-id.ts";
import { createExactOwnedDirectory, getExactOwnedDirectory, removeExactOwnedDirectory } from "../session-workspace.ts";

export const getScheduleIndexPath = (agentDir: string): string => join(resolvePath(agentDir), "schedules.json");
export const getScheduleLeaderPath = (agentDir: string): string => join(resolvePath(agentDir), "schedules.leader");
export const getScheduleRunsRoot = (agentDir: string): string => join(resolvePath(agentDir), "schedule-runs");
export const getScheduleWorkspacesRoot = (agentDir: string): string =>
	join(resolvePath(agentDir), "schedule-workspaces");

export function getScheduleRunDir(agentDir: string, taskId: string): string {
	assertValidSessionId(taskId);
	return join(getScheduleRunsRoot(agentDir), taskId);
}

export function getScheduleRunPath(agentDir: string, taskId: string, sequence: number, runId: string): string {
	assertValidSessionId(taskId);
	assertValidSessionId(runId);
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new TypeError("Schedule run sequence is invalid");
	}
	return join(getScheduleRunDir(agentDir, taskId), `${String(sequence).padStart(16, "0")}_${runId}.json`);
}

export function getScheduleWorkspacePath(agentDir: string, taskId: string): string {
	assertValidSessionId(taskId);
	return join(getScheduleWorkspacesRoot(agentDir), taskId);
}

export function ensureScheduleDirectories(agentDir: string): void {
	const resolvedAgentDir = resolvePath(agentDir);
	ensureRealDirectoryDurablySync(resolvedAgentDir, 0o700);
	ensureRealDirectoryDurablySync(getScheduleRunsRoot(resolvedAgentDir), 0o700);
	ensureRealDirectoryDurablySync(getScheduleWorkspacesRoot(resolvedAgentDir), 0o700);
}

export function ensureScheduleRunDirectory(agentDir: string, taskId: string): string {
	ensureScheduleDirectories(agentDir);
	const root = getScheduleRunsRoot(agentDir);
	const expected = getScheduleRunDir(agentDir, taskId);
	if (!existsSync(expected)) return createExactOwnedDirectory(root, taskId);
	const owned = getExactOwnedDirectory(root, taskId, expected);
	if (!owned) throw new Error("Schedule run directory is not an exact owned directory");
	return owned;
}

export function createScheduleWorkspace(agentDir: string, taskId: string): string {
	ensureScheduleDirectories(agentDir);
	return createExactOwnedDirectory(getScheduleWorkspacesRoot(agentDir), taskId);
}

export function getOwnedScheduleWorkspace(agentDir: string, taskId: string, cwd: string): string | undefined {
	return getExactOwnedDirectory(getScheduleWorkspacesRoot(agentDir), taskId, cwd);
}

export function removeOwnedScheduleWorkspace(agentDir: string, taskId: string, cwd: string): boolean {
	try {
		ensureScheduleDirectories(agentDir);
		if (lstatSync(getScheduleWorkspacePath(agentDir, taskId)).isSymbolicLink()) return false;
		return removeExactOwnedDirectory(getScheduleWorkspacesRoot(agentDir), taskId, cwd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return removeExactOwnedDirectory(getScheduleWorkspacesRoot(agentDir), taskId, cwd);
		}
		return false;
	}
}

export function removeScheduleRunDirectory(agentDir: string, taskId: string): boolean {
	try {
		ensureScheduleDirectories(agentDir);
		if (lstatSync(getScheduleRunDir(agentDir, taskId)).isSymbolicLink()) return false;
		return removeExactOwnedDirectory(getScheduleRunsRoot(agentDir), taskId, getScheduleRunDir(agentDir, taskId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return removeExactOwnedDirectory(getScheduleRunsRoot(agentDir), taskId, getScheduleRunDir(agentDir, taskId));
		}
		return false;
	}
}
