import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeServer,
	connectToApp,
	launchPackagedDesktop,
	listen,
	messageText,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

export const SUBAGENT_FIXTURE = {
	start: "SUBAGENT_FIXTURE_START",
	stop: "SUBAGENT_STOP_FIXTURE_START",
	providerFailure: "SUBAGENT_PROVIDER_FAILURE",
	providerRecovery: "SUBAGENT_PROVIDER_RECOVERY",
	alphaTask:
		"ALPHA_TASK: inspect the fixture workspace, record the alpha evidence marker, and report it. Do not modify files.",
	betaTask:
		"BETA_TASK: audit the fixture workspace independently, record the beta evidence marker, and report it. Do not modify files.",
	correction: "CORRECTION-ALPHA: the alpha result must use the corrected evidence marker, not the old one.",
	alphaName: "Alpha worker",
	betaName: "Beta auditor",
	stopName: "Stop worker",
	stopTask: "STOP_TASK: keep inspecting the workspace until interrupted, then report the stop marker.",
} as const;

export const SUBAGENT_CUSTOM_ROLE = {
	id: "fixture-auditor",
	displayName: "Fixture Auditor",
	description: "Read-only fixture auditor used to verify custom role snapshots and effective tools.",
	allowedTools: ["read", "grep", "bash"],
	systemPrompt: "Fixture custom role: audit only; do not edit files or delegate work.",
	writePolicy: "deny" as const,
	mayDelegate: false,
} as const;

export type SubagentMode = "chat" | "code";

export interface AgentTaskRecord {
	readonly taskId: string;
	readonly instructionRevision?: number;
	readonly consumedInstructionRevision?: number;
	readonly status: "queued" | "running" | "done" | "failed" | "stopped";
	readonly taskSummary: string;
	readonly finalMessage?: string;
	readonly error?: string;
}

export interface AgentRecord {
	readonly agentId: string;
	readonly name: string;
	readonly agentType: string;
	readonly depth: number;
	readonly status: "queued" | "running" | "done" | "failed" | "stopped";
	readonly archived: boolean;
	readonly parentSessionId: string;
	readonly rootSessionId: string;
	readonly mode?: SubagentMode;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly tools?: readonly string[];
	readonly writePolicy?: "inherit" | "deny";
	readonly mayDelegate?: boolean;
	readonly runControl?: "enabled" | "user_paused" | "interrupted";
	readonly tasks: readonly AgentTaskRecord[];
	readonly currentTask?: AgentTaskRecord;
	readonly latestTask?: AgentTaskRecord;
}

export interface AgentItemRecord {
	readonly turnId?: string;
	readonly itemId: string;
	readonly sessionId: string;
	readonly role: "user" | "assistant" | "tool" | "system";
	readonly state: string;
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly level?: string; readonly toolCallId?: string; readonly name?: string }>;
	readonly origin?: { readonly kind: string; readonly sessionId?: string };
	readonly agentMessageId?: string;
	readonly agentTaskId?: string;
	readonly agentTargetId?: string;
	readonly deliveryState?: "accepted" | "queued" | "delivered" | "cancelled" | "failed";
	readonly instructionRevision?: number;
}

export interface AgentSendReceiptRecord {
	readonly agentId: string;
	readonly taskId: string;
	readonly messageId: string;
	readonly requestId: string;
	readonly delivery: "steer" | "start" | "queue";
	readonly state: "accepted" | "queued" | "delivered" | "cancelled" | "failed";
	readonly instructionRevision: number;
}

type DesktopGlobals = {
	readonly metis: MetisDesktopApi;
};

export interface SubagentEnvironment {
	readonly tempRoot: string;
	readonly agentDir: string;
	readonly homeDir: string;
	readonly projectDir: string;
	readonly userDataDir: string;
	readonly diagnostics: string[];
}

export interface RunningSubagentApp {
	readonly app: ReturnType<typeof launchPackagedDesktop>;
	readonly browser: Browser;
	readonly page: Page;
}

export interface SubagentModelMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly tool_call_id?: string;
	readonly tool_calls?: ReadonlyArray<{
		readonly id?: string;
		readonly function?: { readonly name?: string; readonly arguments?: string };
	}>;
}

