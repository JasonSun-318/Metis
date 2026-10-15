import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import {
	closeServer,
	connectToApp,
	createAndRestoreChatSession,
	latestToolResult,
	launchPackagedDesktop,
	listen,
	messageText,
	packagedExecutable,
	readOpenAiChatRequest,
	reservePort,
	respondWithText,
	respondWithToolCall,
	stopProcess,
	waitForServerReady,
	type OpenAiChatMessage,
} from "./packaged-app-harness.ts";

export interface BrowserScriptContext {
	readonly step: number;
	readonly messages: readonly OpenAiChatMessage[];
	readonly lastResult: string;
	readonly origin: string;
	readonly frameOrigin: string;
}

export type BrowserScriptInstruction =
	| { readonly tool: string; readonly arguments: object }
	| { readonly text: string };

export type BrowserScript = (
	context: BrowserScriptContext,
) => BrowserScriptInstruction | Promise<BrowserScriptInstruction>;

export interface BrowserToolTrace {
	readonly callId: string;
	readonly marker: string;
	readonly name: string;
	readonly arguments: object;
	readonly issuedAt: number;
	completedAt?: number;
	result?: string;
}

export interface BrowserAgentFixture {
	readonly origin: string;
	readonly frameOrigin: string;
	readonly providerPort: number;
	readonly requests: string[];
	readonly calls: BrowserToolTrace[];
	readonly deleteCount: () => number;
	readonly staleActionCount: () => number;
	setScript(marker: string, script: BrowserScript): void;
	close(): Promise<void>;
}

export interface BrowserAgentEnvironment {
	readonly tempRoot: string;
	readonly agentDir: string;
	readonly homeDir: string;
	readonly projectDir: string;
	readonly userDataDir: string;
	readonly diagnostics: string[];
}

export interface RunningBrowserAgentApp {
	readonly app: ChildProcess;
	readonly browser: Browser;
	readonly page: Page;
	readonly sessionId: string;
}

export async function createBrowserAgentEnvironment(
	providerPort: number,
	importedProfiles: readonly { readonly profileId: string; readonly name: string; readonly sourceProfileId: string }[] = [],
): Promise<BrowserAgentEnvironment> {
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-browser-agent-"));
	const environment: BrowserAgentEnvironment = {
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
	await Promise.all([
		writeFile(path.join(environment.agentDir, "models.json"), JSON.stringify({ providers: {
			browserFixture: {
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				apiKey: "browser-fixture-key",
				api: "openai-completions",
				models: [{
					id: "browser-agent-fixture",
					name: "Browser Agent Fixture",
					input: ["text", "image"],
					contextWindow: 1_000_000,
					maxTokens: 4_096,
				}],
			},
		} }, null, 2)),
		writeFile(path.join(environment.agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "browserFixture",
			defaultModel: "browser-agent-fixture",
			retry: { enabled: false },
		}, null, 2)),
		...(importedProfiles.length > 0 ? [writeFile(
			path.join(environment.userDataDir, "browser-profiles.json"),
			JSON.stringify({
				schemaVersion: 1,
				profiles: importedProfiles.map((profile) => ({
					...profile,
					sourceId: "chrome",
				})),
			}, null, 2),
		)] : []),
	]);
	return environment;
}

export async function launchBrowserAgentApp(
	environment: BrowserAgentEnvironment,
	options: { readonly createSession?: boolean } = {},
): Promise<RunningBrowserAgentApp> {
	const debuggingPort = await reservePort();
	const app = launchPackagedDesktop({
		executable: packagedExecutable(),
		debuggingPort,
		userDataDir: environment.userDataDir,
		projectDir: environment.projectDir,
		agentDir: environment.agentDir,
		homeDir: environment.homeDir,
		diagnostics: environment.diagnostics,
		extraArguments: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
	});
	try {
		const { browser, page } = await connectToApp(debuggingPort);
		page.setDefaultTimeout(12_000);
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		if (options.createSession === false) {
			const sessionId = await page.locator("[data-active-session-id]").getAttribute("data-active-session-id");
			if (!sessionId) throw new Error("Restarted browser fixture did not restore its task");
			return { app, browser, page, sessionId };
		}
		const sessionId = await createAndRestoreChatSession(page, environment.projectDir, false);
		const trust = page.getByRole("heading", { name: "Trust this project?", exact: true });
		if (await trust.isVisible().catch(() => false)) await page.getByRole("button", { name: "Trust", exact: true }).click();
		await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
		return { app, browser, page, sessionId };
	} catch (error) {
		await stopProcess(app);
		throw error;
	}
}

