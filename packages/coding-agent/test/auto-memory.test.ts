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
	ensureAutoMemoryLayout,
	ensureModeScopedMemoryLayout,
	getAutoMemoryPaths,
	getAutoMemoryRoot,
	getMemorySqlitePath,
	initializeAutoMemory,
	loadAutoMemory,
} from "../src/core/auto-memory.ts";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import { canonicalizePathForCreation } from "../src/utils/paths.ts";

describe("auto memory", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-memory-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("separates the global projection, database, and exact project", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		const memoryRoot = join(canonicalizePathForCreation(agentDir), "memory");
		expect(paths.global.indexPath).toBe(join(memoryRoot, "global", "MEMORY.md"));
		expect(paths.project.indexPath).toBe(
			join(memoryRoot, "projects", memoryProjectIdentity(cwd).projectKey, "project.md"),
		);
		expect(getMemorySqlitePath(agentDir)).toBe(join(memoryRoot, "memory.sqlite"));
		expect(getAutoMemoryRoot(agentDir)).toBe(memoryRoot);
		expect(existsSync(getAutoMemoryRoot(agentDir))).toBe(false);
	});

	it("shares only an exact primary cwd across Chat and Code", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const exact = getAutoMemoryPaths(agentDir, cwd);
		const same = getAutoMemoryPaths(agentDir, join(cwd, "."));
		const child = getAutoMemoryPaths(agentDir, join(cwd, "packages", "api"));
		expect(exact.project.directory).toBe(same.project.directory);
		expect(child.project.directory).not.toBe(exact.project.directory);
	});

	it("loads only complete lines within the 200-line limit", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(dirname(paths.global.indexPath), { recursive: true });
		writeFileSync(
			paths.global.indexPath,
			Array.from({ length: AUTO_MEMORY_MAX_LINES + 1 }, (_, index) => `line-${index + 1}`).join("\n"),
		);
		const loaded = loadAutoMemory(agentDir, cwd).global;
		expect(loaded.content).toContain("line-200");
		expect(loaded.content).not.toContain("line-201");
		expect(loaded.truncated).toBe(true);
	});

	it("does not inject a byte-truncated Markdown line or split UTF-8", () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(dirname(paths.project.indexPath), { recursive: true });
		writeFileSync(paths.project.indexPath, `safe\n${"a".repeat(AUTO_MEMORY_MAX_BYTES)}你tail`);
		const loaded = loadAutoMemory(agentDir, cwd).project;
		expect(loaded.content).toBe("safe");
		expect(loaded.content).not.toContain("�");
		expect(loaded.truncated).toBe(true);
	});

	it("preserves historical files while ensuring the new directories", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const memoryDir = join(agentDir, "memory");
		mkdirSync(join(memoryDir, "projects", "legacy"), { recursive: true });
		writeFileSync(join(memoryDir, "projects", "legacy", "project.md"), "historical");
		writeFileSync(join(memoryDir, "dream-history.jsonl"), "history\n");
		await Promise.all([ensureModeScopedMemoryLayout(agentDir), ensureModeScopedMemoryLayout(agentDir)]);
		expect(readFileSync(join(memoryDir, "projects", "legacy", "project.md"), "utf8")).toBe("historical");
		expect(readFileSync(join(memoryDir, "dream-history.jsonl"), "utf8")).toBe("history\n");
		expect(existsSync(join(memoryDir, "global"))).toBe(true);
	});

	it("recovers startup health once without overwriting later live operations", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		await ensureAutoMemoryLayout(agentDir);
		let store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.recordHealth({
			operation: "extract",
			status: "running",
			updatedAt: "2026-08-20T00:00:00.000Z",
			reason: null,
		});
		store.close();

		await Promise.all([initializeAutoMemory(agentDir), initializeAutoMemory(agentDir)]);
		store = openMemoryStore(getMemorySqlitePath(agentDir));
		expect(store.listHealth()).toContainEqual(
			expect.objectContaining({ operation: "extract", status: "error", reason: "Interrupted before completion" }),
		);
		store.recordHealth({
			operation: "extract",
			status: "running",
			updatedAt: "2026-08-21T00:00:00.000Z",
			reason: null,
		});
		store.close();

		await ensureModeScopedMemoryLayout(agentDir);
		store = openMemoryStore(getMemorySqlitePath(agentDir));
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "extract", status: "running" }));
		store.close();
	});

	it.skipIf(process.platform === "win32")("rejects a symlinked projects directory and can retry", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const memoryDir = join(agentDir, "memory");
		const outside = join(root, "outside");
		mkdirSync(memoryDir, { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(memoryDir, "projects"));
		await expect(ensureModeScopedMemoryLayout(agentDir)).rejects.toThrow(/real directory/i);
		unlinkSync(join(memoryDir, "projects"));
		await ensureModeScopedMemoryLayout(agentDir);
		expect(existsSync(outside)).toBe(true);
	});
});
