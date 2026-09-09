import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type DeclarativeHook, saveDeclarativeHooks } from "../src/core/hooks/declarative-hooks.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("async hook admission race condition", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			const cleanup = cleanups.pop();
			if (cleanup) await cleanup();
		}
	});

	async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (!predicate()) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
	}

	it("executes follow-up prompt when turn 1 settles before async input hook completes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "metis-hook-admission-race-"));
		const hookStartedFile = join(tempDir, "queued-hook-started.json");
		const releaseHookFile = join(tempDir, "release-queued-hook");

		cleanups.push(() => {
			rmSync(tempDir, { recursive: true, force: true });
		});

		const faux = registerFauxProvider();
		cleanups.push(() => {
			faux.unregister();
		});

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const hookScript = `
const fs = require("node:fs");
const startFile = ${JSON.stringify(hookStartedFile)};
const releaseFile = ${JSON.stringify(releaseHookFile)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const prompt = input.prompt || "";
  if (prompt.includes("Second queued prompt")) {
    fs.writeFileSync(startFile, JSON.stringify({ pid: process.pid, prompt, at: Date.now() }));
    while (!fs.existsSync(releaseFile)) await sleep(10);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "RACE_CONTEXT_FOR_" + prompt,
    },
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

		const hook: DeclarativeHook = {
			id: "hook-async-admission-race",
			name: "async-admission-race-hook",
			enabled: true,
			event: "UserPromptSubmit",
			protocol: "command-v1",
			runMode: "process",
			command: process.execPath,
			args: ["-e", hookScript],
		};
		saveDeclarativeHooks(tempDir, [hook]);

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [
					(metis: any) => {
						metis.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((model: any) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};

		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"), { mode: "code" });
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager: manager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		cleanups.push(async () => {
			await runtimeHost.dispose();
		});

		await runtimeHost.session.bindExtensions({
			uiContext: {
				notify: () => {},
				select: async () => undefined,
				confirm: async () => true,
				input: async () => undefined,
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWorkingVisible: () => {},
				setWorkingIndicator: () => {},
			} as any,
		});

		let releaseFirstProvider!: () => void;
		const firstProviderDone = new Promise<void>((resolve) => {
			releaseFirstProvider = resolve;
		});
		const firstProviderStarted = new Promise<void>((resolve) => {
			faux.setResponses([
				async () => {
					resolve();
					await firstProviderDone;
					return fauxAssistantMessage("First turn completed");
				},
				() => {
					return fauxAssistantMessage("Second turn completed");
				},
			]);
		});

		const firstSubmission = runtimeHost.submitPrompt({
			requestId: "race-request-1",
			text: "First direct prompt",
		});
		await firstProviderStarted;

		const secondSubmission = runtimeHost.submitPrompt({
			requestId: "race-request-2",
			text: "Second queued prompt",
			streamingBehavior: "followUp",
		});
		await waitFor(() => existsSync(hookStartedFile), "slow UserPromptSubmit hook to start");

		releaseFirstProvider();
		await firstSubmission;
		await runtimeHost.waitForIdle();

		expect(runtimeHost.session.isIdle).toBe(true);

		writeFileSync(releaseHookFile, "release\n");
		await secondSubmission;
		await runtimeHost.waitForIdle();

		expect(faux.state.callCount).toBe(2);
		expect(runtimeHost.session.isIdle).toBe(true);
	}, 15_000);
});
