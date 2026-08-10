import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutoMemoryPaths } from "../src/core/auto-memory.ts";
import {
	appendDreamHistory,
	commitDreamPlan,
	DREAM_SYSTEM_PROMPTS,
	type DreamHistoryRecord,
	type DreamPlan,
	type DreamRunStatus,
	type DreamScope,
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
		const root = mkdtempSync(join(tmpdir(), "metis-dream-"));
		roots.push(root);
		return root;
	};
	const changes = {
		created: [] as string[],
		updated: [] as string[],
		deleted: [] as string[],
	};
	const scopeResult = (status: DreamRunStatus) => ({
		status,
		changes,
		durationMs: 10,
	});
	const record = (id: string): DreamHistoryRecord => ({
		id,
		sessionId: "session",
		mode: "chat",
		cwd: "/project",
		trigger: "manual",
		startedAt: "2026-07-15T00:00:00.000Z",
		completedAt: "2026-07-15T00:00:01.000Z",
		durationMs: 1000,
		global: scopeResult("skipped"),
		project: scopeResult("success"),
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it.each([
		["global", "MEMORY.md", "Global"],
		["project", "project.md", "Project"],
	] as const)("validates the %s flat one-to-one index before touching disk", (scope, indexFile, label) => {
		const root = makeRoot();
		const snapshot = snapshotDreamMemory(join(root, "agent"), join(root, "project"), "chat", scope);
		const valid: DreamPlan = {
			writes: [
				{
					file: indexFile,
					content: "- [facts.md](facts.md) — Verified durable facts",
				},
				{ file: "facts.md", content: "# Facts\n\n- Verified." },
			],
			deletes: [],
		};

		expect(prepareDreamCommit(snapshot, valid).changes.created).toEqual([indexFile, "facts.md"].sort());
		expect(() =>
			prepareDreamCommit(snapshot, {
				writes: [{ file: "../escape.md", content: "escape" }],
				deletes: [],
			}),
		).toThrow("Dream file names must be flat .md basenames");
		expect(() =>
			prepareDreamCommit(snapshot, {
				writes: [
					{
						file: indexFile,
						content: "- [missing.md](missing.md) — Missing",
					},
				],
				deletes: [],
			}),
		).toThrow(`${label} memory index links to missing.md, but that detail file does not exist`);
	});

	it("commits one scope, refuses a stale plan, and honors cancellation", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const initial = snapshotDreamMemory(agentDir, cwd, "code", "project");
		const prepared = prepareDreamCommit(initial, {
			writes: [
				{
					file: "project.md",
					content: "- [decisions.md](decisions.md) — Durable decisions",
				},
				{
					file: "decisions.md",
					content: "# Decisions\n\n- Dream runs with Compact.",
				},
			],
			deletes: [],
		});

		await expect(commitDreamPlan(initial, prepared)).resolves.toMatchObject({
			status: "success",
		});
		const paths = getAutoMemoryPaths(agentDir, cwd, "code");
		expect(readFileSync(paths.project.indexPath, "utf8")).toContain("decisions.md");

		const stale = snapshotDreamMemory(agentDir, cwd, "code", "project");
		const stalePlan = prepareDreamCommit(stale, {
			writes: [{ file: "decisions.md", content: "# Decisions\n\n- Dream update." }],
			deletes: [],
		});
		writeFileSync(join(paths.project.directory, "decisions.md"), "# Decisions\n\n- Concurrent update.");
		await expect(commitDreamPlan(stale, stalePlan)).resolves.toMatchObject({
			status: "skipped",
			reason: "Memory changed while Dream was running",
		});

		const cancelled = snapshotDreamMemory(join(root, "cancelled-agent"), cwd, "chat", "global");
		const cancelledPlan = prepareDreamCommit(cancelled, {
			writes: [
				{ file: "MEMORY.md", content: "- [facts.md](facts.md) — Stable facts" },
				{ file: "facts.md", content: "# Facts\n\n- Stable." },
			],
			deletes: [],
		});
		const controller = new AbortController();
		controller.abort();
		await expect(commitDreamPlan(cancelled, cancelledPlan, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(existsSync(getAutoMemoryPaths(join(root, "cancelled-agent"), cwd, "chat").global.indexPath)).toBe(false);
	});

	it("rolls back files already written when a later write fails", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const snapshot = snapshotDreamMemory(agentDir, cwd, "chat", "project");
		const prepared = prepareDreamCommit(snapshot, {
			writes: [
				{
					file: "project.md",
					content: "- [a.md](a.md) — First\n- [blocked.md](blocked.md) — Blocked",
				},
				{ file: "a.md", content: "# First" },
				{ file: "blocked.md", content: "# Blocked" },
			],
			deletes: [],
		});
		const paths = getAutoMemoryPaths(agentDir, cwd, "chat");
		mkdirSync(join(paths.project.directory, "blocked.md"), { recursive: true });

		await expect(commitDreamPlan(snapshot, prepared)).rejects.toThrow();
		expect(existsSync(join(paths.project.directory, "a.md"))).toBe(false);
		expect(existsSync(paths.project.indexPath)).toBe(false);
		expect(lstatSync(join(paths.project.directory, "blocked.md")).isDirectory()).toBe(true);
	});

	it("keeps a successful commit successful when lock release fails", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const snapshot = snapshotDreamMemory(agentDir, cwd, "chat", "global");
		const prepared = prepareDreamCommit(snapshot, {
			writes: [
				{ file: "MEMORY.md", content: "- [facts.md](facts.md) — Stable facts" },
				{ file: "facts.md", content: "# Facts\n\n- Stable." },
			],
			deletes: [],
		});
		vi.spyOn(lockfile, "lock").mockResolvedValue(async () => {
			throw new Error("release failed");
		});

		await expect(commitDreamPlan(snapshot, prepared)).resolves.toMatchObject({
			status: "success",
		});
		expect(readFileSync(getAutoMemoryPaths(agentDir, cwd, "chat").global.indexPath, "utf8")).toContain("facts.md");
	});

	it("returns newest valid audit records across a large corrupt row", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		await appendDreamHistory(agentDir, record("older"));
		writeFileSync(getDreamHistoryPath(agentDir), `${"x".repeat(70_000)}\n`, {
			flag: "a",
		});
		await appendDreamHistory(agentDir, record("newer"));
		writeFileSync(getDreamHistoryPath(agentDir), "not-json\n{}\n", {
			flag: "a",
		});

		expect(readDreamHistory(agentDir, 2).map(({ id }) => id)).toEqual(["newer", "older"]);
	});

	it("uses separate strict prompts and a scope-free JSON mutation contract", () => {
		expect(DREAM_SYSTEM_PROMPTS.global).toContain("global long-term memory maintainer");
		expect(DREAM_SYSTEM_PROMPTS.project).toContain("working directory and mode");
		expect(DREAM_SYSTEM_PROMPTS.global).toContain("Return exactly one JSON object and no prose");
		expect(parseDreamPlan('{"writes":[],"deletes":[]}')).toEqual({
			writes: [],
			deletes: [],
		});
		expect(() => parseDreamPlan('{"writes":[{"scope":"global","file":"x.md","content":"x"}],"deletes":[]}')).toThrow(
			"Dream plan contains unknown fields",
		);
		expect(() => parseDreamPlan('```json\n{"writes":[],"deletes":[]}\n```')).toThrow(
			"Dream must return exactly one JSON object",
		);
	});

	it("allows tools only inside the selected flat Markdown scope", () => {
		const root = makeRoot();
		const paths = getAutoMemoryPaths(join(root, "agent"), join(root, "project"), "chat");
		mkdirSync(paths.project.directory, { recursive: true });
		writeFileSync(paths.global.indexPath, "# Global");
		writeFileSync(paths.project.indexPath, "# Project");

		expect(isAllowedDreamToolPath(paths.global.indexPath, "read", paths.global)).toBe(true);
		expect(isAllowedDreamToolPath(paths.project.indexPath, "grep", paths.project)).toBe(true);
		expect(isAllowedDreamToolPath(paths.global.directory, "ls", paths.global)).toBe(true);
		expect(isAllowedDreamToolPath(paths.project.indexPath, "read", paths.global)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked memory and audit paths", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const paths = getAutoMemoryPaths(agentDir, cwd, "chat");
		mkdirSync(paths.global.directory, { recursive: true });
		const outsideMemory = join(root, "outside.md");
		const linkedMemory = join(paths.global.directory, "linked.md");
		writeFileSync(outsideMemory, "# Outside");
		symlinkSync(outsideMemory, linkedMemory, "file");
		expect(isAllowedDreamToolPath(linkedMemory, "read", paths.global)).toBe(false);
		expect(() => snapshotDreamMemory(agentDir, cwd, "chat", "global")).toThrow(
			"Dream memory file cannot be a symbolic link",
		);

		rmSync(linkedMemory);
		const historyPath = getDreamHistoryPath(agentDir);
		const outsideHistory = join(root, "outside.jsonl");
		writeFileSync(outsideHistory, "sentinel\n");
		symlinkSync(outsideHistory, historyPath, "file");
		await expect(appendDreamHistory(agentDir, record("blocked"))).rejects.toThrow(
			"Dream memory path cannot be a symbolic link",
		);
		expect(readFileSync(outsideHistory, "utf8")).toBe("sentinel\n");

		rmSync(historyPath);
		linkSync(outsideHistory, historyPath);
		await expect(appendDreamHistory(agentDir, record("hard-linked"))).rejects.toThrow(
			"Refusing to append aliased Dream history",
		);
		expect(readFileSync(outsideHistory, "utf8")).toBe("sentinel\n");
	});

	it("starts both scopes concurrently with one evidence serialization and one audit record", async () => {
		const root = makeRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const entered: DreamScope[] = [];
		const evidences: string[] = [];
		let releaseBoth!: () => void;
		const bothEntered = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});
		const serializeEvidence = vi.fn(() => "shared evidence");
		const generatePlan = vi.fn(async ({ scope, evidence }: { scope: DreamScope; evidence: string }) => {
			entered.push(scope);
			evidences.push(evidence);
			if (entered.length === 2) releaseBoth();
			await bothEntered;
			const index = scope === "global" ? "MEMORY.md" : "project.md";
			return {
				writes: [
					{ file: index, content: "- [facts.md](facts.md) — Verified facts" },
					{ file: "facts.md", content: `# ${scope}` },
				],
				deletes: [],
			};
		});
		const result = await runMemoryDream({
			id: "dream-test",
			sessionId: "session-test",
			mode: "chat",
			cwd,
			trigger: "manual",
			startedAt: new Date().toISOString(),
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "off",
			streamFn: () => {
				throw new Error("the injected planner must avoid streamFn");
			},
			messages: [],
			signal: new AbortController().signal,
			generatePlan: generatePlan as never,
			serializeEvidence,
		});

		expect(serializeEvidence).toHaveBeenCalledOnce();
		expect(new Set(entered)).toEqual(new Set(["global", "project"]));
		expect(evidences).toEqual(["shared evidence", "shared evidence"]);
		expect(result.global.status).toBe("success");
		expect(result.project.status).toBe("success");
		expect(readDreamHistory(agentDir, 10)).toHaveLength(1);
		expect(JSON.stringify(readDreamHistory(agentDir, 1)[0])).not.toContain("# global");
	});

	it("keeps the project result when the global Dream fails", async () => {
		const root = makeRoot();
		const cwd = join(root, "project");
		const result = await runMemoryDream({
			id: "partial",
			sessionId: "session",
			mode: "code",
			cwd,
			trigger: "threshold",
			startedAt: new Date().toISOString(),
			agentDir: join(root, "agent"),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			thinkingLevel: "off",
			streamFn: () => {
				throw new Error("unused");
			},
			messages: [],
			signal: new AbortController().signal,
			generatePlan: (async ({ scope }: { scope: DreamScope }) => {
				if (scope === "global") throw new Error("global failed");
				return {
					writes: [
						{
							file: "project.md",
							content: "- [facts.md](facts.md) — Project facts",
						},
						{ file: "facts.md", content: "# Project" },
					],
					deletes: [],
				};
			}) as never,
		});

		expect(result.global).toMatchObject({
			status: "failed",
			reason: "global failed",
		});
		expect(result.project.status).toBe("success");
		expect(readFileSync(getAutoMemoryPaths(join(root, "agent"), cwd, "code").project.indexPath, "utf8")).toContain(
			"facts.md",
		);
	});
});