export async function closeBrowserAgentApp(app: RunningBrowserAgentApp): Promise<void> {
	if (app.app.exitCode === null && app.app.signalCode === null) {
		const session = await app.browser.newBrowserCDPSession().catch(() => undefined);
		if (session) {
			void session.send("Browser.close").catch(() => undefined);
			await Promise.race([once(app.app, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
		}
	}
	await app.browser.close().catch(() => undefined);
	await stopProcess(app.app);
}

export async function removeBrowserAgentEnvironment(environment: BrowserAgentEnvironment): Promise<void> {
	await rm(environment.tempRoot, { recursive: true, force: true });
}

export async function sendFixturePrompt(page: Page, marker: string): Promise<void> {
	const composer = page.locator("#composer-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.fill(marker);
	await page.getByRole("button", { name: "Send message", exact: true }).click();
}

function html(body: string, script = ""): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Metis browser fixture</title>
<style>body{font:16px system-ui;margin:24px}button,input,select,a{font:inherit;margin:6px;padding:8px}iframe{display:block;width:520px;height:180px;border:1px solid #888;margin:12px 0}.spacer{height:900px}</style></head>
<body>${body}<script>${script}</script></body></html>`;
}

function controlsPage(frameOrigin: string): string {
	return html(
		`<main>
			<h1>Browser control fixture</h1>
			<button id="increment" type="button">Increment</button>
			<output id="count" aria-live="polite">Count: 0</output>
			<label>Message <input id="message" aria-label="Message"></label>
			<output id="message-status" aria-live="polite">Message: empty</output>
			<label>Theme <select id="theme" aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
			<output id="theme-status">Theme: light</output>
			<a id="oauth" href="/oauth" target="_blank" rel="opener">Open OAuth popup</a>
			<output id="oauth-status">OAuth: pending</output>
			<iframe title="Cross-origin controls" src="${frameOrigin}/frame"></iframe>
			<div class="spacer" aria-hidden="true"></div>
			<button id="bottom" type="button">Bottom action</button>
			<output id="bottom-status">Bottom: pending</output>
		</main>`,
		`let count=0;
		document.querySelector('#increment').addEventListener('click',()=>{document.querySelector('#count').textContent='Count: '+(++count)});
		const message=document.querySelector('#message');
		message.addEventListener('keydown',(event)=>{if(event.key==='Enter')document.querySelector('#message-status').textContent='Message: '+message.value});
		document.querySelector('#theme').addEventListener('change',(event)=>{document.querySelector('#theme-status').textContent='Theme: '+event.target.value});
		document.querySelector('#bottom').addEventListener('click',()=>{document.querySelector('#bottom-status').textContent='Bottom: complete'});
		window.addEventListener('message',(event)=>{if(event.data==='oauth-complete')document.querySelector('#oauth-status').textContent='OAuth: complete'});`,
	);
}

function framePage(): string {
	return html(
		`<main><h1>Frame fixture</h1><button id="frame-action" type="button">Frame action</button><output id="frame-status">Frame: pending</output></main>`,
		`document.querySelector('#frame-action').addEventListener('click',()=>{document.querySelector('#frame-status').textContent='Frame: complete'});`,
	);
}

function oauthPage(): string {
	return html(
		`<main><h1>Mock OAuth</h1><button id="authorize" type="button">Authorize</button></main>`,
		`document.querySelector('#authorize').addEventListener('click',()=>{window.opener?.postMessage('oauth-complete','*');window.close()});`,
	);
}

function handoffPage(reason: string): string {
	const input = reason === "login" ? '<label>Password <input id="secret" aria-label="Password" type="password"></label>' : "";
	return html(
		`<main><h1>${reason} challenge</h1>${input}<button id="complete" type="button">Complete ${reason}</button><output id="handoff-status">Challenge: pending</output></main>`,
		`document.querySelector('#complete').addEventListener('click',()=>{document.querySelector('#handoff-status').textContent='Challenge: complete';document.cookie='handoff-${reason}=complete; Max-Age=3600; Path=/; SameSite=Lax'});`,
	);
}

function destructivePage(): string {
	return html(
		`<main><h1>Destructive fixture</h1><button id="delete" type="button">Delete fixture record</button><output id="delete-status">Delete count: 0</output></main>`,
		`document.querySelector('#delete').addEventListener('click',async()=>{const response=await fetch('/delete',{method:'POST'});document.querySelector('#delete-status').textContent=await response.text()});`,
	);
}

function requestPath(url: string | undefined): URL {
	return new URL(url ?? "/", "http://fixture.invalid");
}

export function parseToolJson(result: string): Record<string, unknown> {
	const json = result.split("\n").find((line) => line.trimStart().startsWith("{"));
	if (!json) throw new Error(`Expected a JSON tool result: ${result}`);
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON tool result: ${result}`);
	return parsed as Record<string, unknown>;
}

export function elementId(state: unknown, accessibleName: string): string {
	if (typeof state !== "string") throw new Error("Browser observation did not contain accessibility state");
	const escaped = accessibleName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = state.match(new RegExp(`\\b(e[1-9][0-9]{0,5})\\s+[^\\n]*"${escaped}"`, "u"));
	if (!match?.[1]) throw new Error(`Could not find ${accessibleName} in browser state:\n${state}`);
	return match[1];
}

export function observationInput(result: string) {
	const parsed = parseToolJson(result);
	// A stale envelope still carries the freshest observation; unwrap it so
	// follow-up actions bind to the newest document revision.
	const observation = (
		parsed.status === "stale" && typeof parsed.observation === "object" && parsed.observation !== null
			? parsed.observation
			: parsed
	) as Record<string, unknown>;
	if (
		typeof observation.browserId !== "string" ||
		typeof observation.documentId !== "string" ||
		typeof observation.revision !== "number" ||
		typeof observation.url !== "string"
	) {
		throw new Error(`Expected a browser observation: ${result}`);
	}
	const url = new URL(String(observation.url));
	return {
		browserId: String(observation.browserId),
		documentId: String(observation.documentId),
		snapshotRevision: Number(observation.revision),
		origin: url.origin,
		observation,
	};
}

export async function createBrowserAgentFixture(): Promise<BrowserAgentFixture> {
	let frameOrigin = "";
	let deleteCount = 0;
	let staleActionCount = 0;
	const frameServer = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(framePage());
	});
	const framePort = await listen(frameServer);
	frameOrigin = `http://localhost:${framePort}`;

	const pageServer = createServer((request, response) => {
		const url = requestPath(request.url);
		if (request.method === "POST" && url.pathname === "/delete") {
			deleteCount += 1;
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			response.end(`Delete count: ${deleteCount}`);
			return;
		}
		if (request.method === "POST" && url.pathname === "/stale-hit") {
			staleActionCount += 1;
			response.writeHead(204).end();
			return;
		}
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (url.pathname === "/controls") response.end(controlsPage(frameOrigin));
		else if (url.pathname === "/navigation") response.end(html(
			`<main><h1>Navigation fixture</h1><a href="/navigation-done?from=visible">Open destination</a><div style="height:2400px" aria-hidden="true"></div><a href="/navigation-done?from=below-fold">Open lower destination</a></main>`,
		));
		else if (url.pathname === "/navigation-done") response.end(html(
			`<main><h1>Navigation complete</h1><p id="navigation-source">${url.searchParams.get("from")}</p></main>`,
		));
		else if (url.pathname === "/popup-fixture") response.end(html(
			`<main><h1>Popup fixture</h1><a id="oauth" href="/oauth" target="_blank" rel="opener">Open OAuth popup</a><output id="oauth-status">OAuth: pending</output></main>`,
			`window.addEventListener('message',(event)=>{if(event.data==='oauth-complete')document.querySelector('#oauth-status').textContent='OAuth: complete'});`,
		));
		else if (url.pathname === "/frame") response.end(framePage());
		else if (url.pathname === "/oauth") response.end(oauthPage());
		else if (url.pathname === "/destructive") response.end(destructivePage());
		else if (url.pathname === "/stale") response.end(html(
			`<main><h1>Stale fixture ${url.searchParams.get("v") ?? "1"}</h1><button id="stale" type="button">Stale action</button></main>`,
			`document.querySelector('#stale').addEventListener('click',()=>fetch('/stale-hit',{method:'POST'}));`,
		));
		else if (url.pathname.startsWith("/handoff/")) response.end(handoffPage(url.pathname.slice("/handoff/".length)));
		else if (url.pathname === "/set-cookie") {
			const value = url.searchParams.get("value") ?? "missing";
			response.setHeader("set-cookie", `profile=${encodeURIComponent(value)}; Max-Age=3600; Path=/; SameSite=Lax`);
			response.end(html(`<main><h1>Cookie stored</h1><p>${value}</p></main>`));
		} else if (url.pathname === "/cookie") {
			response.end(html(`<main><h1>Cookie check</h1><p>${request.headers.cookie ?? "missing"}</p></main>`));
		} else if (url.pathname === "/slow") {
			setTimeout(() => {
				if (!response.destroyed) response.end(html("<main><h1>Slow fixture complete</h1></main>"));
			}, 10_000).unref();
		} else response.writeHead(404).end("missing");
	});
	const pagePort = await listen(pageServer);
	const origin = `http://127.0.0.1:${pagePort}`;

	const scripts = new Map<string, BrowserScript>();
	const steps = new Map<string, number>();
	const requests: string[] = [];
	const calls: BrowserToolTrace[] = [];
	const completedCallIds = new Set<string>();
	const providerServer: Server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const payload = await readOpenAiChatRequest(request);
		const messages = payload.messages ?? [];
		requests.push(JSON.stringify(payload));
		for (const message of messages) {
			if (message.role !== "tool" || !message.tool_call_id || completedCallIds.has(message.tool_call_id)) continue;
			const call = calls.find((candidate) => candidate.callId === message.tool_call_id);
			if (!call) continue;
			call.completedAt = Date.now();
			call.result = messageText(message.content);
			completedCallIds.add(message.tool_call_id);
		}
		const transcript = JSON.stringify(messages);
		if (transcript.includes("conversation title generator")) {
			respondWithText(response, "Browser agent fixture");
			return;
		}
		const marker = [...messages]
			.reverse()
			.filter((message) => message.role === "user")
			.map((message) => messageText(message.content))
			.map((text) => [...scripts.keys()].find((candidate) => text.includes(candidate)))
			.find((candidate): candidate is string => candidate !== undefined);
		if (!marker) {
			respondWithText(response, "No browser fixture script matched.");
			return;
		}
		const step = steps.get(marker) ?? 0;
		const instruction = await scripts.get(marker)!({
			step,
			messages,
			lastResult: latestToolResult(messages),
			origin,
			frameOrigin,
		});
		steps.set(marker, step + 1);
		if ("text" in instruction) {
			respondWithText(response, instruction.text);
			return;
		}
		const callId = `browser-${marker.replace(/[^a-z0-9-]/giu, "-")}-${step}`;
		calls.push({
			callId,
			marker,
			name: instruction.tool,
			arguments: instruction.arguments,
			issuedAt: Date.now(),
		});
		respondWithToolCall(response, { callId, name: instruction.tool, arguments: instruction.arguments });
	});
	const providerPort = await listen(providerServer);

	return {
		origin,
		frameOrigin,
		providerPort,
		requests,
		calls,
		deleteCount: () => deleteCount,
		staleActionCount: () => staleActionCount,
		setScript(marker, script) {
			if (scripts.has(marker)) throw new Error(`Browser fixture script already exists: ${marker}`);
			scripts.set(marker, script);
		},
		async close() {
			await Promise.all([closeServer(providerServer), closeServer(pageServer), closeServer(frameServer)]);
		},
	};
}
