import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTO_MEMORY_MAX_BYTES,
	AUTO_MEMORY_MAX_LINES,
	ensureModeScopedMemoryLayout,
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
		const paths = getAutoMemoryPaths(agentDir, cwd, "chat");

		expect(paths.global.indexPath).toBe(join(agentDir, "memory", "MEMORY.md"));
		expect(getAutoMemoryRoot(agentDir)).toBe(join(agentDir, "memory"));
		const canonicalCwd = canonicalizePathForCreation(cwd);
		expect(paths.project.indexPath).toBe(
			join(
				agentDir,
				"memory",
				"projects",
				`--${canonicalCwd.slice(1).replaceAll("/", "-")}--`,
				"chat",
				"project.md",
			),
		);
		expect(getAutoMemoryPaths(agentDir, join(cwd, "."), "chat").project.indexPath).toBe(paths.project.indexPath);
		expect(getAutoMemoryPaths(agentDir, cwd, "code").project.indexPath).not.toBe(paths.project.indexPath);
		expect(getAutoMemoryPaths(agentDir, join(cwd, "subdir"), "chat").project.indexPath).not.toBe(
			paths.project.indexPath,
		);
		expect(existsSync(join(agentDir, "memory"))).toBe(false);
	});

	it("loads only the first 200 lines", () => {
		const root = makeTemp();
		const paths = getAutoMemoryPaths(join(root, "agent"), join(root, "project"), "chat");
		mkdirSync(dirname(paths.global.indexPath), { recursive: true });
		writeFileSync(
			paths.global.indexPath,
			Array.from({ length: AUTO_MEMORY_MAX_LINES + 1 }, (_, index) => `line-${index + 1}`).join("\n"),
		);

		const loaded = loadAutoMemory(join(root, "agent"), join(root, "project"), "chat").global;
		expect(loaded.content).toContain("line-200");
		expect(loaded.content).not.toContain("line-201");
		expect(loaded.truncated).toBe(true);
	});

	it("loads at most 25KB without splitting a UTF-8 character", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd, "code");
		mkdirSync(dirname(paths.project.indexPath), { recursive: true });
		writeFileSync(paths.project.indexPath, `${"a".repeat(AUTO_MEMORY_MAX_BYTES - 1)}你tail`);

		const loaded = loadAutoMemory(agentDir, cwd, "code").project;
		expect(Buffer.byteLength(loaded.content)).toBeLessThanOrEqual(AUTO_MEMORY_MAX_BYTES);
		expect(loaded.content).not.toContain("�");
		expect(loaded.content.endsWith("a")).toBe(true);
		expect(loaded.truncated).toBe(true);
	});

	it("treats missing indexes as empty without creating them", () => {
		const root = makeTemp();
		const loaded = loadAutoMemory(join(root, "agent"), join(root, "project"), "chat");

		expect(loaded.global).toMatchObject({ exists: false, content: "" });
		expect(loaded.project).toMatchObject({ exists: false, content: "" });
		expect(loaded.global.error).toBeUndefined();
		expect(loaded.project.error).toBeUndefined();
		expect(existsSync(join(root, "agent", "memory"))).toBe(false);
	});

	it("deletes the obsolete shared project memory and history once while preserving global memory", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const memoryDir = join(agentDir, "memory");
		mkdirSync(join(memoryDir, "projects", "legacy"), { recursive: true });
		writeFileSync(join(memoryDir, "MEMORY.md"), "global");
		writeFileSync(join(memoryDir, "projects", "legacy", "project.md"), "obsolete");
		writeFileSync(join(memoryDir, "dream-history.jsonl"), "obsolete\n");

		await Promise.all([ensureModeScopedMemoryLayout(agentDir), ensureModeScopedMemoryLayout(agentDir)]);

		expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toBe("global");
		expect(existsSync(join(memoryDir, "projects", "legacy"))).toBe(false);
		expect(existsSync(join(memoryDir, "dream-history.jsonl"))).toBe(false);
		expect(readFileSync(join(memoryDir, ".mode-scoped-project-memory-v1"), "utf8")).toBe(
			"mode-scoped-project-memory-v1\n",
		);
	});

	it("preserves mode-scoped project memory after the migration marker exists", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const paths = getAutoMemoryPaths(agentDir, join(root, "project"), "code");
		mkdirSync(paths.project.directory, { recursive: true });
		writeFileSync(paths.project.indexPath, "code memory");
		writeFileSync(join(agentDir, "memory", "dream-history.jsonl"), "history\n");
		writeFileSync(join(agentDir, "memory", ".mode-scoped-project-memory-v1"), "mode-scoped-project-memory-v1\n");

		await ensureModeScopedMemoryLayout(agentDir);

		expect(readFileSync(paths.project.indexPath, "utf8")).toBe("code memory");
		expect(readFileSync(join(agentDir, "memory", "dream-history.jsonl"), "utf8")).toBe("history\n");
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked legacy projects path and can retry", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const memoryDir = join(agentDir, "memory");
		const outside = join(root, "outside");
		mkdirSync(memoryDir, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(memoryDir, "projects"));

		await expect(ensureModeScopedMemoryLayout(agentDir)).rejects.toThrow("non-directory memory path");
		unlinkSync(join(memoryDir, "projects"));
		await ensureModeScopedMemoryLayout(agentDir);

		expect(readFileSync(join(memoryDir, ".mode-scoped-project-memory-v1"), "utf8")).toContain("v1");
		expect(existsSync(outside)).toBe(true);
	});
});