export interface SubagentMailboxEvent {
	readonly type: string;
	readonly eventId: string;
	readonly messageId?: string;
	readonly agentId?: string;
	readonly taskId?: string;
	readonly instructionRevision?: number;
	readonly delivery?: string;
	readonly state?: string;
	readonly text?: string;
}

export interface SubagentModelRequest {
	readonly index: number;
	readonly at: number;
	readonly model: string;
	readonly isChild: boolean;
	readonly agentId?: string;
	readonly agentName?: string;
	readonly system: string;
	readonly messages: readonly SubagentModelMessage[];
	readonly toolNames: readonly string[];
	readonly userTexts: readonly string[];
	readonly mailboxEvents: readonly SubagentMailboxEvent[];
	readonly spawnNames: readonly string[];
}

export interface SubagentModelServer {
	readonly port: number;
	readonly requests: SubagentModelRequest[];
	readonly close: () => Promise<void>;
}

export interface SubagentModelMessagePayload {
	readonly model?: string;
	readonly messages?: readonly SubagentModelMessage[];
	readonly instructions?: string;
	readonly input?: ReadonlyArray<SubagentModelMessage & { readonly type?: string; readonly name?: string; readonly output?: string }>;
	readonly tools?: ReadonlyArray<{ readonly name?: string; readonly function?: { readonly name?: string } }>;
}

function modelMessages(payload: SubagentModelMessagePayload): readonly SubagentModelMessage[] {
	if (payload.messages) return payload.messages;
	return [
		...(payload.instructions ? [{ role: "system", content: payload.instructions }] : []),
		...(payload.input ?? []).map((entry): SubagentModelMessage => {
			if (entry.type === "function_call")
				return { role: "assistant", tool_calls: [{ function: { name: entry.name } }] };
			if (entry.type === "function_call_output") return { role: "tool", content: entry.output };
			return entry;
		}),
	];
}

function contentText(value: unknown): string {
	return messageText(value);
}

function parseAgentIdentity(system: string): { agentId: string; agentName: string } | undefined {
	const match = system.match(/You are agent "([^"]+)" \("([^"]+)"\)/u);
	return match?.[1] && match[2] ? { agentName: match[1], agentId: match[2] } : undefined;
}

function mailboxEventsIn(texts: readonly string[]): SubagentMailboxEvent[] {
	const events: SubagentMailboxEvent[] = [];
	const pattern = /<agent_mailbox_event encoding="json">\s*([\s\S]*?)\s*<\/agent_mailbox_event>/gu;
	for (const text of texts) {
		for (const match of text.matchAll(pattern)) {
			const body = match[1];
			if (!body) continue;
			try {
				const parsed = JSON.parse(body) as unknown;
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				const event = parsed as Record<string, unknown>;
				if (typeof event.type === "string" && typeof event.eventId === "string")
					events.push(event as unknown as SubagentMailboxEvent);
			} catch {
				// A malformed mailbox payload is a product failure, not something to hide here.
			}
		}
	}
	return events;
}

function toolNamesOf(messages: readonly SubagentModelMessage[]): string[] {
	const names: string[] = [];
	for (const message of messages) {
		for (const call of message.tool_calls ?? []) {
			const name = call.function?.name;
			if (name) names.push(name);
		}
	}
	return names;
}

function modelChunk(response: ServerResponse, body: object): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
}

function modelText(response: ServerResponse, model: string, text: string): void {
	modelChunk(response, {
		id: `subagent-fixture-${Date.now()}`,
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
	});
}

function modelToolCalls(
	response: ServerResponse,
	model: string,
	calls: readonly { readonly callId: string; readonly name: string; readonly arguments: object }[],
): void {
	modelChunk(response, {
		id: `subagent-fixture-tools-${Date.now()}`,
		object: "chat.completion.chunk",
		created: 1,
		model,
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: calls.map((call, index) => ({
						index,
						id: call.callId,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.arguments) },
					})),
				},
				finish_reason: "tool_calls",
			},
		],
	});
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body) as unknown;
}

