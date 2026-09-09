import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectMessageEntry } from "../../app-server/src/item-projection.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type DeclarativeHook, saveDeclarativeHooks } from "../src/core/hooks/declarative-hooks.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("hook context, blocking, and lifecycle integration", () => {
	let tempDir: string;
	let cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `metis-hook-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		for (const cleanup of cleanups.reverse()) {
			await cleanup();
		}
		cleanups = [];
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makeScriptHook(overrides: Partial<DeclarativeHook> & { script: string }): DeclarativeHook {
		const { script, ...rest } = overrides;
		return {
			id: `hook-${Math.random().toString(36).slice(2, 8)}`,
			name: "test-hook",
			enabled: true,
			event: "UserPromptSubmit",
			runMode: "process",
			protocol: "command-v1",
			command: process.execPath,
			args: ["-e", script],
			...rest,
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
			model: faux.getModel(),
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

	it("delivers SessionStart context to the first real model request and not subsequent turns", async () => {
		const hook = makeScriptHook({
			name: "startup-context-hook",
			event: "SessionStart",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "SESSION_MARKER_ALPHA" } }))`,
		});

		const { session, faux } = await setupSession([hook]);

		const receivedContexts: any[] = [];
		faux.setResponses([
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Hello back!");
			},
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Second answer!");
			},
		]);

		// First turn: should consume SessionStart context
		await session.prompt("First turn prompt");
		expect(receivedContexts.length).toBe(1);
		const firstTurnMessages = receivedContexts[0].messages;
		const firstUserMsg = firstTurnMessages.find((m: any) => m.role === "user");
		expect(firstUserMsg).toBeDefined();
		const userTextBlocks = firstUserMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(userTextBlocks).toContain("SESSION_MARKER_ALPHA");
		expect(userTextBlocks).toContain("First turn prompt");

		// Second turn: should NOT have SessionStart context repeated
		await session.prompt("Second turn prompt");
		expect(receivedContexts.length).toBe(2);
		const secondTurnUserMsg = receivedContexts[1].messages[receivedContexts[1].messages.length - 1];
		expect(secondTurnUserMsg.role).toBe("user");
		const secondTextBlocks = secondTurnUserMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(secondTextBlocks).not.toContain("SESSION_MARKER_ALPHA");
		expect(secondTextBlocks).toContain("Second turn prompt");
	});

	it("does not consume SessionStart context if the prompt was blocked", async () => {
		const startupHook = makeScriptHook({
			name: "startup-hook",
			event: "SessionStart",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "SESSION_PERSIST_MARKER" } }))`,
		});
		const promptHook = makeScriptHook({
			name: "prompt-gatekeeper",
			event: "UserPromptSubmit",
			script: `
				const fs = require('fs');
				const p = process.env.GATE_FILE;
				const count = fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf8'), 10) : 0;
				fs.writeFileSync(p, String(count + 1));
				if (count === 0) {
					console.log(JSON.stringify({ decision: "block", reason: "Gate closed on first try" }));
				} else {
					console.log(JSON.stringify({ decision: "allow" }));
				}
			`,
		});

		const gateFile = join(tempDir, "gate.txt");
		process.env.GATE_FILE = gateFile;
		cleanups.push(() => {
			delete process.env.GATE_FILE;
		});

		const { session, faux, notified } = await setupSession([startupHook, promptHook]);

		const receivedContexts: any[] = [];
		faux.setResponses([
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Accepted now!");
			},
		]);

		// First attempt: should be blocked by prompt-gatekeeper
		await expect(session.prompt("Prompt 1")).rejects.toThrow("Gate closed on first try");
		expect(faux.state.callCount).toBe(0);
		expect(notified.some((n) => n.message.includes("Gate closed on first try"))).toBe(true);

		// Second attempt: gate allows it, SessionStart context must STILL be available!
		await session.prompt("Prompt 2");
		expect(receivedContexts.length).toBe(1);
		const userMsg = receivedContexts[0].messages.find((m: any) => m.role === "user");
		const textContent = userMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(textContent).toContain("SESSION_PERSIST_MARKER");
		expect(textContent).toContain("Prompt 2");
	});

	it("attaches UserPromptSubmit context to provider message while preserving clean user bubble", async () => {
		const hook = makeScriptHook({
			name: "prompt-context-hook",
			event: "UserPromptSubmit",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "HOOK_RULE_OVERRIDE" } }))`,
		});

		const { session, faux, sessionManager } = await setupSession([hook]);

		let providerContext: any;
		faux.setResponses([
			(ctx) => {
				providerContext = ctx;
				return fauxAssistantMessage("Acknowledged!");
			},
		]);

		await session.prompt("Please fix the bug in main.ts");

		// 1. Check provider saw the hook context
		expect(providerContext).toBeDefined();
		const userMsg = providerContext.messages.find((m: any) => m.role === "user");
		const providerText = userMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(providerText).toContain("HOOK_RULE_OVERRIDE");
		expect(providerText).toContain("Please fix the bug in main.ts");

		// 2. Check projected user item view (what desktop UI renders in chat bubble)
		const entries = sessionManager.getEntries();
		const userEntry = entries.find((e) => e.type === "message" && (e.message as any).role === "user");
		expect(userEntry).toBeDefined();

		const projected = projectMessageEntry({
			entry: userEntry as any,
			sessionId: sessionManager.getSessionId(),
			turnStates: new Map(),
			toolStates: new Map(),
			deliveredFiles: new Map(),
			fallbackTimestamp: new Date().toISOString(),
		});

		expect(projected).toBeDefined();
		expect(projected!.role).toBe("user");
		// The projected content blocks for the UI bubble must NOT have HOOK_RULE_OVERRIDE
		const bubbleText = (projected!.content as any[])
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		expect(bubbleText).toBe("Please fix the bug in main.ts");
		expect(bubbleText).not.toContain("HOOK_RULE_OVERRIDE");
	});

	it("blocks prompt execution on UserPromptSubmit decision:block with 0 provider calls", async () => {
		const hook = makeScriptHook({
			name: "blocking-hook",
			event: "UserPromptSubmit",
			script: `console.log(JSON.stringify({ decision: "block", reason: "Missing required checklist ticket" }))`,
		});

		const { session, faux, notified } = await setupSession([hook]);

		await expect(session.prompt("Do risky thing")).rejects.toThrow("Missing required checklist ticket");
		expect(faux.state.callCount).toBe(0);
		expect(notified.some((n) => n.message.includes("Missing required checklist ticket"))).toBe(true);
	});

	it("blocks PreToolUse with deny and exit 2 with 0 tool invocations", async () => {
		const hook = makeScriptHook({
			name: "block-bash-hook",
			event: "PreToolUse",
			matcher: "bash",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Bash execution is disabled by policy" } }))`,
		});

		const { session, faux } = await setupSession([hook]);

		// Faux responds with tool call
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /" }, { id: "tc-bash-1" })]),
			fauxAssistantMessage("Tool was denied, standing down."),
		]);

		await session.prompt("Run bash command");

		// Tool execution in agent loop should have yielded error tool result back to model
		expect(faux.state.callCount).toBe(2);
	});

	it("attaches PreToolUse context and PostToolUse context to the tool result", async () => {
		const preHook = makeScriptHook({
			name: "pre-hook",
			event: "PreToolUse",
			matcher: "bash",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "PRE_TOOL_HINT" } }))`,
		});
		const postHook = makeScriptHook({
			name: "post-hook",
			event: "PostToolUse",
			matcher: "bash",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "POST_TOOL_ANALYSIS" } }))`,
		});

		const { session, faux } = await setupSession([preHook, postHook]);

		let secondTurnContext: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello" }, { id: "tc-bash-2" })]),
			(ctx) => {
				secondTurnContext = ctx;
				return fauxAssistantMessage("Done");
			},
		]);

		await session.prompt("Run echo");

		expect(secondTurnContext).toBeDefined();
		const toolResultMsg = secondTurnContext.messages.find((m: any) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		const resultText = toolResultMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(resultText).toContain("PRE_TOOL_HINT");
		expect(resultText).toContain("POST_TOOL_ANALYSIS");
	});

	it("isolates contexts between two concurrent sessions", async () => {
		const tempDirA = join(tempDir, "session-a");
		const tempDirB = join(tempDir, "session-b");
		mkdirSync(tempDirA, { recursive: true });
		mkdirSync(tempDirB, { recursive: true });

		const hookA = makeScriptHook({
			name: "hook-a",
			event: "UserPromptSubmit",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "SESSION_A_SECRET" } }))`,
		});
		const hookB = makeScriptHook({
			name: "hook-b",
			event: "UserPromptSubmit",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "SESSION_B_SECRET" } }))`,
		});

		saveDeclarativeHooks(tempDirA, [hookA]);
		saveDeclarativeHooks(tempDirB, [hookB]);

		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const makeSessionFor = async (dir: string) => {
			const services = await createAgentSessionServices({
				agentDir: dir,
				authStorage,
				cwd: dir,
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
			});
			const sessionManager = SessionManager.create(dir, join(dir, "sessions"), { mode: "code" });
			const runtimeHost = await createAgentSessionRuntime(
				async () => ({
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "startup" },
						model: faux.getModel(),
					})),
					services,
					diagnostics: services.diagnostics,
				}),
				{ cwd: dir, agentDir: dir, sessionManager },
			);
			await runtimeHost.session.bindExtensions({});
			cleanups.push(() => runtimeHost.dispose());
			return runtimeHost.session;
		};

		const sessionA = await makeSessionFor(tempDirA);
		const sessionB = await makeSessionFor(tempDirB);

		let contextA: any;
		let contextB: any;

		faux.setResponses([
			(ctx) => {
				contextA = ctx;
				return fauxAssistantMessage("Answer A");
			},
			(ctx) => {
				contextB = ctx;
				return fauxAssistantMessage("Answer B");
			},
		]);

		await sessionA.prompt("Prompt for A");
		await sessionB.prompt("Prompt for B");

		const userMsgA = contextA.messages.find((m: any) => m.role === "user");
		const userMsgB = contextB.messages.find((m: any) => m.role === "user");
		const textA = userMsgA.content.map((c: any) => c.text).join("\n");
		const textB = userMsgB.content.map((c: any) => c.text).join("\n");

		expect(textA).toContain("SESSION_A_SECRET");
		expect(textA).not.toContain("SESSION_B_SECRET");

		expect(textB).toContain("SESSION_B_SECRET");
		expect(textB).not.toContain("SESSION_A_SECRET");
	});

	it("preserves hookContext across session reload without re-running completed hooks", async () => {
		const markerFile = join(tempDir, "hook_executions.txt");
		const hook = makeScriptHook({
			name: "tracked-hook",
			event: "UserPromptSubmit",
			script: `
				const fs = require('fs');
				const marker = process.env.MARKER_FILE;
				const count = fs.existsSync(marker) ? parseInt(fs.readFileSync(marker, 'utf8'), 10) : 0;
				fs.writeFileSync(marker, String(count + 1));
				console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "RUN_COUNT_" + (count + 1) } }));
			`,
		});

		process.env.MARKER_FILE = markerFile;
		cleanups.push(() => {
			delete process.env.MARKER_FILE;
		});

		const { session, sessionManager, faux } = await setupSession([hook]);

		faux.setResponses([fauxAssistantMessage("Done turn 1")]);
		await session.prompt("Turn 1 prompt");

		const entries = sessionManager.getEntries();
		const userMsg = (entries.find((e) => e.type === "message" && (e.message as any).role === "user") as any)?.message;
		expect(userMsg.hookContext).toContain("RUN_COUNT_1");

		// Check execution count of hook: it should only have been run once for the user prompt
		const count = parseInt(existsSync(markerFile) ? readFileSync(markerFile, "utf8") : "0", 10);
		expect(count).toBe(1);
	});

	it("attaches PostToolUseFailure context to failed tool results while keeping error details intact", async () => {
		const failHook = makeScriptHook({
			name: "fail-hook",
			event: "PostToolUseFailure",
			matcher: "bash",
			script: `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "FAILURE_DIAGNOSTIC_HINT" } }))`,
		});

		const { session, faux } = await setupSession([failHook]);

		let secondTurnContext: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "exit 42" }, { id: "tc-bash-fail" })]),
			(ctx) => {
				secondTurnContext = ctx;
				return fauxAssistantMessage("Tool failed, handled.");
			},
		]);

		await session.prompt("Run failing command");

		expect(secondTurnContext).toBeDefined();
		const toolResultMsg = secondTurnContext.messages.find((m: any) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();
		expect(toolResultMsg.isError).toBe(true);
		const resultText = toolResultMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(resultText).toContain("FAILURE_DIAGNOSTIC_HINT");
	});

	it("queues follow-up input during agent execution with distinct hook context", async () => {
		const hook = makeScriptHook({
			name: "followup-hook",
			event: "UserPromptSubmit",
			script: `
				const fs = require('fs');
				const input = JSON.parse(fs.readFileSync(0, 'utf8'));
				const text = input.prompt || input.text || "";
				console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "HOOK_FOR_" + text.trim() } }));
			`,
		});

		const { session, faux } = await setupSession([hook]);

		let finishFirstResponse: () => void;
		const firstResponseGate = new Promise<void>((resolve) => {
			finishFirstResponse = resolve;
		});

		const receivedContexts: any[] = [];
		faux.setResponses([
			async (ctx) => {
				receivedContexts.push(ctx);
				await firstResponseGate;
				return fauxAssistantMessage("First done");
			},
			(ctx) => {
				receivedContexts.push(ctx);
				return fauxAssistantMessage("Second done");
			},
		]);

		const promptPromise = session.prompt("First prompt");

		// Wait briefly for the first prompt to start streaming
		while (!session.isStreaming) {
			await new Promise((r) => setTimeout(r, 10));
		}

		// Now submit follow-up while streaming
		await session.prompt("Second queued prompt", { streamingBehavior: "followUp" });

		// Now let first response finish
		finishFirstResponse!();
		await promptPromise;

		expect(receivedContexts.length).toBe(2);

		// First prompt should have HOOK_FOR_First prompt
		const firstUserMsg = receivedContexts[0].messages.find((m: any) => m.role === "user");
		const firstText = firstUserMsg.content.map((c: any) => c.text).join("\n");
		expect(firstText).toContain("HOOK_FOR_First prompt");
		expect(firstText).not.toContain("HOOK_FOR_Second queued prompt");

		// Second turn should receive the follow-up message with HOOK_FOR_Second queued prompt
		const secondUserMsg = receivedContexts[1].messages.find(
			(m: any) => m.role === "user" && m.content.some((c: any) => c.text?.includes("Second queued prompt")),
		);
		expect(secondUserMsg).toBeDefined();
		const secondText = secondUserMsg.content.map((c: any) => c.text).join("\n");
		expect(secondText).toContain("HOOK_FOR_Second queued prompt");
	});
});
