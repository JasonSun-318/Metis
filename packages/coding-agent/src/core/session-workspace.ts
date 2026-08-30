import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { getWorkspacesDir as getConfiguredWorkspacesDir } from "../config.ts";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import type { AgentMode } from "./agent-mode.ts";
import { replaceFileAtomicallySync, syncDirectorySync } from "./durable-file.ts";
import { assertValidSessionId } from "./session-id.ts";

export type CwdOrigin = "managed" | "user-selected";

const MANAGED_WORKSPACE_OWNER_FILE = ".metis-managed-workspace.json";

export interface SessionWorkspace {
	readonly cwd: string;
	readonly cwdOrigin: CwdOrigin;
}

export function getWorkspacesDir(agentDir?: string): string {
	return resolvePath(getConfiguredWorkspacesDir(agentDir));
}

export function getManagedWorkspaceDir(sessionId: string, agentDir?: string): string {
	assertValidSessionId(sessionId);
	return join(getWorkspacesDir(agentDir), sessionId);
}

function assertRealDirectory(path: string, label: string): string {
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
	return realpathSync(path);
}

function ensureManagedWorkspaceRoot(agentDir: string): { root: string; canonicalRoot: string } {
	const resolvedAgentDir = resolvePath(agentDir);
	mkdirSync(resolvedAgentDir, { recursive: true });
	assertRealDirectory(resolvedAgentDir, "Agent directory");
	const root = getWorkspacesDir(resolvedAgentDir);
	mkdirSync(root, { recursive: true });
	return { root, canonicalRoot: assertRealDirectory(root, "Managed workspace root") };
}

function assertExactRootChild(root: string, canonicalRoot: string, child: string, expectedName: string): void {
	const lexicalRelative = relative(root, child);
	if (lexicalRelative !== expectedName || isAbsolute(lexicalRelative) || lexicalRelative.startsWith(`..${sep}`)) {
		throw new Error("Managed workspace path escapes its root");
	}
	const canonicalParent = canonicalizePathForCreation(dirname(child));
	if (canonicalParent !== canonicalRoot) throw new Error("Managed workspace parent does not match its root");
}