async function writeProviderConfig(
	agentDir: string,
	input: {
		readonly providerId: string;
		readonly modelId: string;
		readonly baseUrl: string;
		readonly apiKey?: string;
		readonly providerConfig?: Readonly<Record<string, unknown>>;
		readonly modelConfig?: Readonly<Record<string, unknown>>;
	},
): Promise<void> {
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						[input.providerId]: {
							...(input.providerConfig ?? {}),
							baseUrl: input.baseUrl,
							...(input.apiKey ? { apiKey: input.apiKey } : {}),
							api: input.providerConfig?.api ?? "openai-completions",
							models: [
								input.modelConfig
									? {
											...input.modelConfig,
											id: input.modelId,
											baseUrl: input.baseUrl,
											api: input.modelConfig.api ?? input.providerConfig?.api ?? "openai-completions",
										}
									: {
											id: input.modelId,
											name: "Subagent Fixture Model",
											input: ["text", "image"],
											contextWindow: 1_000_000,
											maxTokens: 16_384,
										},
							],
						},
					},
				},
				null,
				2,
			),
			{ mode: 0o600 },
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: input.providerId, defaultModel: input.modelId, retry: { enabled: false } }, null, 2),
			{ mode: 0o600 },
		),
	]);
}

export async function createSubagentEnvironment(input: {
	readonly providerId: string;
	readonly modelId: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly providerConfig?: Readonly<Record<string, unknown>>;
	readonly modelConfig?: Readonly<Record<string, unknown>>;
	readonly credential?: unknown;
}): Promise<SubagentEnvironment> {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-subagent-conversations-"));
	const environment: SubagentEnvironment = {
		tempRoot,
		agentDir: path.join(tempRoot, "agent"),
		homeDir: path.join(tempRoot, "home"),
		projectDir: path.join(tempRoot, "project"),
		userDataDir: path.join(tempRoot, "electron"),
		diagnostics: [],
	};
	await Promise.all([
		mkdir(environment.agentDir),
		mkdir(environment.homeDir),
		mkdir(environment.projectDir),
		mkdir(environment.userDataDir),
	]);
	await writeFile(
		path.join(environment.projectDir, "README.md"),
		"# Subagent fixture\n\nalpha evidence marker: fixture-alpha\nalpha corrected marker: fixture-alpha-corrected\nbeta evidence marker: fixture-beta\n",
	);
	await writeProviderConfig(environment.agentDir, input);
	if (input.credential !== undefined)
		await writeFile(path.join(environment.agentDir, "auth.json"), JSON.stringify({ [input.providerId]: input.credential }), {
			mode: 0o600,
		});
	return environment;
}

export async function launchSubagentApp(environment: SubagentEnvironment): Promise<RunningSubagentApp> {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
	const debuggingPort = await reservePort();
	const app = launchPackagedDesktop({
		executable,
		debuggingPort,
		userDataDir: environment.userDataDir,
		projectDir: environment.projectDir,
		agentDir: environment.agentDir,
		homeDir: environment.homeDir,
		diagnostics: environment.diagnostics,
		extraArguments: [
			...(process.platform === "darwin" ? ["--use-mock-keychain", "--no-sandbox", "--disable-gpu"] : []),
		],
	});
	try {
		const { browser, page } = await connectToApp(debuggingPort, app, environment.diagnostics);
		page.setDefaultTimeout(20_000);
		// Keep the packaged window's native size; this test must not impose a
		// synthetic viewport that hides real desktop layout behavior.
		await waitForServerReady(page);
		return { app, browser, page };
	} catch (error) {
		await stopProcess(app);
		const diagnostics = environment.diagnostics.join("").slice(-12_000);
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
	}
}

/** Resize the actual macOS window without enabling the packaged app's disabled Node inspector.
 * The test runner needs Accessibility permission; the PID targets only its isolated app. */
