import { existsSync, mkdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { getDefaultSessionDir, getVaultRoot, SessionManager, SettingsManager } from "@metis/coding-agent/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DreamDepsFactory, MemoryService } from "../src/memory-settings.ts";
import { SessionCatalog } from "../src/session-catalog.ts";
import { SessionSubscriptions } from "../src/subscriptions.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const EPOCH = "33333333-3333-4333-8333-333333333333";

describe("MemoryService", () => {
	let agentDir: string;
	let sessionsRoot: string;
	let projectDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-memory-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sessionsRoot = join(agentDir, "sessions");
		projectDir = join(agentDir, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	function service(extra: { dreamDeps?: DreamDepsFactory } = {}) {
		const subscriptions = new SessionSubscriptions(EPOCH);
		const published = vi.spyOn(subscriptions, "publishConnectionEvent");
		const catalog = new SessionCatalog({ agentDir, sessionsRoot });
		return {
			catalog,
			published,
			service: new MemoryService({
				agentDir,
				settingsManager: SettingsManager.create(agentDir, agentDir),
				catalog,
				subscriptions,
				...(extra.dreamDeps ? { dreamDeps: extra.dreamDeps } : {}),
			}),
		};
	}

	/** An idle (>2h), unleased session file that dream enumeration picks up. */
	function writeIdleSession(id: string): void {
		// Session files must live under sessions/<encoded-cwd>/ for enumerateSessions to see them.
		const manager = SessionManager.create(projectDir, getDefaultSessionDir(projectDir, agentDir), {
			id,
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		// Phase 1 skips sessions whose serialized transcript is empty.
		manager.appendMessage({
			role: "user",
			content: "remember that this project uses pnpm only",
			timestamp: Date.now(),
		});
		const file = manager.getSessionFile();
		manager.close();
		if (!file) throw new Error("session file missing");
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(file, old, old);
	}

	async function withSession(cwdOrigin: "user-selected" | "managed" = "user-selected") {
		const ctx = service();
		SessionManager.create(projectDir, sessionsRoot, { id: SESSION_ID, mode: "chat", cwdOrigin }).close();
		await ctx.catalog.refresh();
		return ctx;
	}

	it("returns the vault view with defaults", async () => {
		const { service: svc } = service();
		expect(await svc.view({})).toEqual({
			enabled: true,
			dream: {
				enabled: true,
				minHours: 24,
				minSessions: 5,
				maxUnusedDays: 90,
				modelAvailable: false,
				nextEligible: false,
			},
			activeContext: false,
			vault: { globalDir: join(getVaultRoot(agentDir), "global") },
		});
	});

	it("exposes the session's project vault paths", async () => {
		const { service: svc } = await withSession();
		const view = await svc.view({ sessionId: SESSION_ID });
		expect(view.vault.projectRoot).toBe(realpathSync(projectDir));
		expect(view.vault.projectDir).toMatch(/^.*\/memory\/projects\/[a-f0-9]{64}$/u);
	});

	it("has no project scope for managed workspaces", async () => {
		const { service: svc } = await withSession("managed");
		expect((await svc.view({ sessionId: SESSION_ID })).vault.projectDir).toBeUndefined();
	});

	it("exposes the session's persisted memory flags", async () => {
		const ctx = service();
		const manager = SessionManager.create(projectDir, sessionsRoot, {
			id: SESSION_ID,
			mode: "chat",
			cwdOrigin: "user-selected",
			contributeMemory: false,
		});
		manager.close();
		await ctx.catalog.refresh();
		const view = await ctx.service.view({ sessionId: SESSION_ID });
		expect(view.session).toEqual({ useMemory: true, contributeMemory: false });
	});

	it("persists enabled, activeContext, and dream settings", async () => {
		const { service: svc } = service();
		const updated = await svc.update({
			enabled: false,
			activeContext: true,
			dream: { enabled: false, minHours: 12, model: { provider: "openai", modelId: "gpt-test" } },
		});
		expect(updated.enabled).toBe(false);
		expect(updated.activeContext).toBe(true);
		expect(updated.dream.enabled).toBe(false);
		expect(updated.dream.minHours).toBe(12);
		expect(updated.dream.model).toEqual({ provider: "openai", modelId: "gpt-test" });

		const cleared = await svc.update({ dream: { model: null } });
		expect(cleared.dream.model).toBeUndefined();
	});

	it("writes, lists, and reads notes with actor=user", async () => {
		const { service: svc } = service();
		const write = await svc.writeNote({
			op: "create",
			scope: "global",
			target: { slug: "editor-preference" },
			frontmatter: { name: "Editor preference", description: "Uses vim", type: "user" },
			content: "Uses vim keybindings.",
		});
		expect(write).toEqual({ ok: true, changeId: expect.any(String), target: { slug: "editor-preference" } });

		const listed = svc.listNotes({});
		expect(listed.notes.map((note) => note.slug)).toEqual(["editor-preference"]);

		const read = svc.readNote({ scope: "global", slug: "editor-preference" });
		expect(read.note.body).toBe("Uses vim keybindings.");
		expect(read.note.sources).toContain("user");
	});

	it("rejects project-scope writes without a project context", async () => {
		const { service: svc } = service();
		await expect(
			svc.writeNote({
				op: "create",
				scope: "project",
				target: { slug: "note" },
				frontmatter: { name: "n", description: "d", type: "project" },
				content: "x",
			}),
		).rejects.toThrow();
	});

	it("records history, undoes a project change without a session, and broadcasts events", async () => {
		const { service: svc, published } = await withSession();
		const write = await svc.writeNote({
			sessionId: SESSION_ID,
			op: "create",
			scope: "project",
			target: { slug: "deploy-freeze" },
			frontmatter: { name: "Deploy freeze", description: "No deploys on Fridays", type: "decision" },
			content: "No deploys on Fridays.",
		});
		expect(write.ok).toBe(true);
		expect(published).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "memory/changed",
				entry: expect.objectContaining({ op: "create", scope: "project", actor: { kind: "user" } }),
			}),
		);
		// The snapshot path must never appear on the wire.
		expect(JSON.stringify(published.mock.calls[0]![0])).not.toContain("snapshot");

		const history = svc.history({});
		expect(history.entries[0]).toMatchObject({ op: "create", scope: "project" });
		expect(history.entries[0]).not.toHaveProperty("snapshot");

		const undone = await svc.undo({ changeId: write.changeId! });
		expect(undone).toEqual({ ok: true });
		expect(svc.listNotes({ sessionId: SESSION_ID, scope: "project" }).notes).toEqual([]);
	});

	it("fails reading a missing note", () => {
		const { service: svc } = service();
		expect(() => svc.readNote({ scope: "global", slug: "missing" })).toThrow();
	});

	it("reads a history entry as a snapshot-to-current patch without leaking snapshot paths", async () => {
		const { service: svc } = await withSession();
		await svc.writeNote({
			sessionId: SESSION_ID,
			op: "create",
			scope: "project",
			target: { slug: "deploy-freeze" },
			frontmatter: { name: "Deploy freeze", description: "No deploys on Fridays", type: "decision" },
			content: "No deploys on Fridays.",
		});
		const replaced = await svc.writeNote({
			sessionId: SESSION_ID,
			op: "replace",
			scope: "project",
			target: { slug: "deploy-freeze" },
			content: "No deploys on Fridays or Mondays.",
		});
		expect(replaced.ok).toBe(true);

		const detail = svc.historyRead({ changeId: replaced.changeId! });
		expect(detail.entry).toMatchObject({ id: replaced.changeId, op: "replace", scope: "project" });
		expect(JSON.stringify(detail)).not.toContain("snapshot");
		expect(detail.patch).toContain("-No deploys on Fridays.");
		expect(detail.patch).toContain("+No deploys on Fridays or Mondays.");

		// Undone entries whose snapshot no longer matches still surface their own record.
		const undone = await svc.undo({ changeId: replaced.changeId! });
		expect(undone).toEqual({ ok: true });
		const afterUndo = svc.historyRead({ changeId: replaced.changeId! });
		expect(afterUndo.entry.id).toBe(replaced.changeId);

		expect(() => svc.historyRead({ changeId: "44444444-4444-4444-8444-444444444444" })).toThrow();
	});

	it("produces protocol-valid responses for every memory method", async () => {
		const { service: svc } = await withSession();
		const check = async (method: string, params: Record<string, unknown>, result: unknown) => {
			const request = { jsonrpc: "2.0" as const, id: `memory-${method}`, method, params };
			expect(() => validateResponseFor("client", request, { jsonrpc: "2.0", id: request.id, result })).not.toThrow();
		};
		await check("memory/get", { sessionId: SESSION_ID }, await svc.view({ sessionId: SESSION_ID }));
		await check(
			"memory/update",
			{ enabled: true, activeContext: false },
			await svc.update({ enabled: true, activeContext: false }),
		);
		await check("memory/notes/list", {}, svc.listNotes({}));
		const writeParams = {
			op: "create" as const,
			scope: "global" as const,
			target: { slug: "wire-check" },
			frontmatter: { name: "Wire", description: "Wire check", type: "reference" as const },
			content: "content",
		};
		const write = await svc.writeNote(writeParams);
		await check("memory/notes/write", writeParams, write);
		await check(
			"memory/notes/read",
			{ scope: "global", slug: "wire-check" },
			svc.readNote({ scope: "global", slug: "wire-check" }),
		);
		await check("memory/history/list", { limit: 10 }, svc.history({ limit: 10 }));
		await check("memory/undo", { changeId: write.changeId! }, await svc.undo({ changeId: write.changeId! }));
		await check("memory/dream/run", {}, await svc.dreamRun({}));
	});

	it("reports no-model when no dream deps resolve", async () => {
		const { service: svc } = service();
		expect(await svc.dreamRun({})).toEqual({ ok: false, error: "No credentialed model is available" });
		expect((await svc.view({})).dream.modelAvailable).toBe(false);
	});

	it("runs a dream end-to-end with injected deps and publishes dreamCompleted", async () => {
		writeIdleSession(SESSION_ID);
		const { service: svc, published } = service({
			dreamDeps: () => ({
				model: { provider: "test", modelId: "cheap" },
				promptFn: async () => ({
					candidates: [{ type: "reference", scope: "global", slug: "uses-pnpm", text: "User wants pnpm only." }],
				}),
				promptAgent: async (ctx) => {
					await ctx.callTool("memory_write", {
						op: "create",
						scope: "global",
						target: { slug: "uses-pnpm" },
						frontmatter: { type: "reference", description: "pnpm only" },
						content: "use pnpm",
					});
					await ctx.callTool("finish_dream", {});
				},
			}),
		});

		const result = await svc.dreamRun({});
		expect(result).toEqual({ ok: true, runId: expect.any(String) });
		if (!result.ok || result.runId === undefined) return;
		const runId = result.runId;
		expect(published).toHaveBeenCalledWith(
			expect.objectContaining({ type: "memory/dreamCompleted", runId, added: 1 }),
		);

		const view = await svc.view({});
		expect(view.dream.modelAvailable).toBe(true);
		expect(view.dream.lastRun?.runId).toBe(runId);
		expect(view.dream.lastRun?.added).toBe(1);
		expect(view.dream.lastRunAt).toBe(view.dream.lastRun?.at);

		// The run's writes roll back through the existing undoRun surface.
		const undone = await svc.undoRun({ runId });
		expect(undone.undone.length).toBeGreaterThan(0);
		expect(undone.skipped).toEqual([]);
		expect(svc.listNotes({}).notes).toEqual([]);
	});
});
