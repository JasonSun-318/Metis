import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@metis/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDreamToolset, DREAM_MAX_WRITES, runDreamPhase2 } from "../src/core/memory/dream/phase2.ts";
import type { DreamCandidate } from "../src/core/memory/dream/types.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { readChangelog } from "../src/core/memory/vault-history.ts";
import { getNotesDir, getPinnedPath, getScopeDir, getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { undoMemoryRun } from "../src/core/memory/vault-run-undo.ts";
import { readUsage, recordUsage } from "../src/core/memory/vault-usage.ts";
import { putNote, withMemoryFixture } from "./helpers/memory-vault-fixture.ts";

const RUN_ID = "run-test-1";

describe("dream phase 2", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-dream-p2-"));
		tempDirs.push(dir);
		return dir;
	};

	const ctxToolResults: AgentToolResult<unknown>[] = [];

	afterEach(() => {
		ctxToolResults.splice(0);
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function dreamRun(agentDir: string, candidates: DreamCandidate[], script: string[]) {
		return runDreamPhase2({
			agentDir,
			runId: RUN_ID,
			candidates,
			promptAgent: async (ctx) => {
				for (const line of script) {
					const { name, args } = JSON.parse(line) as { name: string; args: unknown };
					const result = await ctx.callTool(name, args);
					ctxToolResults.push(result);
				}
			},
		});
	}

	const call = (name: string, args: unknown) => JSON.stringify({ name, args });

	it("creates, edits pinned, and deletes notes with the run's dream actor", async () => {
		const agentDir = join(makeTemp(), "agent");
		const vault = new MemoryVault({ agentDir });
		vault.ensureLayout();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "stale-note" },
				frontmatter: { type: "reference", description: "old" },
				content: "old content",
			},
			{ kind: "user" },
		);

		const result = await dreamRun(
			agentDir,
			[],
			[
				call("memory_write", {
					op: "create",
					scope: "global",
					target: { slug: "pnpm-only" },
					frontmatter: { type: "feedback", description: "only pnpm" },
					content: "**Why:** lockfile\n**How to apply:** use pnpm",
				}),
				call("memory_write", {
					op: "append",
					scope: "global",
					target: { block: "user" },
					content: "Prefers pnpm.",
				}),
				call("memory_write", { op: "delete", scope: "global", target: { slug: "stale-note" } }),
				call("finish_dream", {}),
			],
		);
		expect(result.finished).toBe(true);
		expect(result.writes).toBe(3);

		const global = join(getNotesDir(getScopeDir(getVaultRoot(agentDir), "global")), "pnpm-only.md");
		expect(readFileSync(global, "utf8")).toContain("pnpm");
		expect(vault.readPinned("global", "user")).toContain("Prefers pnpm.");

		const entries = readChangelog(getVaultRoot(agentDir)).filter((entry) => entry.actor.kind === "dream");
		expect(entries.length).toBeGreaterThanOrEqual(3);
		for (const entry of entries) {
			expect(entry.actor).toEqual({ kind: "dream", runId: RUN_ID });
		}
		expect(entries.some((entry) => entry.op === "create")).toBe(true);
		expect(entries.some((entry) => entry.op === "delete")).toBe(true);
	});

	it("refuses writes beyond the per-run budget", async () => {
		const agentDir = join(makeTemp(), "agent");
		new MemoryVault({ agentDir }).ensureLayout();
		const toolset = createDreamToolset({ agentDir, actor: { kind: "dream", runId: RUN_ID } });
		for (let i = 0; i < DREAM_MAX_WRITES; i++) {
			const result = await toolset.call("memory_write", {
				op: "create",
				scope: "global",
				target: { slug: `note-${i}` },
				frontmatter: { type: "reference", description: `n${i}` },
				content: "x",
			});
			expect((result.details as { ok: boolean }).ok).toBe(true);
		}
		const over = await toolset.call("memory_write", {
			op: "create",
			scope: "global",
			target: { slug: "note-over" },
			frontmatter: { type: "reference", description: "n" },
			content: "x",
		});
		expect((over.details as { ok: boolean }).ok).toBe(false);
		const overText = over.content[0]!;
		expect(overText.type === "text" && overText.text).toContain("finish_dream");
		expect(toolset.writes).toBe(DREAM_MAX_WRITES);
	});

	it("clamps maxWrites overrides to the hard cap", async () => {
		const agentDir = join(makeTemp(), "agent");
		new MemoryVault({ agentDir }).ensureLayout();
		let batch = 0;
		const attempt51 = async (maxWrites: number) => {
			const tag = `b${batch++}`;
			const toolset = createDreamToolset({ agentDir, actor: { kind: "dream", runId: RUN_ID }, maxWrites });
			let succeeded = 0;
			for (let i = 0; i < DREAM_MAX_WRITES + 1; i++) {
				const result = await toolset.call("memory_write", {
					op: "create",
					scope: "global",
					target: { slug: `note-${tag}-${i}` },
					frontmatter: { type: "reference", description: `n${i}` },
					content: "x",
				});
				if ((result.details as { ok: boolean }).ok) succeeded += 1;
			}
			expect(succeeded).toBe(DREAM_MAX_WRITES);
			expect(toolset.writes).toBe(DREAM_MAX_WRITES);
		};
		await attempt51(99);
		await attempt51(Number.NaN);
		await attempt51(Number.POSITIVE_INFINITY);
	});

	it("memory_search never records usage", async () => {
		const agentDir = join(makeTemp(), "agent");
		const vault = new MemoryVault({ agentDir });
		vault.ensureLayout();
		await vault.write(
			{
				op: "create",
				scope: "global",
				target: { slug: "pnpm-only" },
				frontmatter: { type: "feedback", description: "only pnpm" },
				content: "use pnpm",
			},
			{ kind: "user" },
		);
		const toolset = createDreamToolset({ agentDir, actor: { kind: "dream", runId: RUN_ID } });
		// Seed an unrelated usage row; a search that recorded usage would grow the map.
		await recordUsage(getVaultRoot(agentDir), ["global/notes/other"]);
		const before = readUsage(getVaultRoot(agentDir));
		const result = await toolset.call("memory_search", { query: "pnpm" });
		expect((result.details as { ok: boolean }).ok).toBe(true);
		// Usage writes are fire-and-forget; give any stray write a chance to land.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(readUsage(getVaultRoot(agentDir))).toEqual(before);
	});

	it("routes project scope to the candidate's project vault", async () => {
		const agentDir = join(makeTemp(), "agent");
		const projectRoot = makeTemp();
		const candidate: DreamCandidate = {
			sessionId: "s1",
			scope: "project",
			text: "Repo convention",
			polluted: false,
			project: { root: projectRoot, projectKey: "abc123", source: "cwd" },
		};
		const result = await dreamRun(
			agentDir,
			[candidate],
			[
				call("memory_write", {
					op: "create",
					scope: "project",
					project: projectRoot,
					target: { slug: "convention" },
					frontmatter: { type: "project", description: "conv" },
					content: "use tabs",
				}),
				call("finish_dream", {}),
			],
		);
		expect(result.finished).toBe(true);
		const notePath = join(getNotesDir(getScopeDir(getVaultRoot(agentDir), "project", "abc123")), "convention.md");
		expect(readFileSync(notePath, "utf8")).toContain("use tabs");
	});

	it("keeps same-slug results from two projects distinct", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			await putNote(a, "project", "shared", "needle alpha");
			await putNote(b, "project", "shared", "needle beta");
			const tools = createDreamToolset({
				agentDir: f.agentDir,
				actor: { kind: "dream", runId: RUN_ID },
				projects: [f.project("a"), f.project("b")],
			});
			const result = await tools.call("memory_search", { query: "needle", scope: "all" });
			const hits = (result.details as { hits: Array<{ projectKey?: string }> }).hits;
			expect(new Set(hits.map((hit) => hit.projectKey))).toEqual(
				new Set([f.project("a").projectKey, f.project("b").projectKey]),
			);
			const read = await tools.call("memory_read", {
				slug: "shared",
				scope: "project",
				project: f.project("b").projectKey,
			});
			expect((read.details as { body: string }).body).toContain("beta");
			expect(readUsage(a.root)).toEqual({});
		});
	});

	it("reports ambiguity when a slug exists in multiple projects without a project ref", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			await putNote(a, "project", "shared", "alpha body");
			await putNote(b, "project", "shared", "beta body");
			const tools = createDreamToolset({
				agentDir: f.agentDir,
				actor: { kind: "dream", runId: RUN_ID },
				projects: [f.project("a"), f.project("b")],
			});
			const read = await tools.call("memory_read", { slug: "shared" });
			expect((read.details as { ok: boolean }).ok).toBe(false);
			const errText = read.content[0]!;
			expect(errText.type === "text" && errText.text).toContain("ambiguous");
		});
	});

	it("exposes stale notes for maintenance with empty candidates", async () => {
		await withMemoryFixture(async (f) => {
			const v = f.vault();
			await putNote(v, "global", "stale-note", "stale body");
			const run = await runDreamPhase2({
				agentDir: f.agentDir,
				runId: "maint",
				candidates: [],
				promptAgent: async (ctx) => {
					expect(ctx.user).toContain("stale-note");
					await ctx.callTool("memory_write", { op: "delete", scope: "global", target: { slug: "stale-note" } });
					await ctx.callTool("finish_dream", {});
				},
			});
			expect(run.finished).toBe(true);
			expect(v.readNote("global", "stale-note")).toBeUndefined();
			const undo = await undoMemoryRun({ agentDir: f.agentDir, runId: "maint", actor: { kind: "user" } });
			expect(undo.skipped).toEqual([]);
			expect(v.readNote("global", "stale-note")?.body).toBe("stale body");
		});
	});

	it("errors when project scope has no resolvable project", async () => {
		const agentDir = join(makeTemp(), "agent");
		const toolset = createDreamToolset({ agentDir, actor: { kind: "dream", runId: RUN_ID } });
		const result = await toolset.call("memory_write", {
			op: "create",
			scope: "project",
			target: { slug: "x" },
			frontmatter: { type: "project", description: "x" },
			content: "x",
		});
		expect((result.details as { ok: boolean }).ok).toBe(false);
		const errText = result.content[0]!;
		expect(errText.type === "text" && errText.text).toContain("project");
	});

	it("keeps the active block out of prompts and writes when disabled", async () => {
		await withMemoryFixture(async (f) => {
			const projectVault = f.vault("a");
			writeFileSync(
				getPinnedPath(getScopeDir(getVaultRoot(f.agentDir), "project", projectVault.project!.projectKey), "active"),
				"active-private-marker",
				{ mode: 0o600 },
			);
			let captured: { system?: string; user?: string } = {};
			const run = async (enabled: () => boolean) =>
				runDreamPhase2({
					agentDir: f.agentDir,
					runId: `active-${String(enabled())}`,
					candidates: [],
					projects: [projectVault.project!],
					activeContextEnabled: enabled,
					promptAgent: async (ctx) => {
						captured = { system: ctx.system, user: ctx.user };
						const writeResult = await ctx.callTool("memory_write", {
							op: "replace",
							scope: "project",
							project: projectVault.project!.root,
							target: { block: "active" },
							content: "stage summary",
						});
						ctxToolResults.push(writeResult);
						await ctx.callTool("finish_dream", {});
					},
				});

			const off = await run(() => false);
			expect(off.finished).toBe(true);
			expect(captured.system!).not.toContain('"block":"active"');
			expect(captured.user!).not.toContain("active-private-marker");
			const rejected = ctxToolResults.pop()!;
			expect((rejected.details as { ok: boolean }).ok).toBe(false);
			expect(
				readFileSync(
					getPinnedPath(
						getScopeDir(getVaultRoot(f.agentDir), "project", projectVault.project!.projectKey),
						"active",
					),
					"utf8",
				),
			).toBe("active-private-marker");

			await run(() => true);
			expect(captured.system!).toContain('"block":"active"');
			expect(captured.user!).toContain("active-private-marker");
			const accepted = ctxToolResults.pop()!;
			expect((accepted.details as { ok: boolean }).ok).toBe(true);
			expect(
				readFileSync(
					getPinnedPath(
						getScopeDir(getVaultRoot(f.agentDir), "project", projectVault.project!.projectKey),
						"active",
					),
					"utf8",
				).trim(),
			).toBe("stage summary");
			const undo = await undoMemoryRun({ agentDir: f.agentDir, runId: "active-true", actor: { kind: "user" } });
			expect(undo.skipped).toEqual([]);
			expect(
				readFileSync(
					getPinnedPath(
						getScopeDir(getVaultRoot(f.agentDir), "project", projectVault.project!.projectKey),
						"active",
					),
					"utf8",
				),
			).toBe("active-private-marker");

			// A disabled re-run must not re-inject the retained file into prompts.
			await run(() => false);
			expect(captured.user!).not.toContain("active-private-marker");
			expect(
				readFileSync(
					getPinnedPath(
						getScopeDir(getVaultRoot(f.agentDir), "project", projectVault.project!.projectKey),
						"active",
					),
					"utf8",
				),
			).toBe("active-private-marker");
		});
	});
});