export async function nativeWindowBounds(app: RunningSubagentApp, bounds?: { width: number; height: number }) {
	if (process.platform !== "darwin") throw new Error("Native resize acceptance currently requires macOS");
	const pid = app.app.pid;
	if (!pid || !Number.isInteger(pid)) throw new Error("Missing isolated app PID");
	if (bounds && (!Number.isInteger(bounds.width) || !Number.isInteger(bounds.height)))
		throw new Error("Expected integer native window dimensions");
	const { stdout } = await promisify(execFile)("osascript", ["-e", `
		tell application "System Events"
			tell first application process whose unix id is ${pid}
				${bounds ? `set size of front window to {${bounds.width}, ${bounds.height}}` : ""}
				get size of front window
			end tell
		end tell
	`], { timeout: 10_000 });
	const [width, height] = stdout.trim().split(",").map(Number);
	if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Invalid native window size: ${stdout}`);
	return { width: width!, height: height! };
}

export async function closeSubagentApp(app: RunningSubagentApp): Promise<void> {
	if (app.app.exitCode === null && app.app.signalCode === null) {
		const session = await app.browser.newBrowserCDPSession().catch(() => undefined);
		if (session) {
			void session.send("Browser.close").catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
	}
	// Chromium's close command can stay pending when Electron intercepts quit.
	// Always settle the isolated process before awaiting the CDP disconnect.
	await stopProcess(app.app);
	await app.browser.close().catch(() => undefined);
}

export async function removeSubagentEnvironment(environment: SubagentEnvironment): Promise<void> {
	await rm(environment.tempRoot, { recursive: true, force: true });
}

export async function upsertSubagentRole(
	page: Page,
	role: {
		readonly id: string;
		readonly displayName: string;
		readonly description: string;
		readonly allowedTools: readonly string[];
		readonly systemPrompt: string;
		readonly writePolicy: "inherit" | "deny";
		readonly mayDelegate: boolean;
	},
): Promise<void> {
	await page.evaluate(async (type) => {
		const api = (globalThis as unknown as DesktopGlobals).metis;
		await api.upsertAgentType({ requestId: crypto.randomUUID(), type: { ...type, allowedTools: [...type.allowedTools] } });
	}, role);
}

export async function upsertFixtureRole(page: Page): Promise<void> {
	await upsertSubagentRole(page, SUBAGENT_CUSTOM_ROLE);
}

export async function sessionModel(
	page: Page,
	sessionId: string,
): Promise<{ provider: string; modelId: string } | undefined> {
	return page.evaluate(async (id) => {
		const api = (globalThis as unknown as DesktopGlobals).metis;
		return (await api.subscribeSession({ sessionId: id })).model ?? undefined;
	}, sessionId);
}

export async function createSubagentSession(
	page: Page,
	environment: SubagentEnvironment,
	mode: SubagentMode,
	name: string,
): Promise<string> {
	const created = await page.evaluate(
		async (input) => {
			const api = (globalThis as unknown as DesktopGlobals).metis;
			const result = await api.createSession({
				requestId: crypto.randomUUID(),
				mode: input.mode,
				cwd: input.cwd,
				name: input.name,
				permissionPreset: "full",
			});
			localStorage.setItem(`metis.activeSessionId.${input.mode}`, result.session.sessionId);
			return result.session.sessionId;
		},
		{ mode, cwd: environment.projectDir, name },
	);
	await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
	await waitForServerReady(page);
	const trust = page.getByRole("heading", { name: "Trust this project?", exact: true });
	if (await trust.isVisible().catch(() => false)) await page.getByRole("button", { name: "Trust", exact: true }).click();
	if (mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
	await expect(page.locator(`[data-active-session-id="${created}"]`)).toBeVisible();
	return created;
}

export async function sendParentPrompt(page: Page, text: string): Promise<void> {
	const composer = page.locator("#composer-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.fill(text);
	await page.getByRole("button", { name: "Send message", exact: true }).click();
}

export async function openAgentConversation(page: Page, agentName: string): Promise<void> {
	const item = page.getByRole("treeitem", { name: agentName, exact: true });
	await expect(item).toBeVisible({ timeout: 30_000 });
	const button = item.locator("button.agent-sidebar-open");
	await expect(button).toBeVisible();
	await button.click();
}

export async function listSubagents(page: Page, sessionId: string): Promise<AgentRecord[]> {
	return page.evaluate(async (id) => {
		const api = (globalThis as unknown as DesktopGlobals).metis;
		return (await api.listAgents({ sessionId: id, limit: 100 })).agents;
	}, sessionId);
}

export async function readSubagentItems(
	page: Page,
	sessionId: string,
	agentId: string,
	taskId?: string,
): Promise<AgentItemRecord[]> {
	return page.evaluate(
		async (input) => {
			const api = (globalThis as unknown as DesktopGlobals).metis;
			return (
				await api.readAgentItems({
					sessionId: input.sessionId,
					agentId: input.agentId,
					...(input.taskId ? { taskId: input.taskId } : {}),
					beforeItemId: null,
					limit: 200,
				})
			).items;
		},
		{ sessionId, agentId, taskId },
	);
}

export async function readSessionItems(page: Page, sessionId: string): Promise<AgentItemRecord[]> {
	return page.evaluate(async (id) => {
		const api = (globalThis as unknown as DesktopGlobals).metis;
		return (await api.readItems({ sessionId: id, beforeItemId: null, limit: 200 })).items;
	}, sessionId);
}

export async function sendSubagentCorrection(
	page: Page,
	sessionId: string,
	agentId: string,
	text: string,
	delivery: "auto" | "steer" | "queue" = "auto",
): Promise<AgentSendReceiptRecord> {
	return page.evaluate(
		async (input) => {
			const api = (globalThis as unknown as DesktopGlobals).metis;
			return api.sendAgentMessage({
				sessionId: input.sessionId,
				agentId: input.agentId,
				requestId: crypto.randomUUID(),
				delivery: input.delivery,
				input: { text: input.text },
			});
		},
		{ sessionId, agentId, text, delivery },
	);
}

export async function controlSubagent(
	page: Page,
	sessionId: string,
	agentId: string,
	action: "stop" | "resume",
	scope: "self" | "subtree" = "self",
): Promise<{ state: string }> {
	return page.evaluate(
		async (input) => {
			const api = (globalThis as unknown as DesktopGlobals).metis;
			return api.controlAgent({
				sessionId: input.sessionId,
				agentId: input.agentId,
				requestId: crypto.randomUUID(),
				action: input.action,
				scope: input.scope,
			});
		},
		{ sessionId, agentId, action, scope },
	);
}

export async function createSubagentModelServer(): Promise<SubagentModelServer> {
	const requests: SubagentModelRequest[] = [];
	const providerServer: Server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		try {
			const payload = (await readJson(request)) as SubagentModelMessagePayload;
			const messages = modelMessages(payload);
			const system = messages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => contentText(message.content))
				.join("\n\n");
			const userTexts = messages
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content));
			const allTexts = messages.map((message) => contentText(message.content));
			const identity = parseAgentIdentity(system);
			const isChild = system.includes("<agent_contract>") && identity !== undefined;
			const toolNames = (payload.tools ?? [])
				.map((tool) => tool.name ?? tool.function?.name)
				.filter((name): name is string => typeof name === "string");
			const spawnNames = toolNamesOf(messages);
			const mailboxEvents = mailboxEventsIn(allTexts);
			const record: SubagentModelRequest = {
				index: requests.length,
				at: Date.now(),
				model: payload.model ?? "",
				isChild,
				...(identity ?? {}),
				system,
				messages,
				toolNames,
				userTexts,
				mailboxEvents,
				spawnNames,
			};
			requests.push(record);
			if (system.includes("conversation title generator")) {
				modelText(response, record.model, "Subagent fixture task");
				return;
			}
				if (!isChild && userTexts.at(-1)?.includes(SUBAGENT_FIXTURE.providerFailure)) {
					response.writeHead(503, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: "Fixture provider unavailable (no sensitive data)." } }));
					return;
				}
				if (!isChild && userTexts.at(-1)?.includes(SUBAGENT_FIXTURE.providerRecovery)) {
					modelText(response, record.model, "provider-recovery-complete");
					return;
				}
			if (isChild) {
				respondChild(record, userTexts, response);
				return;
			}
			respondParent(record, userTexts, response);
		} catch (error) {
			response.writeHead(500, { "content-type": "text/plain" });
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
	const port = await listen(providerServer);
	return {
		port,
		requests,
		close: () => closeServer(providerServer),
	};
}

function respondChild(
	request: SubagentModelRequest,
	userTexts: readonly string[],
	response: ServerResponse,
): void {
	const model = request.model;
	const correction = userTexts.find((text) => text.includes("CORRECTION-ALPHA"));
	const hasAssistant = request.messages.some((message) => message.role === "assistant");
	const stopScenario = request.system.includes(SUBAGENT_FIXTURE.stopName);
	if (correction) {
		modelText(response, model, `child-final alpha | ${correction}`);
		return;
	}
	if (stopScenario) {
		if (!hasAssistant) {
			modelToolCalls(response, model, [
				{
					callId: "child-stop-hold",
					name: "bash",
					arguments: { command: "sleep 60", description: "Hold the stopped child task" },
				},
			]);
			return;
		}
		modelText(response, model, "child-final stopped");
		return;
	}
	if (!hasAssistant) {
		const hold = request.agentName === SUBAGENT_FIXTURE.alphaName ? 45 : 50;
		modelToolCalls(response, model, [
			{
				callId: `child-${request.agentId}-native-search`,
				name: "grep",
				arguments: { pattern: "evidence marker", path: "README.md" },
			},
			{
				callId: `child-${request.agentId}-hold`,
				name: "bash",
				arguments: { command: `sleep ${hold}`, description: "Hold the child task while the user intervenes" },
			},
		]);
		return;
	}
	modelText(
		response,
		model,
		request.agentName === SUBAGENT_FIXTURE.alphaName ? "child-final alpha | no-correction" : "child-final beta | complete",
	);
}

function respondParent(
	request: SubagentModelRequest,
	userTexts: readonly string[],
	response: ServerResponse,
): void {
	const model = request.model;
	const start = userTexts.some((text) => text.includes(SUBAGENT_FIXTURE.start));
	const stop = userTexts.some((text) => text.includes(SUBAGENT_FIXTURE.stop));
	const spawned = request.spawnNames.includes("spawn_agent");
	const intervention = request.mailboxEvents.find((event) => event.type === "intervention");
	if (intervention) {
		modelText(response, model, `parent-saw-intervention ${intervention.text ?? ""}`);
		return;
	}
	if (!spawned && stop) {
		modelToolCalls(response, model, [
			{
				callId: "spawn-stop",
				name: "spawn_agent",
				arguments: {
					name: SUBAGENT_FIXTURE.stopName,
					task: SUBAGENT_FIXTURE.stopTask,
					agentType: "worker",
				},
			},
		]);
		return;
	}
	if (!spawned && start) {
		modelToolCalls(response, model, [
			{
				callId: "spawn-alpha",
				name: "spawn_agent",
				arguments: {
					name: SUBAGENT_FIXTURE.alphaName,
					task: SUBAGENT_FIXTURE.alphaTask,
					agentType: "worker",
				},
			},
			{
				callId: "spawn-beta",
				name: "spawn_agent",
				arguments: {
					name: SUBAGENT_FIXTURE.betaName,
					task: SUBAGENT_FIXTURE.betaTask,
					agentType: SUBAGENT_CUSTOM_ROLE.id,
				},
			},
		]);
		return;
	}
	modelText(response, model, spawned ? "parent-independent-work-complete" : "parent-idle");
}

export async function waitForModelRequest(
	server: { readonly requests: readonly SubagentModelRequest[] },
	predicate: (request: SubagentModelRequest) => boolean,
	timeoutMs = 30_000,
): Promise<SubagentModelRequest> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = server.requests.find(predicate);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for model request after ${timeoutMs}ms; saw ${server.requests.length} requests`);
}