export function createExactOwnedDirectory(root: string, name: string): string {
	assertValidSessionId(name);
	const resolvedRoot = resolvePath(root);
	mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
	const canonicalRoot = assertRealDirectory(resolvedRoot, "Owned directory root");
	const target = join(resolvedRoot, name);
	assertExactRootChild(resolvedRoot, canonicalRoot, target, name);
	if (existsSync(target)) throw new Error(`Owned directory already exists: ${target}`);
	try {
		mkdirSync(target, { mode: 0o700 });
		const canonicalTarget = assertRealDirectory(target, "Owned directory");
		if (dirname(canonicalTarget) !== canonicalRoot) throw new Error("Owned directory was created outside its root");
		return canonicalTarget;
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
}

export function getExactOwnedDirectory(root: string, name: string, candidate: string): string | undefined {
	try {
		assertValidSessionId(name);
		const resolvedRoot = resolvePath(root);
		const canonicalRoot = assertRealDirectory(resolvedRoot, "Owned directory root");
		const expected = join(resolvedRoot, name);
		assertExactRootChild(resolvedRoot, canonicalRoot, expected, name);
		const canonicalTarget = assertRealDirectory(expected, "Owned directory");
		if (dirname(canonicalTarget) !== canonicalRoot) return undefined;
		if (assertRealDirectory(candidate, "Stored owned directory") !== canonicalTarget) return undefined;
		return expected;
	} catch {
		return undefined;
	}
}

export function removeExactOwnedDirectory(root: string, name: string, candidate: string): boolean {
	try {
		assertValidSessionId(name);
		const resolvedRoot = resolvePath(root);
		const canonicalRoot = assertRealDirectory(resolvedRoot, "Owned directory root");
		const expected = join(resolvedRoot, name);
		assertExactRootChild(resolvedRoot, canonicalRoot, expected, name);
		if (canonicalizePathForCreation(candidate) !== canonicalizePathForCreation(expected)) return false;
		if (!existsSync(expected)) return true;
		if (!getExactOwnedDirectory(resolvedRoot, name, candidate)) return false;
		rmSync(expected, { recursive: true, force: true });
		return !existsSync(expected);
	} catch {
		return false;
	}
}

function resolveExistingDirectory(path: string, baseDir: string): string {
	const resolvedPath = resolvePath(path, baseDir, { trim: true });
	if (!statSync(resolvedPath).isDirectory()) throw new Error(`Working directory is not a directory: ${resolvedPath}`);
	return realpathSync(resolvedPath);
}

export function resolveNewSessionWorkspace(options: {
	id: string;
	mode: AgentMode;
	requestedCwd?: string;
	hostCwd: string;
	agentDir: string;
}): SessionWorkspace {
	assertValidSessionId(options.id);
	if (options.requestedCwd !== undefined) {
		return {
			cwd: resolveExistingDirectory(options.requestedCwd, options.hostCwd),
			cwdOrigin: "user-selected",
		};
	}
	if (options.mode === "code") {
		return { cwd: resolveExistingDirectory(options.hostCwd, options.hostCwd), cwdOrigin: "user-selected" };
	}

	const { root } = ensureManagedWorkspaceRoot(options.agentDir);
	return { cwd: createExactOwnedDirectory(root, options.id), cwdOrigin: "managed" };
}

/** Return the exact Metis-owned workspace, or undefined for external/forged ownership. */
export function getOwnedManagedWorkspace(options: {
	id: string;
	cwd: string;
	cwdOrigin: CwdOrigin;
	agentDir: string;
}): string | undefined {
	if (options.cwdOrigin !== "managed") return undefined;
	try {
		assertValidSessionId(options.id);
		const resolvedAgentDir = resolvePath(options.agentDir);
		assertRealDirectory(resolvedAgentDir, "Agent directory");
		return getExactOwnedDirectory(getWorkspacesDir(resolvedAgentDir), options.id, options.cwd);
	} catch {
		return undefined;
	}
}

export function removeOwnedManagedWorkspace(options: {
	id: string;
	cwd: string;
	cwdOrigin: CwdOrigin;
	agentDir: string;
}): boolean {
	if (options.cwdOrigin !== "managed") return false;
	return removeExactOwnedDirectory(getWorkspacesDir(options.agentDir), options.id, options.cwd);
}

/** Copy one owned workspace and publish its derivative as one application transaction. */
export function publishManagedWorkspaceCopy<T>(options: {
	sourceId: string;
	sourceCwd: string;
	targetId: string;
	agentDir: string;
	recoveryKey?: string;
	publish: (targetCwd: string) => T;
}): T {
	const source = getOwnedManagedWorkspace({
		id: options.sourceId,
		cwd: options.sourceCwd,
		cwdOrigin: "managed",
		agentDir: options.agentDir,
	});
	if (!source) throw new Error("Source workspace is not owned by Metis");
	assertValidSessionId(options.targetId);
	const { root, canonicalRoot } = ensureManagedWorkspaceRoot(options.agentDir);
	const target = getManagedWorkspaceDir(options.targetId, options.agentDir);
	const temporaryName = `${options.targetId}.tmp-${randomUUID()}`;
	const temporaryTarget = join(root, temporaryName);
	assertExactRootChild(root, canonicalRoot, target, options.targetId);
	assertExactRootChild(root, canonicalRoot, temporaryTarget, temporaryName);
	if (existsSync(temporaryTarget)) throw new Error("Managed workspace temporary target already exists");
	if (existsSync(target)) {
		if (!options.recoveryKey) throw new Error("Managed workspace target already exists");
		const canonicalTarget = getExactOwnedDirectory(root, options.targetId, target);
		if (!canonicalTarget) throw new Error("Managed workspace target is not owned by Metis");
		try {
			const markerPath = join(canonicalTarget, MANAGED_WORKSPACE_OWNER_FILE);
			const markerStats = lstatSync(markerPath);
			if (
				!markerStats.isFile() ||
				markerStats.isSymbolicLink() ||
				markerStats.nlink !== 1 ||
				markerStats.size > 4096
			) {
				throw new Error("Managed workspace recovery marker is unsafe");
			}
			const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
			if (
				marker.version !== 1 ||
				marker.sourceId !== options.sourceId ||
				marker.targetId !== options.targetId ||
				marker.recoveryKey !== options.recoveryKey
			) {
				throw new Error("Managed workspace recovery marker does not match this operation");
			}
			return options.publish(canonicalTarget);
		} catch (error) {
			throw new Error("Managed workspace target cannot be recovered", { cause: error });
		}
	}

	try {
		cpSync(source, temporaryTarget, {
			recursive: true,
			force: false,
			errorOnExist: true,
			verbatimSymlinks: true,
		});
		assertRealDirectory(temporaryTarget, "Temporary managed workspace");
		if (options.recoveryKey) {
			const markerPath = join(temporaryTarget, MANAGED_WORKSPACE_OWNER_FILE);
			rmSync(markerPath, { force: true });
			replaceFileAtomicallySync(
				markerPath,
				`${JSON.stringify({
					version: 1,
					sourceId: options.sourceId,
					targetId: options.targetId,
					recoveryKey: options.recoveryKey,
				})}\n`,
				{ mode: 0o600 },
			);
		}
		renameSync(temporaryTarget, target);
		syncDirectorySync(root);
		const canonicalTarget = assertRealDirectory(target, "Managed workspace copy");
		if (dirname(canonicalTarget) !== canonicalRoot) throw new Error("Managed workspace copy escaped its root");
		return options.publish(canonicalTarget);
	} catch (error) {
		rmSync(temporaryTarget, { recursive: true, force: true });
		if (!options.recoveryKey) rmSync(target, { recursive: true, force: true });
		throw error;
	}
}
