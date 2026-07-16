import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dispose: undefined as ReturnType<typeof vi.fn> | undefined,
	failSessionCreation: true,
}));

vi.mock("../src/core/agent-session-services.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
	return {
		...actual,
		createAgentSessionServices: async (options: Parameters<typeof actual.createAgentSessionServices>[0]) => {
			const services = await actual.createAgentSessionServices(options);
			const originalDispose = services.resourceLoader.dispose?.bind(services.resourceLoader);
			const dispose = vi.fn(() => originalDispose?.());
			state.dispose = dispose;
			services.resourceLoader.dispose = dispose;
			return services;
		},
		createAgentSessionFromServices: async (options: Parameters<typeof actual.createAgentSessionFromServices>[0]) => {
			if (state.failSessionCreation) throw new Error("session creation failed");
			return actual.createAgentSessionFromServices(options);
		},
	};
});

import { ENV_AGENT_DIR } from "../src/config.ts";
import { restoreStdout } from "../src/core/output-guard.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { main } from "../src/main.ts";

describe("main runtime resource ownership", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;
	let previousOffline: string | undefined;

	beforeEach(() => {
		agentDir = join(tmpdir(), `arcmind-main-resource-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env[ENV_AGENT_DIR];
		previousOffline = process.env.ARCMIND_OFFLINE;
		process.env[ENV_AGENT_DIR] = agentDir;
		state.dispose = undefined;
		state.failSessionCreation = true;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdout();
		if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousAgentDir;
		if (previousOffline === undefined) delete process.env.ARCMIND_OFFLINE;
		else process.env.ARCMIND_OFFLINE = previousOffline;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("disposes successfully created services when session creation fails", async () => {
		await expect(
			main([
				"--offline",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--print",
				"hello",
			]),
		).rejects.toThrow("session creation failed");
		expect(state.dispose).toHaveBeenCalledOnce();
	});

	it("disposes the runtime before a help exit", async () => {
		state.failSessionCreation = false;
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit:${code}`);
		});

		await expect(
			main([
				"--offline",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--help",
			]),
		).rejects.toThrow("process.exit:0");
		expect(state.dispose).toHaveBeenCalledOnce();
	});

	it("releases the session lease before an early argument exit", async () => {
		const sessionDir = join(agentDir, "sessions");
		vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit:${code}`);
		});

		await expect(
			main([
				"--offline",
				"--session-dir",
				sessionDir,
				"--name",
				" ",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			]),
		).rejects.toThrow("process.exit:1");

		const sessionFile = readdirSync(sessionDir).find((file) => file.endsWith(".jsonl"));
		expect(sessionFile).toBeTruthy();
		const reopened = SessionManager.open(join(sessionDir, sessionFile!));
		reopened.close();
	});

	it("releases the session lease when startup fails before runtime adoption", async () => {
		const sessionDir = join(agentDir, "sessions");
		vi.spyOn(SessionManager.prototype, "appendSessionInfo").mockImplementation(() => {
			throw new Error("session metadata failed");
		});

		await expect(
			main([
				"--offline",
				"--session-dir",
				sessionDir,
				"--name",
				"valid",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
			]),
		).rejects.toThrow("session metadata failed");

		const sessionFile = readdirSync(sessionDir).find((file) => file.endsWith(".jsonl"));
		expect(sessionFile).toBeTruthy();
		const reopened = SessionManager.open(join(sessionDir, sessionFile!));
		reopened.close();
	});
});
