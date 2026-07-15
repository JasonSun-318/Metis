import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getModel } from "@arcmind/ai/compat";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutoMemoryPaths } from "../src/core/auto-memory.ts";
import {
	appendDreamHistory,
	commitDreamPlan,
	DREAM_SYSTEM_PROMPT,
	type DreamChanges,
	type DreamPlan,
	getDreamHistoryPath,
	isAllowedDreamToolPath,
	parseDreamPlan,
	prepareDreamCommit,
	readDreamHistory,
	runMemoryDream,
	snapshotDreamMemory,
} from "../src/core/memory-dream.ts";

describe("memory Dream", () => {
	const roots: string[] = [];
	const makeRoot = () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-dream-"));
		roots.push(root);
		return root;
	};

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("validates flat one-to-one indexes before touching disk", () => {
		const root = makeRoot();
		const snapshot = snapshotDreamMemory(join(root, "agent"), join(root, "project"));
		const valid: DreamPlan = {
			writes: [
				{
					scope: "global",
					file: "MEMORY.md",
					content: "- [preferences.md](preferences.md) — Explicit cross-project user preferences",
				},
				{ scope: "global", file: "preferences.md", content: "# Preferences\n\n- Reply in Chinese." },
			],
			deletes: [],
		};

		expect(prepareDreamCommit(snapshot, valid).changes.global.created).toEqual(["MEMORY.md", "preferences.md"]);
		expect(() =>
			prepareDreamCommit(snapshot, {
				writes: [{ scope: "global", file: "../escape.md", content: "escape" }],
				deletes: [],
			}),
		).toThrow("Dream file names must be flat .md basenames");
		expect(() =>
			prepareDreamCommit(snapshot, {
				writes: [{ scope: "global", file: "MEMORY.md", content: "- [missing.md](missing.md) — Missing" }],
				deletes: [],
			}),
		).toThrow("Global memory index links to missing.md, but that detail file does not exist");
		expect(() =>
			prepareDreamCommit(snapshot, {
				writes: [{ scope: "project", file: "orphan.md", content: "# Orphan" }],
				deletes: [],
			}),
		).toThrow("Project memory detail orphan.md has no project.md entry");
	});

	it("commits atomically, refuses stale plans, and honors cancellation", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const initial = snapshotDreamMemory(agentDir, cwd);
		const prepared = prepareDreamCommit(initial, {
			writes: [
				{ scope: "project", file: "project.md", content: "- [decisions.md](decisions.md) — Durable decisions" },
				{ scope: "project", file: "decisions.md", content: "# Decisions\n\n- Dream runs with Compact." },
			],
			deletes: [],
		});

		await expect(commitDreamPlan(initial, prepared)).resolves.toMatchObject({ status: "success" });
		const paths = getAutoMemoryPaths(agentDir, cwd);
		expect(readFileSync(paths.project.indexPath, "utf8")).toContain("decisions.md");

		const stale = snapshotDreamMemory(agentDir, cwd);
		const stalePlan = prepareDreamCommit(stale, {
			writes: [{ scope: "project", file: "decisions.md", content: "# Decisions\n\n- Dream update." }],
			deletes: [],
		});
		writeFileSync(join(paths.project.directory, "decisions.md"), "# Decisions\n\n- Concurrent update.");
		await expect(commitDreamPlan(stale, stalePlan)).resolves.toMatchObject({
			status: "skipped",
			reason: "Memory changed while Dream was running",
		});
		expect(readFileSync(join(paths.project.directory, "decisions.md"), "utf8")).toContain("Concurrent update");

		const cancelledSnapshot = snapshotDreamMemory(join(root, "cancelled-agent"), cwd);
		const cancelledPlan = prepareDreamCommit(cancelledSnapshot, {
			writes: [
				{ scope: "global", file: "MEMORY.md", content: "- [facts.md](facts.md) — Stable facts" },
				{ scope: "global", file: "facts.md", content: "# Facts\n\n- Stable." },
			],
			deletes: [],
		});
		const controller = new AbortController();
		controller.abort();
		await expect(commitDreamPlan(cancelledSnapshot, cancelledPlan, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(existsSync(getAutoMemoryPaths(join(root, "cancelled-agent"), cwd).global.indexPath)).toBe(false);
	});

	it("rolls both scopes back when a later filesystem write fails", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const snapshot = snapshotDreamMemory(agentDir, cwd);
		const prepared = prepareDreamCommit(snapshot, {
			writes: [
				{ scope: "global", file: "MEMORY.md", content: "- [facts.md](facts.md) — Stable facts" },
				{ scope: "global", file: "facts.md", content: "# Facts\n\n- Stable." },
				{ scope: "project", file: "project.md", content: "- [blocked.md](blocked.md) — Blocked write" },
				{ scope: "project", file: "blocked.md", content: "# Blocked\n\n- Write." },
			],
			deletes: [],
		});
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(join(paths.project.directory, "blocked.md"), { recursive: true });

		await expect(commitDreamPlan(snapshot, prepared)).rejects.toThrow();

		expect(existsSync(paths.global.indexPath)).toBe(false);
		expect(existsSync(join(paths.global.directory, "facts.md"))).toBe(false);
		expect(existsSync(paths.project.indexPath)).toBe(false);
		expect(lstatSync(join(paths.project.directory, "blocked.md")).isDirectory()).toBe(true);
	});

	it("keeps a successful commit successful when lock release fails", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const snapshot = snapshotDreamMemory(agentDir, cwd);
		const prepared = prepareDreamCommit(snapshot, {
			writes: [
				{ scope: "global", file: "MEMORY.md", content: "- [facts.md](facts.md) — Stable facts" },
				{ scope: "global", file: "facts.md", content: "# Facts\n\n- Stable." },
			],
			deletes: [],
		});
		vi.spyOn(lockfile, "lock").mockResolvedValue(async () => {
			throw new Error("release failed");
		});

		await expect(commitDreamPlan(snapshot, prepared)).resolves.toMatchObject({ status: "success" });
		expect(readFileSync(getAutoMemoryPaths(agentDir, cwd).global.indexPath, "utf8")).toContain("facts.md");
	});

	it("returns newest valid audit records and skips corrupt rows", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const changes: DreamChanges = {
			global: { created: [], updated: [], deleted: [] },
			project: { created: [], updated: [], deleted: [] },
		};
		for (let index = 1; index <= 12; index++) {
			await appendDreamHistory(agentDir, {
				id: `run-${index}`,
				sessionId: "session",
				project: "/project",
				trigger: "threshold",
				startedAt: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
				completedAt: `2026-07-15T00:00:${String(index).padStart(2, "0")}.500Z`,
				durationMs: 500,
				status: "skipped",
				changes,
				reason: "No durable memory changes",
			});
		}
		writeFileSync(getDreamHistoryPath(agentDir), "not-json\n{}\n", { flag: "a" });

		expect(readDreamHistory(agentDir, 10).map((record) => record.id)).toEqual([
			"run-12",
			"run-11",
			"run-10",
			"run-9",
			"run-8",
			"run-7",
			"run-6",
			"run-5",
			"run-4",
			"run-3",
		]);
	});

	it("scans large corrupt history lines once and still finds older valid records", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const changes: DreamChanges = {
			global: { created: [], updated: [], deleted: [] },
			project: { created: [], updated: [], deleted: [] },
		};
		const record = (id: string) => ({
			id,
			sessionId: "session",
			project: "/project",
			trigger: "manual" as const,
			startedAt: "2026-07-15T00:00:00.000Z",
			completedAt: "2026-07-15T00:00:01.000Z",
			durationMs: 1000,
			status: "success" as const,
			changes,
			reason: "整理完成",
		});
		await appendDreamHistory(agentDir, record("older"));
		writeFileSync(getDreamHistoryPath(agentDir), `${"x".repeat(70_000)}\n`, { flag: "a" });
		await appendDreamHistory(agentDir, record("newer"));

		expect(readDreamHistory(agentDir, 2).map(({ id }) => id)).toEqual(["newer", "older"]);
	});

	it("uses a concise strict prompt and JSON-only mutation contract", () => {
		expect(DREAM_SYSTEM_PROMPT).toContain("silent long-term memory maintainer");
		expect(DREAM_SYSTEM_PROMPT).toContain("Global facts apply across projects");
		expect(DREAM_SYSTEM_PROMPT).toContain("The current working directory defines the project");
		expect(DREAM_SYSTEM_PROMPT).toContain("Return exactly one JSON object and no prose");
		expect(DREAM_SYSTEM_PROMPT).not.toContain("codebase");
		expect(parseDreamPlan('{"writes":[],"deletes":[]}')).toEqual({ writes: [], deletes: [] });
		expect(() => parseDreamPlan('```json\n{"writes":[],"deletes":[]}\n```')).toThrow(
			"Dream must return exactly one JSON object",
		);
		expect(() => parseDreamPlan('{"writes":[],"deletes":[],"notes":"extra"}')).toThrow(
			"Dream plan contains unknown fields",
		);
	});

	it("allows tools only in global and current-project flat Markdown scopes", () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(paths.project.directory, { recursive: true });
		writeFileSync(paths.global.indexPath, "# Global");
		writeFileSync(paths.project.indexPath, "# Project");

		expect(isAllowedDreamToolPath(paths.global.indexPath, "read", paths)).toBe(true);
		expect(isAllowedDreamToolPath(paths.project.indexPath, "grep", paths)).toBe(true);
		expect(isAllowedDreamToolPath(paths.global.directory, "ls", paths)).toBe(true);
		expect(
			isAllowedDreamToolPath(join(paths.global.directory, "projects", "other", "project.md"), "read", paths),
		).toBe(false);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked Markdown tool paths", () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd);
		mkdirSync(paths.global.directory, { recursive: true });
		const target = join(root, "outside.md");
		const link = join(paths.global.directory, "linked.md");
		writeFileSync(target, "# Outside");
		symlinkSync(target, link, "file");
		expect(isAllowedDreamToolPath(link, "read", paths)).toBe(false);
		expect(() => snapshotDreamMemory(agentDir, cwd)).toThrow("Dream memory file cannot be a symbolic link");
	});

	it.skipIf(process.platform === "win32")("does not follow a symlinked audit history file", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const historyPath = getDreamHistoryPath(agentDir);
		mkdirSync(dirname(historyPath), { recursive: true });
		const outside = join(root, "outside.jsonl");
		writeFileSync(outside, "sentinel\n");
		symlinkSync(outside, historyPath, "file");

		await expect(
			appendDreamHistory(agentDir, {
				id: "blocked",
				sessionId: "session",
				project: "/project",
				trigger: "manual",
				startedAt: "2026-07-15T00:00:00.000Z",
				completedAt: "2026-07-15T00:00:01.000Z",
				durationMs: 1000,
				status: "failed",
				changes: {
					global: { created: [], updated: [], deleted: [] },
					project: { created: [], updated: [], deleted: [] },
				},
			}),
		).rejects.toThrow("Dream memory path cannot be a symbolic link");
		expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
	});

	it("runs without a live provider and stores metadata rather than memory content", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const result = await runMemoryDream({
			id: "dream-test",
			sessionId: "session-test",
			project: cwd,
			trigger: "manual",
			startedAt: new Date().toISOString(),
			agentDir,
			cwd,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "off",
			streamFn: () => {
				throw new Error("the injected planner must avoid streamFn");
			},
			messages: [],
			signal: new AbortController().signal,
			generatePlan: async () => ({
				writes: [
					{
						scope: "global",
						file: "MEMORY.md",
						content: "- [preferences.md](preferences.md) — Explicit cross-project preferences",
					},
					{ scope: "global", file: "preferences.md", content: "# Preferences\n\n- Reply in Chinese." },
				],
				deletes: [],
			}),
		});

		expect(result.status).toBe("success");
		const history = readDreamHistory(agentDir, 10);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ id: "dream-test", sessionId: "session-test", project: cwd });
		expect(JSON.stringify(history[0])).not.toContain("Reply in Chinese");
	});
});