export function modelRequestSummary(server: Pick<SubagentModelServer, "requests">): unknown {
	return server.requests.map((request) => ({
		index: request.index,
		at: request.at,
		isChild: request.isChild,
		agentId: request.agentId,
		agentName: request.agentName,
		model: request.model,
		userTexts: request.userTexts,
		assistantTexts: request.messages
			.filter((message) => message.role === "assistant")
			.map((message) => contentText(message.content)),
		toolResults: request.messages
			.filter((message) => message.role === "tool")
			.map((message) => contentText(message.content)),
		toolNames: request.toolNames,
		mailboxEvents: request.mailboxEvents,
		roleCatalog: request.system.includes("<agent_coordination>"),
		childContract: request.system.includes("<agent_contract>"),
		roleInstructions: request.system.includes("<agent_role_instructions>"),
	}));
}

export async function saveSubagentEvidence(
	testInfo: TestInfo,
	name: string,
	value: unknown,
): Promise<void> {
	await writeFile(testInfo.outputPath(name), JSON.stringify(value, null, 2));
}

/**
 * Passive reverse proxy for the configured real model. Tests never read the
 * credential into evidence; headers stay in memory and are only forwarded.
 */
export interface RealModelProxy {
	readonly url: string;
	readonly requests: SubagentModelRequest[];
	readonly close: () => Promise<void>;
}

