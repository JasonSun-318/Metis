import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAutoMemoryFsPath } from "../src/core/memory/memory-path-guard.ts";
import { getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { createEditTool, createWriteTool } from "../src/core/tools/index.ts";

describe("memory path guard", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-memory-path-guard-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("detects paths under the auto-memory root after resolving ..", () => {
		const agentDir = join(makeTemp(), "agent");
		const memoryRoot = getVaultRoot(agentDir);
		const outside = join(makeTemp(), "outside.txt");

		expect(isAutoMemoryFsPath(agentDir, outside)).toBe(false);
		expect(isAutoMemoryFsPath(agentDir, "/tmp/x")).toBe(false);
		expect(isAutoMemoryFsPath(agentDir, join(memoryRoot, "MEMORY.md"))).toBe(true);
		expect(isAutoMemoryFsPath(agentDir, join(memoryRoot, "projects", "x", "chat", "project.md"))).toBe(true);
		expect(isAutoMemoryFsPath(agentDir, join(memoryRoot, "nested", "..", "MEMORY.md"))).toBe(true);
		expect(isAutoMemoryFsPath(agentDir, join(memoryRoot, "..", "not-memory.txt"))).toBe(false);
	});

	it("hard-denies write and edit under restricted memory roots", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		const memoryRoot = getVaultRoot(agentDir);
		mkdirSync(memoryRoot, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const memoryFile = join(memoryRoot, "MEMORY.md");
		writeFileSync(memoryFile, "keep\n");
		const workspaceFile = join(cwd, "ok.txt");
		writeFileSync(workspaceFile, "before\n");

		const restrictedRoots = [memoryRoot];
		const writeTool = createWriteTool(cwd, { restrictedRoots });
		const editTool = createEditTool(cwd, { restrictedRoots });

		await expect(writeTool.execute("write-memory", { path: memoryFile, content: "overwrite\n" })).rejects.toThrow(
			/read-only|memory/i,
		);
		await expect(
			editTool.execute("edit-memory", {
				path: memoryFile,
				edits: [{ oldText: "keep", newText: "changed" }],
			}),
		).rejects.toThrow(/read-only|memory/i);

		await expect(writeTool.execute("write-ok", { path: workspaceFile, content: "after\n" })).resolves.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
		});
	});
});
