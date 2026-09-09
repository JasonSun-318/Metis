import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type DeclarativeHook, saveDeclarativeHooks } from "../src/core/hooks/declarative-hooks.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("command-v1 Stop hook continuation", () => {
	let tempDir: string;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `metis-hook-stop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const cleanup of cleanups) {
			try {
				await cleanup();
			} catch {}
		}
		cleanups.length = 0;
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeScriptHook(options: {
		name: string;
		event: DeclarativeHook["event"];
		script: string;
		protocol?: "legacy" | "command-v1";
	}): DeclarativeHook {
		const scriptPath = join(tempDir, `${options.name}.js`);
		writeFileSync(scriptPath, options.script, "utf8");
		return {
			id: `hook-${options.name}`,
			name: options.name,
			enabled: true,
			event: options.event,
			protocol: options.protocol ?? "command-v1",
			runMode: "process",
			command: process.execPath,
			args: [scriptPath],
		};
	}

	async function setupSession(hooks: DeclarativeHook[] = []) {
		saveDeclarativeHooks(tempDir, hooks);
		const faux = registerFauxProvider();

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			cwd: tempDir,
			resourceLoaderOptions: {
				extensionFactories: [
					(metis: any) => {
						metis.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((m: any) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
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
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
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

		const notified: Array<{ message: string; type?: string }> = [];
		await runtimeHost.session.bindExtensions({
			uiContext: {
				notify: (message: string, type?: any) => notified.push({ message, type }),
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

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
		});

		return {
			runtimeHost,
			session: runtimeHost.session,
			sessionManager,
			faux,
			notified,
		};
	}

	it("honors Stop continuation before settlement: model receives reason and settles once", async () => {
		const stopHook = makeScriptHook({
			name: "qa-stop-gatekeeper",
			event: "Stop",
			script: `
				const fs = require('fs');
				const input = JSON.parse(fs.readFileSync(0, 'utf8'));
				if (!input.stop_hook_active) {
					console.log(JSON.stringify({
						decision: "block",
						reason: "Please verify that tests pass before stopping",
						hookSpecificOutput: {
							additionalContext: "EXTRA_QA_GUIDELINES"
						}
					}));
				} else {
					console.log(JSON.stringify({ decision: "allow" }));
				}
			`,
		});

		const { session, faux } = await setupSession([stopHook]);

		let settledCount = 0;
		session.subscribe((event) => {
			if (event.type === "agent_settled") {
				settledCount++;
			}
		});

		const receivedContexts: any[] = [];
		faux.setResponses([
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("First response: work is done.");
			},
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Second response: tests verified, now really done.");
			},
		]);

		await session.prompt("Implement feature X");

		// Model must have been called twice in the single turn
		expect(receivedContexts.length).toBe(2);

		// Second turn receives the continuation message containing reason and context
		const secondMessages = receivedContexts[1].messages;
		const userMsg = secondMessages.find(
			(m: any) =>
				m.role === "user" &&
				m.content.some((c: any) => c.text?.includes("Please verify that tests pass before stopping")),
		);
		expect(userMsg).toBeDefined();
		const continuationText = userMsg.content.map((c: any) => c.text).join("\n");
		expect(continuationText).toContain("Please verify that tests pass before stopping");
		expect(continuationText).toContain("EXTRA_QA_GUIDELINES");

		// Only a single agent_settled event was emitted
		expect(settledCount).toBe(1);
	});

	it("enforces a limit of one Stop continuation per turn even if hook continuously blocks", async () => {
		const persistentBlockHook = makeScriptHook({
			name: "persistent-blocker",
			event: "Stop",
			script: `
				console.log(JSON.stringify({
					decision: "block",
					reason: "I refuse to let the turn stop!"
				}));
			`,
		});

		const { session, faux } = await setupSession([persistentBlockHook]);

		let callCount = 0;
		faux.setResponses([
			() => {
				callCount++;
				return fauxAssistantMessage("Attempt 1");
			},
			() => {
				callCount++;
				return fauxAssistantMessage("Attempt 2");
			},
			() => {
				callCount++;
				return fauxAssistantMessage("Attempt 3 (should not happen)");
			},
		]);

		await session.prompt("Run persistent task");

		// Even though hook blocks every time, max 1 continuation means exactly 2 calls
		expect(callCount).toBe(2);
	});

	it("supports exit code 2 on command-v1 Stop to trigger continuation", async () => {
		const exit2Hook = makeScriptHook({
			name: "exit-2-stop-hook",
			event: "Stop",
			script: `
				const fs = require('fs');
				const input = JSON.parse(fs.readFileSync(0, 'utf8'));
				if (!input.stop_hook_active) {
					console.error("Critical sanity check failed: must recheck");
					process.exit(2);
				} else {
					process.exit(0);
				}
			`,
		});

		const { session, faux } = await setupSession([exit2Hook]);

		const receivedContexts: any[] = [];
		faux.setResponses([
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("First attempt");
			},
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Second attempt");
			},
		]);

		await session.prompt("Run task with exit 2 hook");

		expect(receivedContexts.length).toBe(2);
		const secondMessages = receivedContexts[1].messages;
		const userMsg = secondMessages.find(
			(m: any) =>
				m.role === "user" &&
				m.content.some((c: any) => c.text?.includes("Critical sanity check failed: must recheck")),
		);
		expect(userMsg).toBeDefined();
	});

	it("fires legacy Stop hook as observer on agent_settled and mixes properly with command-v1", async () => {
		const commandHook = makeScriptHook({
			name: "cmd-stop",
			event: "Stop",
			protocol: "command-v1",
			script: `
				const fs = require('fs');
				const input = JSON.parse(fs.readFileSync(0, 'utf8'));
				const p = process.env.ORDER_FILE;
				const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
				cur.push("command-stop active=" + !!input.stop_hook_active);
				fs.writeFileSync(p, JSON.stringify(cur));
				console.log(JSON.stringify({ decision: "allow" }));
			`,
		});

		const legacyHook = makeScriptHook({
			name: "legacy-stop",
			event: "Stop",
			protocol: "legacy",
			script: `
				const fs = require('fs');
				const p = process.env.ORDER_FILE;
				const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
				cur.push("legacy-stop");
				fs.writeFileSync(p, JSON.stringify(cur));
			`,
		});

		const orderFile = join(tempDir, "order.json");
		process.env.ORDER_FILE = orderFile;
		cleanups.push(() => {
			delete process.env.ORDER_FILE;
		});

		const { session, faux } = await setupSession([commandHook, legacyHook]);

		faux.setResponses([fauxAssistantMessage("Done")]);
		await session.prompt("Mixed stop hooks test");

		expect(existsSync(orderFile)).toBe(true);
		const log = JSON.parse(readFileSync(orderFile, "utf8"));
		// Command stop must fire first (during before_agent_stop), legacy stop must fire after (on agent_settled)
		expect(log).toEqual(["command-stop active=false", "legacy-stop"]);
	});

	it("does not trigger Stop hook continuation when prompt was aborted", async () => {
		const stopHook = makeScriptHook({
			name: "abort-stop-hook",
			event: "Stop",
			script: `
				console.log(JSON.stringify({
					decision: "block",
					reason: "Should not be called if aborted"
				}));
			`,
		});

		const { session, faux } = await setupSession([stopHook]);

		let firstCallResolve: () => void;
		const firstCallStarted = new Promise<void>((resolve) => {
			firstCallResolve = resolve;
		});

		let callCount = 0;
		faux.setResponses([
			async () => {
				callCount++;
				firstCallResolve();
				// Wait long enough for abort to be called
				await new Promise((r) => setTimeout(r, 200));
				return fauxAssistantMessage("Aborted mid-flight");
			},
			() => {
				callCount++;
				return fauxAssistantMessage("Unreachable");
			},
		]);

		const promptPromise = session.prompt("Abort test");
		await firstCallStarted;
		await session.abort();
		await promptPromise;

		// Should not have continued after abort
		expect(callCount).toBe(1);
	});
});
