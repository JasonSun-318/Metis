import {
	type Dirent,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDream } from "../src/core/memory/dream/run.ts";
import { readDreamState } from "../src/core/memory/dream/state.ts";
import { resolveDreamSettings } from "../src/core/memory/dream/types.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { MemoryEvents } from "../src/core/memory/vault-events.ts";
import { getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { encodePathForStorage } from "../src/utils/paths.ts";

describe("dream run", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-dream-run-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(agentDir: string, id: string, text: string, cwd = agentDir): void {
		const dir = join(agentDir, "sessions", encodePathForStorage(cwd));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${id}.jsonl`);
		const records = [
			{
				type: "session",
				version: 14,
				id,
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd,
				mode: "code",
				permissionPreset: "auto",
			},
			{
				type: "message",
				id: `${id}-m1`,
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: text, timestamp: 1000 },
			},
		];
		writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(path, old, old);
	}

	/** Byte-for-byte snapshot of every file under a directory. */
	function snapshotTree(dir: string, base = dir): Map<string, string> {
		const files = new Map<string, string>();
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return files;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				for (const [key, value] of snapshotTree(path, base)) files.set(key, value);
			} else if (entry.isFile()) {
				files.set(path.slice(base.length), readFileSync(path, "utf8"));
			}
		}
		return files;
	}

	const settings = resolveDreamSettings({ dream: { enabled: true, minSessions: 5, minHours: 24 } });

	it("runs phase 1 + phase 2, updates state, and emits dreamCompleted", async () => {
		const agentDir = join(makeTemp(), "agent");
		for (let i = 0; i < 5; i++) writeSession(agentDir, `sess-${i}`, `session ${i} says use pnpm`);

		const events = new MemoryEvents();
		const completed: unknown[] = [];
		events.on("dreamCompleted", (payload) => completed.push(payload));

		const result = await runDream({
			agentDir,
			settings,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({
				candidates: [{ type: "feedback", scope: "global", slug: "pnpm-only", text: "User wants pnpm only." }],
			}),
			promptAgent: async (ctx) => {
				expect(ctx.user).toContain("pnpm");
				await ctx.callTool("memory_write", {
					op: "create",
					scope: "global",
					target: { slug: "pnpm-only" },
					frontmatter: { type: "feedback", description: "only pnpm" },
					content: "**Why:** lockfile\n**How to apply:** use pnpm",
				});
				await ctx.callTool("finish_dream", {});
			},
			events,
		});

		expect(result.ran).toBe(true);
		if (!result.ran) return;
		expect(result.added).toBe(1);
		expect(result.sessions).toBe(5);
		expect(result.candidates).toBe(5);

		const vault = new MemoryVault({ agentDir });
		expect(vault.readNote("global", "pnpm-only")?.body).toContain("pnpm");

		const state = readDreamState(agentDir);
		expect(state.lastRun?.runId).toBe(result.runId);
		expect(state.processedSessionIds.sort()).toEqual([0, 1, 2, 3, 4].map((i) => `sess-${i}`).sort());
		expect(completed).toEqual([{ runId: result.runId, added: 1, updated: 0, deleted: 0 }]);
	});

	it("undoRun restores note bytes exactly", async () => {
		const agentDir = join(makeTemp(), "agent");
		for (let i = 0; i < 5; i++) writeSession(agentDir, `sess-${i}`, `session ${i}`);
		const vault = new MemoryVault({ agentDir });
		vault.ensureLayout();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "existing" },
				frontmatter: { type: "reference", description: "pre-existing" },
				content: "keep me",
			},
			{ kind: "user" },
		);
		const before = snapshotTree(join(getVaultRoot(agentDir), "global"));

		const result = await runDream({
			agentDir,
			settings,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({
				candidates: [{ scope: "global", slug: "new-note", text: "Fresh fact." }],
			}),
			promptAgent: async (ctx) => {
				await ctx.callTool("memory_write", {
					op: "create",
					scope: "global",
					target: { slug: "new-note" },
					frontmatter: { type: "reference", description: "new" },
					content: "fresh",
				});
				await ctx.callTool("memory_write", {
					op: "append",
					scope: "global",
					target: { slug: "existing" },
					content: "\nappended by dream",
				});
				await ctx.callTool("finish_dream", {});
			},
		});
		expect(result.ran).toBe(true);
		if (!result.ran) return;
		expect(result.added).toBe(1);
		expect(result.updated).toBe(1);

		const undo = await vault.undoRun(result.runId, { kind: "user" });
		expect(undo.skipped).toEqual([]);
		expect(undo.undone.length).toBeGreaterThanOrEqual(2);
		expect(snapshotTree(join(getVaultRoot(agentDir), "global"))).toEqual(before);
	});

	it("gate failures make zero model calls", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "only-1", "hi"); // below minSessions
		let prompts = 0;
		let agents = 0;
		const result = await runDream({
			agentDir,
			settings,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => {
				prompts += 1;
				return { candidates: [] };
			},
			promptAgent: async () => {
				agents += 1;
			},
		});
		expect(result).toEqual({ ran: false, reason: "insufficient-sessions" });
		expect(prompts).toBe(0);
		expect(agents).toBe(0);

		const noModel = await runDream({
			agentDir,
			settings,
			model: null,
			promptFn: async () => {
				prompts += 1;
				return { candidates: [] };
			},
			promptAgent: async () => {
				agents += 1;
			},
			ignoreGate: true,
		});
		expect(noModel).toEqual({ ran: false, reason: "no-model" });
		expect(prompts).toBe(0);
		expect(agents).toBe(0);
	});
});
