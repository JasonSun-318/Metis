import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { findGitRoot, listStoredVaultProjects, resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { canonicalizePathForCreation } from "../src/utils/paths.ts";

describe("vault project identity", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-proj-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a nested cwd inside a git repository to the git root", () => {
		const repo = join(makeTemp(), "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		const nested = join(repo, "packages", "sub");
		mkdirSync(nested, { recursive: true });
		const identity = resolveVaultProject(nested, "user-selected");
		expect(identity).toBeDefined();
		expect(identity!.source).toBe("git");
		expect(identity!.root).toBe(canonicalizePathForCreation(repo));
		expect(identity!.projectKey).toBe(createHash("sha256").update(canonicalizePathForCreation(repo)).digest("hex"));
	});

	it("treats a .git file (worktree) as a repository marker", () => {
		const repo = join(makeTemp(), "worktree");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, ".git"), "gitdir: /elsewhere\n");
		const nested = join(repo, "src");
		mkdirSync(nested);
		expect(findGitRoot(nested)).toBe(repo);
		expect(resolveVaultProject(nested, "user-selected")!.source).toBe("git");
	});

	it("falls back to the canonical cwd when no git root exists", () => {
		const dir = join(makeTemp(), "plain");
		mkdirSync(dir);
		const identity = resolveVaultProject(dir, "user-selected")!;
		expect(identity.source).toBe("cwd");
		expect(identity.root).toBe(canonicalizePathForCreation(dir));
	});

	it("returns undefined for managed workspaces", () => {
		const dir = makeTemp();
		expect(resolveVaultProject(dir, "managed")).toBeUndefined();
	});

	it("lists stored project vaults, including orphans with missing metadata", () => {
		const agentDir = join(makeTemp(), "agent");
		const cwd = join(makeTemp(), "work");
		mkdirSync(cwd, { recursive: true });
		const identity = resolveVaultProject(cwd, "user-selected")!;
		const vault = new MemoryVault({ agentDir, project: identity });
		vault.ensureLayout();
		// An orphan project dir: real directory, no .project.json.
		const orphanKey = createHash("sha256").update("gone").digest("hex");
		mkdirSync(join(getVaultRoot(agentDir), "projects", orphanKey), { recursive: true });
		// A non-hash directory name is never a project.
		mkdirSync(join(getVaultRoot(agentDir), "projects", "not-a-key"), { recursive: true });

		const projects = listStoredVaultProjects(getVaultRoot(agentDir));
		const byKey = new Map(projects.map((project) => [project.projectKey, project]));
		expect(byKey.get(identity.projectKey)?.root).toBe(identity.root);
		expect(byKey.get(orphanKey)?.root).toBe("");
		expect(byKey.has("not-a-key")).toBe(false);
	});
});
