import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var), but the
	// spawned CLI sees the physical path via process.cwd(). Session cwd
	// filtering compares paths textually, so the fixture must use physical paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "metis-session-id-readonly-")));
	tempDirs.push(dir);
	return dir;
}

function hasSessionWithId(root: string, sessionId: string): boolean {
	if (!existsSync(root)) return false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && hasSessionWithId(path, sessionId)) return true;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

		try {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return true;
		} catch {
			// Ignore malformed session files.
		}
	}
	return false;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; agentDir: string; stderr: string; stdout: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	let stderr = "";
	let stdout = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...resolvedArgs], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				METIS_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, agentDir: dirs.agentDir, stderr, stdout };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

function writeScheduledSession(sessionDir: string, cwd: string, id: string): void {
	const timestamp = new Date().toISOString();
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${[
			{
				type: "session",
				version: 11,
				id,
				timestamp,
				cwd,
				mode: "chat",
				cwdOrigin: "user-selected",
				permissionPreset: "ask",
				scheduled: { taskId: "scheduled-task", runId: "scheduled-run" },
			},
			{
				type: "message",
				id: "user-message",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Generate the daily report", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "assistant-message",
				parentId: "user-message",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "The daily report is ready" }],
					api: "openai-completions",
					provider: "openai",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
}

describe("--session-id read-only commands", () => {
	it("prints a scheduled execution instead of opening it for mutation", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--session-id", "scheduled-session"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeScheduledSession(dirs.sessionDir, dirs.projectDir, "scheduled-session");
			},
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Generate the daily report");
		expect(result.stdout).toContain("The daily report is ready");
		expect(result.stderr).not.toContain("Scheduled sessions are read-only");
	});

	it("prints a scheduled execution selected by file path", async () => {
		const result = await runCli(
			(dirs) => ["--session", join(dirs.sessionDir, "scheduled-session.jsonl")],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeScheduledSession(dirs.sessionDir, dirs.projectDir, "scheduled-session");
			},
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Generate the daily report");
		expect(result.stdout).toContain("The daily report is ready");
	});

	it("rejects new messages for a scheduled execution", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--session-id", "scheduled-session", "-p", "run again"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeScheduledSession(dirs.sessionDir, dirs.projectDir, "scheduled-session");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Scheduled execution sessions are read-only and cannot accept new messages");
		expect(result.stdout).not.toContain("The daily report is ready");
	});

	it("does not reserve a session for --help", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-help")).toBe(false);
	});

	it("allows --no-session with --session-id", async () => {
		const result = await runCli(["--no-session", "--session-id", "ephemeral-id", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "ephemeral-id")).toBe(false);
	});

	it("does not reserve a session for --list-models", async () => {
		const result = await runCli(["--session-id", "read-only-models", "--list-models"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-models")).toBe(false);
	});

	it("warns when a missing --session-id creates a new session", async () => {
		const result = await runCli((dirs) => [
			"--session-dir",
			dirs.sessionDir,
			"--session-id",
			"missing-session-id",
			"--model",
			"missing-model",
			"-p",
			"hi",
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"Warning: No project session found with id 'missing-session-id'; creating a new session with that id.",
		);
	});

	it("does not warn when --session-id opens an existing session", async () => {
		const result = await runCli(
			(dirs) => [
				"--session-dir",
				dirs.sessionDir,
				"--session-id",
				"existing-session-id",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-session-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No project session found with id 'existing-session-id'");
	});

	it("rejects an existing fork target session id", async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--fork", "source-id", "--session-id", "existing-id", "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "source-id");
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session already exists with id 'existing-id'");
	});
});

describe("--session-id validation", () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});
