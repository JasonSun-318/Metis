import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths, getAutoMemoryRoot } from "../src/core/auto-memory.ts";
import type { MemoryReadBoundary } from "../src/core/memory/memory-path-guard.ts";
import { createFindTool, createGrepTool, createLsTool, createReadTool } from "../src/core/tools/index.ts";

describe("memory read boundary", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"allows global/current projection and denies sibling/database aliases",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "metis-memory-read-"));
			dirs.push(root);
			const agentDir = join(root, "agent");
			const cwd = join(root, "workspace");
			const current = getAutoMemoryPaths(agentDir, cwd);
			const sibling = getAutoMemoryPaths(agentDir, join(root, "sibling"));
			mkdirSync(cwd, { recursive: true });
			mkdirSync(current.global.directory, { recursive: true });
			mkdirSync(current.project.directory, { recursive: true });
			mkdirSync(sibling.project.directory, { recursive: true });
			const globalTopic = join(current.global.directory, "preferences.md");
			const projectTopic = join(current.project.directory, "context.md");
			const siblingTopic = join(sibling.project.directory, "private.md");
			const sqlite = join(getAutoMemoryRoot(agentDir), "memory.sqlite");
			writeFileSync(globalTopic, "global marker\n");
			writeFileSync(projectTopic, "current marker\n");
			writeFileSync(siblingTopic, "sibling marker\n");
			writeFileSync(sqlite, "database marker\n");
			const siblingAlias = join(current.project.directory, "sibling-alias");
			const sqliteAlias = join(current.project.directory, "sqlite-alias");
			symlinkSync(sibling.project.directory, siblingAlias);
			symlinkSync(sqlite, sqliteAlias);

			const boundary: MemoryReadBoundary = {
				memoryRoot: getAutoMemoryRoot(agentDir),
				allowedRoots: [current.global.directory, current.project.directory],
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
			await expect(
				find.execute("find-project", { pattern: "*.md", path: current.project.directory }),
			).resolves.toBeDefined();
			await expect(ls.execute("ls-project", { path: current.project.directory })).resolves.toBeDefined();

			const deniedPaths = [siblingTopic, sqlite, join(siblingAlias, "private.md"), sqliteAlias];
			for (const path of deniedPaths) {
				await expect(read.execute(`read-${path}`, { path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
				await expect(grep.execute(`grep-${path}`, { pattern: "marker", path })).rejects.toThrow(
					"Memory path is outside the current memory scope",
				);
			}
			for (const path of [sibling.project.directory, siblingAlias]) {
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