export async function createRealModelProxy(upstreamBaseUrl: string): Promise<RealModelProxy> {
	const requests: SubagentModelRequest[] = [];
	const server: Server = createServer(async (request, response) => {
		const controller = new AbortController();
		response.once("close", () => {
			if (!response.writableEnded) controller.abort();
		});
		try {
			const body = await readJson(request).catch(() => undefined);
			const payload = (body ?? {}) as SubagentModelMessagePayload;
			const messages = modelMessages(payload);
			const system = messages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => contentText(message.content))
				.join("\n\n");
			const userTexts = messages
				.filter((message) => message.role === "user")
				.map((message) => contentText(message.content));
			const allTexts = messages.map((message) => contentText(message.content));
			const identity = parseAgentIdentity(system);
			const toolNames = (payload.tools ?? [])
				.map((tool) => tool.name ?? tool.function?.name)
				.filter((name): name is string => typeof name === "string");
			requests.push({
				index: requests.length,
				at: Date.now(),
				model: payload.model ?? "",
				isChild: system.includes("<agent_contract>") && identity !== undefined,
				...(identity ?? {}),
				system,
				messages,
				toolNames,
				userTexts,
				mailboxEvents: mailboxEventsIn(allTexts),
				spawnNames: toolNamesOf(messages),
			});
			const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			const suffix = pathname.replace(/^\/v1\/?/u, "");
			const target = `${upstreamBaseUrl.replace(/\/$/u, "")}/${suffix}`;
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers)) {
				if (value === undefined || ["host", "connection", "content-length"].includes(name)) continue;
				headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const upstream = await fetch(target, {
				method: request.method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const responseHeaders: Record<string, string> = {
				"content-type": upstream.headers.get("content-type") ?? "application/json",
			};
			const cacheControl = upstream.headers.get("cache-control");
			if (cacheControl) responseHeaders["cache-control"] = cacheControl;
			response.writeHead(upstream.status, responseHeaders);
			if (!upstream.body) {
				response.end();
				return;
			}
			const reader = upstream.body.getReader();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				response.write(value);
			}
			response.end();
		} catch (error) {
			if (response.destroyed) return;
			if (response.headersSent) {
				response.destroy();
				return;
			}
			response.writeHead(502, { "content-type": "text/plain" });
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
	const port = await listen(server);
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => closeServer(server),
	};
}

export interface RealModelConfig {
	readonly providerId: string;
	readonly modelId: string;
	readonly provider: {
		readonly baseUrl: string;
		readonly apiKey?: string;
		readonly api?: string;
	};
	readonly providerConfig: Readonly<Record<string, unknown>>;
	readonly modelConfig: Readonly<Record<string, unknown>>;
	readonly credential: unknown;
}

export async function loadRealModelConfig(configDir: string): Promise<RealModelConfig> {
	if (!path.isAbsolute(configDir)) throw new Error("METIS_SUBAGENT_MODEL_CONFIG_DIR must be absolute");
	const [models, settings, auth] = await Promise.all(
		["models.json", "settings.json", "auth.json"].map(async (name) =>
			JSON.parse(await readFile(path.join(configDir, name), "utf8")),
		),
	);
	const providerId: string = settings.defaultProvider;
	const modelId: string = settings.defaultModel;
	const provider = models.providers?.[providerId];
	const modelConfig = provider?.models?.find((model: { id?: string }) => model.id === modelId);
	if (!provider || !modelConfig) throw new Error("Configured provider/model is missing from models.json");
	const credential = auth?.[providerId];
	if (credential?.type !== "api_key" || typeof credential.key !== "string" || !credential.key)
		throw new Error("Configured provider requires an api_key credential in auth.json");
	const { baseUrl, models: _models, ...providerConfig } = provider as Record<string, unknown>;
	void _models;
	if (typeof baseUrl !== "string") throw new Error("Configured provider has no baseUrl");
	if (typeof provider.api === "string" && !["openai-completions", "openai-responses"].includes(provider.api))
		throw new Error("The real subagent acceptance test supports OpenAI Completions and Responses APIs");
	return {
		providerId,
		modelId,
		provider: {
			baseUrl,
			...(typeof provider.apiKey === "string" ? { apiKey: provider.apiKey } : {}),
			...(typeof provider.api === "string" ? { api: provider.api } : {}),
		},
		providerConfig,
		modelConfig: modelConfig as Readonly<Record<string, unknown>>,
		credential,
	};
}
