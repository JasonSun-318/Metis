import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDreamGate, enumerateSessions, filterDreamSessionPaths } from "../src/core/memory/dream/gate.ts";
import { writeDreamState } from "../src/core/memory/dream/state.ts";
import { resolveDreamSettings } from "../src/core/memory/dream/types.ts";
import { withMemoryRootLock } from "../src/core/memory/memory-lock.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { getDreamDir, getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { SessionLease } from "../src/core/session-lease.ts";
import { encodePathForStorage } from "../src/utils/paths.ts";

describe("dream gate", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-dream-gate-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const settings = (overrides: Record<string, unknown> = {}) =>
		resolveDreamSettings({ dream: { enabled: true, minSessions: 5, minHours: 24, ...overrides } });

	function writeSession(
		agentDir: string,
		options: {
			id: string;
			cwd?: string;
			header?: Record<string, unknown>;
			metadata?: Record<string, unknown>;
			ageMs?: number;
		},
	): string {
		const cwd = options.cwd ?? agentDir;
		const dir = join(agentDir, "sessions", encodePathForStorage(cwd));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${options.id}.jsonl`);
		const header = {
			type: "session",
			version: 14,
			mode: "code",
			permissionPreset: "auto",
			id: options.id,
			timestamp: new Date(Date.now() - 86_400_000).toISOString(),
			cwd,
			...options.header,
		};
		const message = {
			type: "message",
			id: `${options.id}-m1`,
			parentId: null,
			timestamp: new Date(Date.now() - 86_400_000).toISOString(),
			message: { role: "user", content: "hello", timestamp: Date.now() - 86_400_000 },
		};
		writeFileSync(path, `${[header, message].map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
		if (options.metadata) {
			writeFileSync(
				`${path}.metadata.json`,
				`${JSON.stringify({ version: 1, sessionId: options.id, name: null, ...options.metadata })}\n`,
				{ mode: 0o600 },
			);
		}
		const mtime = new Date(Date.now() - (options.ageMs ?? 86_400_000));
		utimesSync(path, mtime, mtime);
		return path;
	}

	function seedSessions(agentDir: string, count: number): string[] {
		return Array.from({ length: count }, (_, i) => {
			writeSession(agentDir, { id: `sess-${i}` });
			return `sess-${i}`;
		});
	}

	it("fails disabled without touching the model or lock", async () => {
		const agentDir = join(makeTemp(), "agent");
		seedSessions(agentDir, 5);
		const { sessions } = enumerateSessions(agentDir);
		const gate = await checkDreamGate({
			agentDir,
			settings: settings({ enabled: false }),
			sessions,
			modelAvailable: true,
		});
		expect(gate).toEqual({ eligible: false, reason: "disabled" });
	});

	it("fails too-soon when the last run is within minHours", async () => {
		const agentDir = join(makeTemp(), "agent");
		new MemoryVault({ agentDir }).ensureLayout();
		seedSessions(agentDir, 5);
		writeDreamState(agentDir, {
			lastRunAt: new Date().toISOString(),
			lastRun: null,
			processedSessionIds: [],
		});
		const { sessions } = enumerateSessions(agentDir);
		const gate = await checkDreamGate({
			agentDir,
			settings: settings(),
			sessions,
			modelAvailable: true,
		});
		expect(gate).toEqual({ eligible: false, reason: "too-soon" });
	});

	it("fails insufficient-sessions below minSessions", async () => {
		const agentDir = join(makeTemp(), "agent");
		seedSessions(agentDir, 3);
		const { sessions } = enumerateSessions(agentDir);
		const gate = await checkDreamGate({
			agentDir,
			settings: settings(),
			sessions,
			modelAvailable: true,
		});
		expect(gate).toEqual({ eligible: false, reason: "insufficient-sessions" });
	});

	it("fails no-model when no credentialed model resolved", async () => {
		const agentDir = join(makeTemp(), "agent");
		seedSessions(agentDir, 5);
		const { sessions } = enumerateSessions(agentDir);
		const gate = await checkDreamGate({
			agentDir,
			settings: settings(),
			sessions,
			modelAvailable: false,
		});
		expect(gate).toEqual({ eligible: false, reason: "no-model" });
	});

	it("fails locked while the dream directory lock is held", async () => {
		const agentDir = join(makeTemp(), "agent");
		new MemoryVault({ agentDir }).ensureLayout();
		seedSessions(agentDir, 5);
		const { sessions } = enumerateSessions(agentDir);
		const gate = await withMemoryRootLock(getDreamDir(getVaultRoot(agentDir)), () =>
			checkDreamGate({ agentDir, settings: settings(), sessions, modelAvailable: true }),
		);
		expect(gate).toEqual({ eligible: false, reason: "locked" });
	});

	it("returns the eligible session list when every gate passes", async () => {
		const agentDir = join(makeTemp(), "agent");
		const ids = seedSessions(agentDir, 6);
		const { sessions } = enumerateSessions(agentDir);
		const gate = await checkDreamGate({
			agentDir,
			settings: settings(),
			sessions,
			modelAvailable: true,
		});
		expect(gate.eligible).toBe(true);
		if (gate.eligible) {
			expect(gate.sessions.map((session) => session.sessionId).sort()).toEqual(ids.sort());
			for (const session of gate.sessions) {
				expect(session.path.endsWith(`${session.sessionId}.jsonl`)).toBe(true);
				expect(session.cwd).toBe(agentDir);
				expect(session.updatedAt).toBeGreaterThan(0);
			}
		}
	});

	it("excludes scheduled, fresh, and already-processed sessions", async () => {
		const agentDir = join(makeTemp(), "agent");
		seedSessions(agentDir, 5);
		writeSession(agentDir, { id: "scheduled-1", header: { scheduled: { taskId: "t", runId: "r" } } });
		writeSession(agentDir, { id: "fresh-1", ageMs: 1000 });
		writeSession(agentDir, { id: "opted-out", metadata: { contributeMemory: false } });
		writeSession(agentDir, { id: "processed-1" });
		writeDreamState(agentDir, { lastRun: null, processedSessionIds: ["processed-1"] });

		const { sessions, existingIds } = enumerateSessions(agentDir);
		const ids = sessions.map((session) => session.sessionId);
		expect(ids).not.toContain("scheduled-1");
		expect(ids).not.toContain("fresh-1");
		expect(ids).not.toContain("opted-out");
		// Already-processed sessions are still enumerable; the gate subtracts them.
		expect(ids).toContain("processed-1");
		// existingIds still tracks every session file for state pruning.
		expect(existingIds.has("scheduled-1")).toBe(true);
		expect(existingIds.has("opted-out")).toBe(true);

		const gate = await checkDreamGate({
			agentDir,
			settings: settings({ minSessions: 5 }),
			sessions,
			modelAvailable: true,
		});
		expect(gate.eligible).toBe(true);
		if (gate.eligible) {
			expect(gate.sessions.map((session) => session.sessionId).sort()).toEqual(
				ids.filter((id) => id !== "processed-1").sort(),
			);
		}
	});

	it("ignoreGate skips enabled/timing/count but still requires model and lock", async () => {
		const agentDir = join(makeTemp(), "agent");
		new MemoryVault({ agentDir }).ensureLayout();
		seedSessions(agentDir, 1); // below minSessions
		writeDreamState(agentDir, {
			lastRunAt: new Date().toISOString(),
			lastRun: null,
			processedSessionIds: [],
		});
		const { sessions } = enumerateSessions(agentDir);
		const open = await checkDreamGate({
			agentDir,
			settings: settings({ enabled: false }),
			sessions,
			modelAvailable: true,
			ignoreGate: true,
		});
		expect(open.eligible).toBe(true);
		const noModel = await checkDreamGate({
			agentDir,
			settings: settings(),
			sessions,
			modelAvailable: false,
			ignoreGate: true,
		});
		expect(noModel).toEqual({ eligible: false, reason: "no-model" });
		const locked = await withMemoryRootLock(getDreamDir(getVaultRoot(agentDir)), () =>
			checkDreamGate({
				agentDir,
				settings: settings(),
				sessions,
				modelAvailable: true,
				ignoreGate: true,
			}),
		);
		expect(locked).toEqual({ eligible: false, reason: "locked" });
	});

	it("filters active and archived paths with the same eligibility rules", () => {
		const agentDir = join(makeTemp(), "agent");
		const path = writeSession(agentDir, { id: "old-archived" });
		const archiveDir = join(agentDir, "sessions", ".archive", encodePathForStorage(agentDir));
		mkdirSync(archiveDir, { recursive: true });
		const archived = join(archiveDir, "old-archived.jsonl");
		renameSync(path, archived);
		const fromPaths = filterDreamSessionPaths([archived]);
		expect(fromPaths.sessions.map((s) => s.path)).toEqual([archived]);
		expect(enumerateSessions(agentDir).sessions.map((s) => s.path)).toContain(archived);
	});

	it("excludes leased sessions from path-based filtering but keeps their ids", () => {
		const agentDir = join(makeTemp(), "agent");
		const path = writeSession(agentDir, { id: "leased" });
		const lease = SessionLease.acquireTransient(path);
		try {
			const filtered = filterDreamSessionPaths([path]);
			expect(filtered.sessions).toEqual([]);
			expect(filtered.existingIds.has("leased")).toBe(true);
		} finally {
			lease.close();
		}
	});
});
