import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTO_MEMORY_MAX_BYTES,
	AUTO_MEMORY_MAX_LINES,
	getAutoMemoryPaths,
	getAutoMemoryRoot,
	loadAutoMemory,
} from "../src/core/auto-memory.ts";
import { canonicalizePathForCreation } from "../src/utils/paths.ts";

describe("auto memory", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "arcmind-memory-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("uses one global MEMORY.md and a lowercase project.md keyed by canonical cwd", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);

		expect(paths.global.indexPath).toBe(join(agentDir, "memory", "MEMORY.md"));
		expect(getAutoMemoryRoot(agentDir)).toBe(join(agentDir, "memory"));
		const canonicalCwd = canonicalizePathForCreation(cwd);
		expect(paths.project.indexPath).toBe(
			join(agentDir, "memory", "projects", `--${canonicalCwd.slice(1).replaceAll("/", "-")}--`, "project.md"),
		);
		expect(getAutoMemoryPaths(agentDir, join(cwd, ".")).project.indexPath).toBe(paths.project.indexPath);
		expect(getAutoMemoryPaths(agentDir, join(cwd, "subdir")).project.indexPath).not.toBe(paths.project.indexPath);
		expect(existsSync(join(agentDir, "memory"))).toBe(false);
	});

	it("loads only the first 200 lines", () => {
		const root = makeTemp();
		const paths = getAutoMemoryPaths(join(root, "agent"), join(root, "project"));
		mkdirSync(dirname(paths.global.indexPath), { recursive: true });
		writeFileSync(
			paths.global.indexPath,
			Array.from({ length: AUTO_MEMORY_MAX_LINES + 1 }, (_, index) => `line-${index + 1}`).join("\n"),
		);

		const loaded = loadAutoMemory(join(root, "agent"), join(root, "project")).global;
		expect(loaded.content).toContain("line-200");
		expect(loaded.content).not.toContain("line-201");
		expect(loaded.truncated).toBe(true);
	});

	it("loads at most 25KB without splitting a UTF-8 character", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(dirname(paths.project.indexPath), { recursive: true });
		writeFileSync(paths.project.indexPath, `${"a".repeat(AUTO_MEMORY_MAX_BYTES - 1)}你tail`);

		const loaded = loadAutoMemory(agentDir, cwd).project;
		expect(Buffer.byteLength(loaded.content)).toBeLessThanOrEqual(AUTO_MEMORY_MAX_BYTES);
		expect(loaded.content).not.toContain("�");
		expect(loaded.content.endsWith("a")).toBe(true);
		expect(loaded.truncated).toBe(true);
	});

	it("treats missing indexes as empty without creating them", () => {
		const root = makeTemp();
		const loaded = loadAutoMemory(join(root, "agent"), join(root, "project"));

		expect(loaded.global).toMatchObject({ exists: false, content: "" });
		expect(loaded.project).toMatchObject({ exists: false, content: "" });
		expect(loaded.global.error).toBeUndefined();
		expect(loaded.project.error).toBeUndefined();
		expect(existsSync(join(root, "agent", "memory"))).toBe(false);
	});
});
