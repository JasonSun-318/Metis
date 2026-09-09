/**
 * End-to-end: a declarative hook in hooks.json fires when a real session is
 * created through the same services path the desktop and CLI use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { saveDeclarativeHooks } from "../src/core/hooks/declarative-hooks.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("declarative hooks end-to-end", () => {
	let agentDir: string;
	let marker: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hooks-e2e-"));
		marker = path.join(agentDir, "session-started.flag");
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("fires a SessionStart hook when a session starts", async () => {
		// Install the hook: shell mode writes the event payload to a marker file.
		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-session-start",
				name: "e2e session start",
				enabled: true,
				event: "SessionStart",
				runMode: "shell",
				command: `cat > ${JSON.stringify(marker)}`,
			},
		]);

		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		// Same call the app-server runtime host makes when a session comes up.
		await session.bindExtensions({});
		session.dispose();

		expect(fs.existsSync(marker)).toBe(true);
		const payload = JSON.parse(fs.readFileSync(marker, "utf8"));
		expect(payload.event).toBe("SessionStart");
		expect(payload.hook.name).toBe("e2e session start");
		expect(payload.sessionId).toBe("e2e-session");
		expect(payload.cwd).toBe(agentDir);
	});

	it("does not fire any hook when hooks.json is empty", async () => {
		saveDeclarativeHooks(agentDir, []);
		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-2",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		await session.bindExtensions({});
		session.dispose();

		expect(fs.existsSync(marker)).toBe(false);
	});

	it("applies command-v1 SessionStart context to a newly bound session", async () => {
		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-cmd-session-start",
				name: "e2e cmd start",
				enabled: true,
				event: "SessionStart",
				protocol: "command-v1",
				runMode: "shell",
				command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"STARTUP_CONTEXT"}}'`,
			},
		]);

		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-3",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		await session.bindExtensions({});

		// The pending session start context should be captured
		expect((session as any)._pendingSessionStartContext).toBe("[Hook: e2e cmd start]\nSTARTUP_CONTEXT");
		session.dispose();
	});

	it("runs full e2e turn with SessionStart and UserPromptSubmit context delivered to faux provider without polluting user message", async () => {
		const { fauxAssistantMessage, registerFauxProvider } = await import("@metis/ai/compat");
		const { AuthStorage } = await import("../src/core/auth-storage.ts");

		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-cmd-start",
				name: "e2e-start",
				enabled: true,
				event: "SessionStart",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: [
					"-e",
					'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "E2E_STARTUP_HINT" } }))',
				],
			},
			{
				id: "e2e-cmd-prompt",
				name: "e2e-prompt",
				enabled: true,
				event: "UserPromptSubmit",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: [
					"-e",
					'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "E2E_PROMPT_RULE" } }))',
				],
			},
		]);

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			authStorage,
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

		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-full-turn",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
		});

		await session.bindExtensions({});

		let capturedContext: any;
		faux.setResponses([
			(ctx) => {
				capturedContext = ctx;
				return fauxAssistantMessage("E2E response ok");
			},
		]);

		await session.prompt("Hello world user prompt");

		expect(capturedContext).toBeDefined();
		const userMsg = capturedContext.messages.find((m: any) => m.role === "user");
		const fullText = userMsg.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		// Both contexts delivered to provider
		expect(fullText).toContain("E2E_STARTUP_HINT");
		expect(fullText).toContain("E2E_PROMPT_RULE");
		expect(fullText).toContain("Hello world user prompt");

		// User-visible message history in SessionManager must remain clean
		const entries = sessionManager.getEntries();
		const userEntry = entries.find((e: any) => e.type === "message" && e.message?.role === "user");
		const entryText = (userEntry as any).message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		expect(entryText).toBe("Hello world user prompt");
		expect(entryText).not.toContain("E2E_STARTUP_HINT");
		expect(entryText).not.toContain("E2E_PROMPT_RULE");

		session.dispose();
		faux.unregister();
	});

	it("blocks prompt execution on UserPromptSubmit exit 2 and does not call provider", async () => {
		const { registerFauxProvider } = await import("@metis/ai/compat");
		const { AuthStorage } = await import("../src/core/auth-storage.ts");

		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-cmd-block-prompt",
				name: "blocker",
				enabled: true,
				event: "UserPromptSubmit",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: ["-e", 'console.error("Denied by security policy"); process.exit(2);'],
			},
		]);

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			authStorage,
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

		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-blocked",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
		});

		await session.bindExtensions({});

		await expect(session.prompt("Malicious input")).rejects.toThrow("Denied by security policy");
		expect(faux.state.callCount).toBe(0);

		session.dispose();
		faux.unregister();
	});

	it("runs PreToolUse deny preventing tool execution and PostToolUse adding context", async () => {
		const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@metis/ai/compat");
		const { AuthStorage } = await import("../src/core/auth-storage.ts");

		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-pre-deny",
				name: "deny-dangerous",
				enabled: true,
				event: "PreToolUse",
				matcher: "bash",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: [
					"-e",
					`
					let data = "";
					process.stdin.on("data", chunk => data += chunk);
					process.stdin.on("end", () => {
						const payload = JSON.parse(data);
						const cmd = payload.input?.command || "";
						if (cmd.includes("forbidden")) {
							console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Forbidden command blocked by policy" } }));
						} else {
							console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "PRE_ALLOWED" } }));
						}
					});
					`,
				],
			},
			{
				id: "e2e-post-context",
				name: "audit-safe",
				enabled: true,
				event: "PostToolUse",
				matcher: "bash",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: [
					"-e",
					'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "AUDIT_VERIFIED" } }))',
				],
			},
		]);

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			authStorage,
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

		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-tools",
			mode: "code",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
		});

		await session.bindExtensions({});

		// Turn 1: model attempts forbidden command -> blocked, 0 bash executions
		let providerContext1: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf forbidden" }, { id: "call-forbidden-1" })]),
			(ctx) => {
				providerContext1 = ctx;
				return fauxAssistantMessage("Handled forbidden tool rejection");
			},
		]);

		await session.prompt("Run dangerous operation");
		expect(providerContext1).toBeDefined();
		const toolResult1 = providerContext1.messages.find((m: any) => m.role === "toolResult");
		expect(toolResult1.isError).toBe(true);
		expect(toolResult1.content[0].text).toContain("Forbidden command blocked by policy");

		// Turn 2: model attempts allowed command -> executed, pre-hook and post-hook append context
		let providerContext2: any;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo safe" }, { id: "call-allowed-1" })]),
			(ctx) => {
				providerContext2 = ctx;
				return fauxAssistantMessage("Handled safe tool with audit");
			},
		]);

		await session.prompt("Run safe operation");
		expect(providerContext2).toBeDefined();
		const toolResult2 = providerContext2.messages.find(
			(m: any) => m.role === "toolResult" && m.toolCallId === "call-allowed-1",
		);
		expect(toolResult2.isError).toBe(false);
		const tool2AllText = toolResult2.content.map((c: any) => c.text).join("\n");
		expect(tool2AllText).toContain("safe");
		expect(tool2AllText).toContain("PRE_ALLOWED");
		expect(tool2AllText).toContain("AUDIT_VERIFIED");

		session.dispose();
		faux.unregister();
	});

	it("runs Stop hook continuation for exactly one extra turn before settling", async () => {
		const { fauxAssistantMessage, registerFauxProvider } = await import("@metis/ai/compat");
		const { AuthStorage } = await import("../src/core/auth-storage.ts");

		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-cmd-stop",
				name: "stop-reviewer",
				enabled: true,
				event: "Stop",
				protocol: "command-v1",
				runMode: "process",
				command: process.execPath,
				args: [
					"-e",
					`
					const fs = require('fs');
					const input = JSON.parse(fs.readFileSync(0, 'utf8'));
					if (!input.stop_hook_active) {
						console.log(JSON.stringify({
							decision: "block",
							reason: "Please verify findings once more",
						}));
					} else {
						console.log(JSON.stringify({ decision: "allow" }));
					}
					`,
				],
			},
		]);

		const faux = registerFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const services = await createAgentSessionServices({
			cwd: agentDir,
			agentDir,
			authStorage,
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

		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-stop",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: faux.getModel(),
		});

		await session.bindExtensions({});

		let turn2ReceivedContext: any;
		faux.setResponses([
			fauxAssistantMessage("Turn 1 assistant answer"),
			(ctx) => {
				turn2ReceivedContext = ctx;
				return fauxAssistantMessage("Turn 2 assistant answer verified");
			},
		]);

		await session.prompt("Initial goal prompt");

		expect(faux.state.callCount).toBe(2);
		expect(turn2ReceivedContext).toBeDefined();
		const continuationMsg = turn2ReceivedContext.messages.find(
			(m: any) =>
				m.role === "user" && m.content.some((c: any) => c.text?.includes("Please verify findings once more")),
		);
		expect(continuationMsg).toBeDefined();
		const continuationText = continuationMsg.content.map((c: any) => c.text).join("\n");
		expect(continuationText).toContain("Please verify findings once more");

		session.dispose();
		faux.unregister();
	});
});
