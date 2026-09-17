import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizePathForCreation, resolvePath } from "../../utils/paths.ts";
import { readSingleLinkTextFileSync } from "../durable-file.ts";
import { getProjectMetaPath } from "./vault-paths.ts";

export interface VaultProjectIdentity {
	/** Canonical project root (git root when present, else the canonical cwd). */
	root: string;
	/** sha256 hex of root. */
	projectKey: string;
	source: "git" | "cwd";
}

/** Walk up from dir looking for `.git`, which may be a directory or a file (worktree). */
export function findGitRoot(dir: string): string | undefined {
	let current = dir;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/**
 * Resolve the project identity for a workspace cwd.
 * Managed workspaces get no project scope; otherwise the identity is the git
 * root when inside a repository, or the canonical cwd itself.
 */
export function resolveVaultProject(
	cwd: string,
	cwdOrigin?: "managed" | "user-selected",
): VaultProjectIdentity | undefined {
	if (cwdOrigin === "managed") return undefined;
	const canonical = canonicalizePathForCreation(resolvePath(cwd));
	const gitRoot = findGitRoot(canonical);
	const root = gitRoot ?? canonical;
	return {
		root,
		projectKey: createHash("sha256").update(root).digest("hex"),
		source: gitRoot ? "git" : "cwd",
	};
}

export const PROJECT_KEY_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Enumerate project vaults already on disk under `<root>/projects/`. Only real
 * directories with a sha256-hex name count; a missing or invalid `.project.json`
 * yields `root: ""` — the project exists but its cwd is unknown.
 */
export function listStoredVaultProjects(root: string): VaultProjectIdentity[] {
	const projectsDir = join(root, "projects");
	let names: string[];
	try {
		names = readdirSync(projectsDir);
	} catch {
		return [];
	}
	const projects: VaultProjectIdentity[] = [];
	for (const name of names) {
		if (!PROJECT_KEY_PATTERN.test(name)) continue;
		const dir = join(projectsDir, name);
		try {
			const stats = lstatSync(dir);
			if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
		} catch {
			continue;
		}
		let projectRoot = "";
		try {
			const raw = readSingleLinkTextFileSync(getProjectMetaPath(dir), { maxBytes: 4_096 });
			if (raw) {
				const parsed = JSON.parse(raw) as { root?: unknown };
				if (typeof parsed.root === "string") projectRoot = parsed.root;
			}
		} catch {
			projectRoot = "";
		}
		projects.push({ root: projectRoot, projectKey: name, source: "cwd" });
	}
	return projects;
}
