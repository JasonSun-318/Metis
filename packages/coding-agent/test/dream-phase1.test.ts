import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type DreamPromptRequest,
	PROPOSE_MEMORIES_TOOL,
	parseDreamCandidates,
	runDreamPhase1,
} from "../src/core/memory/dream/phase1.ts";
import type { DreamCandidate, EligibleSession } from "../src/core/memory/dream/types.ts";
import { encodePathForStorage } from "../src/utils/paths.ts";

describe("dream phase 1", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-dream-p1-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(agentDir: string, id: string, userText: string, cwd = agentDir): string {
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
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: userText, timestamp: 1000 },
			},
		];
		writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
		return path;
	}

	function eligible(agentDir: string, id: string, cwd = agentDir): EligibleSession {
		return { path: writeSession(agentDir, id, `session ${id} content`, cwd), sessionId: id, cwd, updatedAt: 1 };
	}

	it("does not consume an unreadable transcript but still accepts a valid empty transcript", async () => {
		const agentDir = join(makeTemp(), "agent");
		const missing = eligible(agentDir, "missing");
		rmSync(missing.path);
		const empty = eligible(agentDir, "empty");
		writeSession(agentDir, "empty", "");
		let promptCalls = 0;
		const result = await runDreamPhase1({
			sessions: [missing, empty],
			stagingDir: join(makeTemp(), "staging"),
			promptFn: async () => {
				promptCalls++;
				return { candidates: [] };
			},
		});
		expect(result.processed).toEqual(["empty"]);
		expect(result.sessions[0]).toMatchObject({ sessionId: "missing", processed: false, error: expect.any(String) });
		expect(promptCalls).toBe(0);
	});

	it("stages candidates returned by the prompt function", async () => {
		const agentDir = join(makeTemp(), "agent");
		const stagingDir = join(makeTemp(), "staging");
		const session = eligible(agentDir, "s1");
		const requests: DreamPromptRequest[] = [];
		const result = await runDreamPhase1({
			sessions: [session],
			stagingDir,
			promptFn: async (request) => {
				requests.push(request);
				return {
					candidates: [{ type: "preference", scope: "global", slug: "pnpm-only", text: "User prefers pnpm." }],
				};
			},
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.tool.name).toBe(PROPOSE_MEMORIES_TOOL.name);
		expect(requests[0]!.toolChoice).toBe("required");
		expect(requests[0]!.user).toContain("session s1 content");
		expect(result.processed).toEqual(["s1"]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({ sessionId: "s1", scope: "global", slug: "pnpm-only" });

		const staged = join(stagingDir, "s1.jsonl");
		expect(existsSync(staged)).toBe(true);
		const lines = readFileSync(staged, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("User prefers pnpm.");
	});

	it("marks a session processed when the model proposes nothing", async () => {
		const agentDir = join(makeTemp(), "agent");
		const stagingDir = join(makeTemp(), "staging");
		const session = eligible(agentDir, "s-empty");
		const result = await runDreamPhase1({
			sessions: [session],
			stagingDir,
			promptFn: async () => ({ candidates: [] }),
		});
		expect(result.processed).toEqual(["s-empty"]);
		expect(result.candidates).toEqual([]);
		expect(existsSync(join(stagingDir, "s-empty.jsonl"))).toBe(false);
	});

	it("does not mark a session processed when the prompt call throws", async () => {
		const agentDir = join(makeTemp(), "agent");
		const stagingDir = join(makeTemp(), "staging");
		const session = eligible(agentDir, "s-fail");
		const result = await runDreamPhase1({
			sessions: [session],
			stagingDir,
			promptFn: async () => {
				throw new Error("model exploded");
			},
		});
		expect(result.processed).toEqual([]);
		expect(result.sessions[0]).toMatchObject({ sessionId: "s-fail", processed: false });
		expect(result.sessions[0]!.error).toContain("model exploded");
	});

	it("resolves project scope only when the session cwd has a project", () => {
		const cwd = makeTemp();
		const session: EligibleSession = { path: "", sessionId: "s2", cwd, updatedAt: 1 };
		const project = parseDreamCandidates(
			{ candidates: [{ scope: "project", text: "Repo uses biome." }] },
			session,
			false,
		);
		expect(project[0]!.scope).toBe("project");
		expect(project[0]!.project?.root).toBe(realpathSync(cwd));

		const managed = parseDreamCandidates(
			{ candidates: [{ scope: "project", text: "Repo uses biome." }] },
			{ ...session, cwdOrigin: "managed" },
			false,
		);
		expect(managed[0]!.scope).toBe("global");
		expect(managed[0]!.project).toBeUndefined();
	});

	it("drops malformed candidates and propagates pollution", () => {
		const session: EligibleSession = { path: "", sessionId: "s3", cwd: makeTemp(), updatedAt: 1 };
		const candidates = parseDreamCandidates(
			{
				candidates: [
					{ text: "  " },
					{ nope: true },
					{ text: "AWS_SECRET_KEY=abc123def456 is configured" },
					{ text: "safe text", evidence: "api_key = sk-leakme" },
					{ text: "kept", type: "not-a-type", slug: "Bad Slug!!" },
					{ text: "kept too", type: "decision", slug: "good-slug" },
				],
			},
			session,
			true,
		);
		expect(candidates).toHaveLength(2);
		expect(candidates[0]!.type).toBeUndefined();
		expect(candidates[0]!.slug).toBe("bad-slug-");
		expect(candidates[0]!.polluted).toBe(true);
		expect(candidates[1]!.type).toBe("decision");
	});

	it("processes sessions concurrently and keeps all results", async () => {
		const agentDir = join(makeTemp(), "agent");
		const stagingDir = join(makeTemp(), "staging");
		const sessions = Array.from({ length: 4 }, (_, i) => eligible(agentDir, `batch-${i}`));
		let inFlight = 0;
		let maxInFlight = 0;
		const result = await runDreamPhase1({
			sessions,
			stagingDir,
			concurrency: 4,
			promptFn: async (request) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight -= 1;
				const id = /batch-\d/.exec(request.user)![0];
				return { candidates: [{ text: `fact from ${id}` }] };
			},
		});
		expect(result.processed.sort()).toEqual(sessions.map((s) => s.sessionId).sort());
		expect(result.candidates).toHaveLength(4);
		expect(maxInFlight).toBeGreaterThan(1);
		const staged = new Set(result.candidates.map((candidate: DreamCandidate) => candidate.sessionId));
		expect(staged.size).toBe(4);
	});

	it("clamps the concurrency override to the hard cap", async () => {
		const agentDir = join(makeTemp(), "agent");
		const stagingDir = join(makeTemp(), "staging");
		const sessions = Array.from({ length: 8 }, (_, i) => eligible(agentDir, `s${i}`));
		let active = 0;
		let maxActive = 0;
		await runDreamPhase1({
			sessions,
			stagingDir,
			concurrency: 99,
			promptFn: async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active -= 1;
				return { candidates: [] };
			},
		});
		expect(maxActive).toBeLessThanOrEqual(4);
	});
});
