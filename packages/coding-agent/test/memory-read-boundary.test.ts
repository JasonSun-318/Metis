import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryReadBoundary } from "../src/core/memory/memory-path-guard.ts";
import { getChangelogPath, getScopeDir, getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "../src/core/tools/index.ts";

describe("memory read boundary", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"allows global/current project scopes and denies sibling/vault-internal paths",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "metis-memory-read-"));
			dirs.push(root);
			const agentDir = join(root, "agent");
			const cwd = join(root, "workspace");
			const vaultRoot = getVaultRoot(agentDir);
			const globalDir = getScopeDir(vaultRoot, "global");
			const projectDir = getScopeDir(vaultRoot, "project", resolveVaultProject(cwd, "user-selected")!.projectKey);
			const siblingDir = getScopeDir(
				vaultRoot,
				"project",
				resolveVaultProject(join(root, "sibling"), "user-selected")!.projectKey,
			);
			mkdirSync(cwd, { recursive: true });
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(siblingDir, { recursive: true });
			const globalTopic = join(globalDir, "MEMORY.md");
			const projectTopic = join(projectDir, "MEMORY.md");
			const siblingTopic = join(siblingDir, "MEMORY.md");
			const changelog = getChangelogPath(vaultRoot);
			mkdirSync(join(vaultRoot, ".history"), { recursive: true });
			writeFileSync(globalTopic, "global marker\n");
			writeFileSync(projectTopic, "current marker\n");
			writeFileSync(siblingTopic, "sibling marker\n");
			writeFileSync(changelog, "history marker\n");
			const siblingAlias = join(projectDir, "sibling-alias");
			const changelogAlias = join(projectDir, "history-alias");
			symlinkSync(siblingDir, siblingAlias);
			symlinkSync(changelog, changelogAlias);

			const boundary: MemoryReadBoundary = {
				memoryRoot: vaultRoot,
				allowedRoots: [globalDir, projectDir],
			};
			const read = createReadTool(cwd, { memoryReadBoundary: boundary });
			const grep = createGrepTool(cwd, { memoryReadBoundary: boundary });
			const find = createFindTool(cwd, { memoryReadBoundary: boundary });
			const ls = createLsTool(cwd, { memoryReadBoundary: boundary });

			await expect(read.execute("read-global", { path: globalTopic })).resolves.toMatchObject({
				content: [{ text: expect.stringContaining("global marker") }],
			});
			await expect(read.execute("read-project", { path: projectTopic })).resolves.toMatchObject({
				content: [{ text: expect.stringContaining("current marker") }],
			});
			await expect(grep.execute("grep-project", { pattern: "current", path: projectTopic })).resolves.toBeDefined();
			await expect(find.execute("find-project", { pattern: "*.md", path: projectDir })).resolves.toBeDefined();
			await expect(ls.execute("ls-project", { path: projectDir })).resolves.toBeDefined();

			const deniedPaths = [siblingTopic, changelog, join(siblingAlias, "MEMORY.md"), changelogAlias];
			for (const path of deniedPaths) {
				await expect(read.execute(`read-${path}`, { path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
				await expect(grep.execute(`grep-${path}`, { pattern: "marker", path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
			}
			for (const path of [siblingDir, siblingAlias]) {
				await expect(find.execute(`find-${path}`, { pattern: "*.md", path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
				await expect(ls.execute(`ls-${path}`, { path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
			}
		},
	);
});
