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
import { afterEach, describe, expect, it, vi } from "vitest";
import { enumerateSessions } from "../src/core/memory/dream/gate.ts";
import { type RunDreamOptions, runDream } from "../src/core/memory/dream/run.ts";
import { readDreamState } from "../src/core/memory/dream/state.ts";
import { resolveDreamSettings } from "../src/core/memory/dream/types.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { MemoryEvents } from "../src/core/memory/vault-events.ts";
import { getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { undoMemoryRun } from "../src/core/memory/vault-run-undo.ts";
import { readUsage } from "../src/core/memory/vault-usage.ts";
import { SessionLease } from "../src/core/session-lease.ts";
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

	it.each([false, true])(
		"keeps corrupt transcripts retryable (with healthy session: %s)",
		async (withHealthySession) => {
			const agentDir = join(makeTemp(), "agent");
			writeSession(agentDir, "broken", "remember this");
			const path = join(agentDir, "sessions", encodePathForStorage(agentDir), "broken.jsonl");
			writeFileSync(path, `${readFileSync(path, "utf8")}{not-json}\n`);
			const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
			utimesSync(path, old, old);
			if (withHealthySession) writeSession(agentDir, "healthy", "valid transcript");
			const promptFn = vi.fn(async () => ({ candidates: [] }));
			const options: RunDreamOptions = {
				agentDir,
				settings,
				model: { provider: "test", modelId: "cheap" },
				promptFn,
				ignoreGate: true,
				promptAgent: async (ctx) => {
					await ctx.callTool("finish_dream", {});
				},
			};
			const first = await runDream(options);
			expect(first.ran).toBe(withHealthySession);
			expect(readDreamState(agentDir).processedSessionIds).toEqual(withHealthySession ? ["healthy"] : []);
			if (!withHealthySession) {
				expect(first).toMatchObject({ reason: "error", error: "all 1 session extractions failed" });
				expect(readDreamState(agentDir).lastRunAt).toBeUndefined();
			}
			expect(promptFn).toHaveBeenCalledTimes(withHealthySession ? 1 : 0);

			writeSession(agentDir, "broken", "repaired transcript");
			expect(await runDream(options)).toMatchObject({ ran: true, sessions: 1 });
			expect(promptFn).toHaveBeenCalledTimes(withHealthySession ? 2 : 1);
			expect(readDreamState(agentDir).processedSessionIds.sort()).toEqual(
				withHealthySession ? ["broken", "healthy"] : ["broken"],
			);
		},
	);

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

	it("undoMemoryRun byte-restores global and project vaults after a full run", async () => {
		const agentDir = join(makeTemp(), "agent");
		const rootA = join(makeTemp(), "proj-a");
		const rootB = join(makeTemp(), "proj-b");
		mkdirSync(rootA);
		mkdirSync(rootB);
		for (let i = 0; i < 5; i++) writeSession(agentDir, `sess-${i}`, `session ${i}`);

		const projectA = resolveVaultProject(rootA, "user-selected")!;
		const projectB = resolveVaultProject(rootB, "user-selected")!;
		const globalVault = new MemoryVault({ agentDir });
		globalVault.ensureLayout();
		const vaultA = new MemoryVault({ agentDir, project: projectA });
		vaultA.ensureLayout();
		const vaultB = new MemoryVault({ agentDir, project: projectB });
		vaultB.ensureLayout();
		// Sessions run with cwd=agentDir; materialize that project vault too so its
		// layout metadata is part of the baseline rather than a post-run leftover.
		new MemoryVault({ agentDir, project: resolveVaultProject(agentDir, "user-selected") }).ensureLayout();
		const user = { kind: "user" as const };
		await globalVault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "stale" },
				frontmatter: { type: "reference", description: "will be deleted" },
				content: "stale",
			},
			user,
		);
		await vaultA.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "renamed-me" },
				frontmatter: { type: "project", description: "rename target" },
				content: "old name",
			},
			user,
		);
		await vaultA.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "linker" },
				frontmatter: { type: "reference", description: "references the target" },
				content: "see [[renamed-me]]",
			},
			user,
		);
		await vaultB.write(
			{
				op: "create",
				scope: "project",
				target: { slug: "b-note" },
				frontmatter: { type: "project", description: "untouched" },
				content: "b stays",
			},
			user,
		);
		const beforeGlobal = snapshotTree(join(getVaultRoot(agentDir), "global"));
		const beforeProjects = snapshotTree(join(getVaultRoot(agentDir), "projects"));

		const events = new MemoryEvents();
		const changed: string[] = [];
		events.on("changed", (event) => changed.push(event.entry.id));
		const result = await runDream({
			agentDir,
			settings,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({
				candidates: [
					{ scope: "global" as const, slug: "new-note", text: "Fresh fact." },
					{ scope: "project" as const, slug: "a-note", text: "Project A fact.", project: projectA },
				],
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
					op: "delete",
					scope: "global",
					target: { slug: "stale" },
				});
				await ctx.callTool("memory_write", {
					op: "rename",
					scope: "project",
					project: projectA.root,
					target: { slug: "renamed-me" },
					newSlug: "renamed-done",
				});
				await ctx.callTool("memory_write", {
					op: "append",
					scope: "project",
					project: projectA.root,
					target: { slug: "linker" },
					content: "\nmore",
				});
				await ctx.callTool("memory_write", {
					op: "append",
					scope: "project",
					project: projectA.root,
					target: { block: "project" },
					content: "first pinned block",
				});
				await ctx.callTool("finish_dream", {});
			},
			events,
		});
		if (!result.ran) throw new Error(JSON.stringify(result));
		expect(result.added).toBe(1);
		expect(result.deleted).toBe(1);
		const writesDuringRun = changed.length;
		expect(writesDuringRun).toBeGreaterThanOrEqual(5);
		expect(readDreamState(agentDir).processedSessionIds).toHaveLength(5);

		const reverted = await undoMemoryRun({ agentDir, runId: result.runId, actor: { kind: "user" }, events });
		expect(reverted.skipped).toEqual([]);
		expect(reverted.undone.length).toBeGreaterThanOrEqual(5);
		expect(snapshotTree(join(getVaultRoot(agentDir), "global"))).toEqual(beforeGlobal);
		expect(snapshotTree(join(getVaultRoot(agentDir), "projects"))).toEqual(beforeProjects);
		// Every revert emits its own event; dream search never records usage.
		expect(changed.length).toBeGreaterThan(writesDuringRun);
		expect(readUsage(getVaultRoot(agentDir))).toEqual({});
	});

	it("does not mark sessions processed when phase 2 never finishes", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "unfinished", "remember pnpm");
		const result = await runDream({
			agentDir,
			settings,
			ignoreGate: true,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({ candidates: [{ scope: "global", text: "user prefers pnpm" }] }),
			promptAgent: async () => {},
		});
		expect(result.ran).toBe(false);
		expect(readDreamState(agentDir).processedSessionIds).not.toContain("unfinished");
		expect(readDreamState(agentDir).lastRunAt).toBeUndefined();
	});

	it("keeps incomplete run writes attributable and retryable", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "partial", "remember pnpm");
		const result = await runDream({
			agentDir,
			settings,
			ignoreGate: true,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({ candidates: [{ scope: "global", text: "pnpm only" }] }),
			promptAgent: async (ctx) => {
				await ctx.callTool("memory_write", {
					op: "create",
					scope: "global",
					target: { slug: "partial" },
					frontmatter: { type: "reference" },
					content: "pnpm",
				});
			},
		});
		expect(result.ran).toBe(false);
		if (result.ran || !result.runId) throw new Error("expected failed run with id");
		expect(readDreamState(agentDir).processedSessionIds).not.toContain("partial");
		const undo = await undoMemoryRun({ agentDir, runId: result.runId, actor: { kind: "user" } });
		expect(undo.skipped).toEqual([]);
		expect(new MemoryVault({ agentDir }).readNote("global", "partial")).toBeUndefined();
	});

	it("runs maintenance with no new candidates", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "empty", "nothing durable");
		let called = false;
		const result = await runDream({
			agentDir,
			settings,
			ignoreGate: true,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => ({ candidates: [] }),
			promptAgent: async (ctx) => {
				called = true;
				await ctx.callTool("finish_dream", {});
			},
		});
		expect(result.ran).toBe(true);
		expect(called).toBe(true);
	});

	it("fails the run when every phase 1 prompt fails", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "s1", "remember pnpm");
		writeSession(agentDir, "s2", "remember npm");
		const result = await runDream({
			agentDir,
			settings,
			ignoreGate: true,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async () => {
				throw new Error("model down");
			},
			promptAgent: async () => {
				throw new Error("unreachable");
			},
		});
		expect(result.ran).toBe(false);
		if (result.ran) return;
		expect(result.reason).toBe("error");
		expect(result.error).toContain("2");
		expect(readDreamState(agentDir).processedSessionIds).toEqual([]);
	});

	it("marks only successfully processed sessions when some prompts fail", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "good", "remember pnpm", join(agentDir, "good-cwd"));
		writeSession(agentDir, "bad", "remember npm", join(agentDir, "bad-cwd"));
		const result = await runDream({
			agentDir,
			settings,
			ignoreGate: true,
			model: { provider: "test", modelId: "cheap" },
			promptFn: async (request) => {
				if (request.user.includes("bad-cwd")) throw new Error("model down");
				return { candidates: [] };
			},
			promptAgent: async (ctx) => {
				await ctx.callTool("finish_dream", {});
			},
		});
		expect(result.ran).toBe(true);
		expect(readDreamState(agentDir).processedSessionIds).toEqual(["good"]);
	});

	it("clamps timeout overrides to the hard cap", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "t1", "remember pnpm");
		const spy = vi.spyOn(AbortSignal, "timeout");
		try {
			const result = await runDream({
				agentDir,
				settings,
				ignoreGate: true,
				timeoutMs: 60 * 60 * 1000,
				phase2TimeoutMs: 60 * 60 * 1000,
				model: { provider: "test", modelId: "cheap" },
				promptFn: async () => ({ candidates: [] }),
				promptAgent: async (ctx) => {
					await ctx.callTool("finish_dream", {});
				},
			});
			expect(result.ran).toBe(true);
			for (const call of spy.mock.calls) expect(call[0]).toBeLessThanOrEqual(600_000);
		} finally {
			spy.mockRestore();
		}
	});

	it("re-filters sessions after acquiring the dream lock", async () => {
		const agentDir = join(makeTemp(), "agent");
		writeSession(agentDir, "s-free", "remember pnpm");
		writeSession(agentDir, "s-leased", "remember npm");
		// Enumerate while free, then take the lease — simulates a session leased
		// between the caller's scan and the run's lock acquisition.
		const enumerated = enumerateSessions(agentDir);
		const leased = join(agentDir, "sessions", encodePathForStorage(agentDir), "s-leased.jsonl");
		const lease = SessionLease.acquireTransient(leased);
		let calls = 0;
		try {
			const result = await runDream({
				agentDir,
				settings,
				ignoreGate: true,
				sessions: enumerated.sessions,
				existingIds: enumerated.existingIds,
				model: { provider: "test", modelId: "cheap" },
				promptFn: async () => {
					calls += 1;
					return { candidates: [] };
				},
				promptAgent: async (ctx) => {
					await ctx.callTool("finish_dream", {});
				},
			});
			expect(result.ran).toBe(true);
			expect(calls).toBe(1);
			expect(readDreamState(agentDir).processedSessionIds).toEqual(["s-free"]);
		} finally {
			lease.close();
		}
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
