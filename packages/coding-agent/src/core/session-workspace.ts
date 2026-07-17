import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { getWorkspacesDir as getConfiguredWorkspacesDir } from "../config.ts";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import type { AgentMode } from "./agent-mode.ts";
import { assertValidSessionId } from "./session-id.ts";

export type CwdOrigin = "managed" | "user-selected";

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

	const { root, canonicalRoot } = ensureManagedWorkspaceRoot(options.agentDir);
	const target = getManagedWorkspaceDir(options.id, options.agentDir);
	assertExactRootChild(root, canonicalRoot, target, options.id);
	if (existsSync(target)) throw new Error(`Managed workspace already exists: ${target}`);
	try {
		mkdirSync(target);
		const canonicalTarget = assertRealDirectory(target, "Managed workspace");
		if (dirname(canonicalTarget) !== canonicalRoot) throw new Error("Managed workspace was created outside its root");
		return { cwd: canonicalTarget, cwdOrigin: "managed" };
	} catch (error) {
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
}

/** Return the exact ArcMind-owned workspace, or undefined for external/forged ownership. */
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
		const root = getWorkspacesDir(resolvedAgentDir);
		const canonicalRoot = assertRealDirectory(root, "Managed workspace root");
		const expected = getManagedWorkspaceDir(options.id, resolvedAgentDir);
		assertExactRootChild(root, canonicalRoot, expected, options.id);
		const canonicalWorkspace = assertRealDirectory(expected, "Managed workspace");
		if (dirname(canonicalWorkspace) !== canonicalRoot) return undefined;
		if (assertRealDirectory(options.cwd, "Stored managed workspace") !== canonicalWorkspace) return undefined;
		return expected;
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
	const workspace = getOwnedManagedWorkspace(options);
	if (!workspace) return false;
	rmSync(workspace, { recursive: true, force: true });
	return !existsSync(workspace);
}

/** Copy one owned workspace and publish its derivative as one application transaction. */
export function publishManagedWorkspaceCopy<T>(options: {
	sourceId: string;
	sourceCwd: string;
	targetId: string;
	agentDir: string;
	publish: (targetCwd: string) => T;
}): T {
	const source = getOwnedManagedWorkspace({
		id: options.sourceId,
		cwd: options.sourceCwd,
		cwdOrigin: "managed",
		agentDir: options.agentDir,
	});
	if (!source) throw new Error("Source workspace is not owned by ArcMind");
	assertValidSessionId(options.targetId);
	const { root, canonicalRoot } = ensureManagedWorkspaceRoot(options.agentDir);
	const target = getManagedWorkspaceDir(options.targetId, options.agentDir);
	const temporaryName = `${options.targetId}.tmp-${randomUUID()}`;
	const temporaryTarget = join(root, temporaryName);
	assertExactRootChild(root, canonicalRoot, target, options.targetId);
	assertExactRootChild(root, canonicalRoot, temporaryTarget, temporaryName);
	if (existsSync(target) || existsSync(temporaryTarget)) throw new Error("Managed workspace target already exists");

	try {
		cpSync(source, temporaryTarget, {
			recursive: true,
			force: false,
			errorOnExist: true,
			verbatimSymlinks: true,
		});
		assertRealDirectory(temporaryTarget, "Temporary managed workspace");
		renameSync(temporaryTarget, target);
		const canonicalTarget = assertRealDirectory(target, "Managed workspace copy");
		if (dirname(canonicalTarget) !== canonicalRoot) throw new Error("Managed workspace copy escaped its root");
		return options.publish(canonicalTarget);
	} catch (error) {
		rmSync(temporaryTarget, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
		throw error;
	}
}
