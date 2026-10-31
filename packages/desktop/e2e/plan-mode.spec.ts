import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	appServerPid,
	connectToApp,
	desktopRoot,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

interface ProviderPayload {
	readonly messages?: unknown[];
	readonly tools?: Array<{ function?: { name?: string }; name?: string }>;
}

function transcript(payload: ProviderPayload): string {
	return JSON.stringify(payload.messages ?? []);
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content);
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return JSON.stringify(block);
			const text = Reflect.get(block, "text");
			if (typeof text === "string") return text;
			const inputText = Reflect.get(block, "input_text");
			if (typeof inputText === "string") return inputText;
			return JSON.stringify(block);
		})
		.join("");
}

async function enterPlanMode(page: Page): Promise<void> {
	const input = page.locator("#composer-input");
	await expect(input).toHaveAttribute("contenteditable", "true");
	await input.fill("/plan");
	await page.getByRole("option").filter({ hasText: "/plan" }).click();
	await expect(page.getByRole("button", { name: "Exit Plan mode", exact: true })).toBeEnabled();
}

function lastUserText(payload: ProviderPayload): string {
	const messages = payload.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		if (Reflect.get(message, "role") !== "user") continue;
		const text = messageText(Reflect.get(message, "content"));
		// Hidden plan context is serialized as a user message after the actual request.
		if (text.startsWith('{"planId":') && text.includes('"markdown":')) continue;
		return text;
	}
	return "";
}

function hasUserText(payload: ProviderPayload, text: string): boolean {
	return transcript(payload).includes(text);
}

function hasToolResult(payload: ProviderPayload, toolCallId: string): boolean {
	return transcript(payload).includes(toolCallId);
}

function isPlanExecutionTurn(payload: ProviderPayload): boolean {
	return lastUserText(payload).includes("Execute the accepted plan");
}

function toolNames(payload: ProviderPayload): string[] {
	return (payload.tools ?? [])
		.map((tool) => tool.function?.name ?? tool.name)
		.filter((name): name is string => Boolean(name));
}

function sseToolCall(id: string, name: string, args: Record<string, unknown>): string {
	return `data: ${JSON.stringify({
		id: `plan-${id}`,
		object: "chat.completion.chunk",
		created: 1,
		model: "plan-model",
		choices: [{
			index: 0,
			delta: {
				role: "assistant",
				tool_calls: [{
					index: 0,
					id,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				}],
			},
			finish_reason: "tool_calls",
		}],
	})}\n\ndata: [DONE]\n\n`;
}

function sseText(text: string): string {
	return `data: ${JSON.stringify({
		id: "plan-text",
		object: "chat.completion.chunk",
		created: 1,
		model: "plan-model",
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
	})}\n\ndata: [DONE]\n\n`;
}

async function createCodeSession(page: Page, sessionId: string): Promise<void> {
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.keyboard.press("Escape");
	await page.locator(".project-list .session-button").first().click();
	await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
}

interface CodingFixtures {
	readonly SessionManager: {
		create(cwd: string, sessionDir: string, options: { id: string; mode: "code"; permissionPreset: "full" }): {
			appendSessionInfo(name: string): void;
			getSessionFile(): string | undefined;
			close(): void;
		};
	};
	readonly ProjectTrustStore: new (agentDir: string) => { set(cwd: string, trusted: boolean): void };
	readonly getDefaultSessionDir: (cwd: string, agentDir: string) => string;
}

async function loadCodingFixtures(): Promise<CodingFixtures> {
	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	return {
		SessionManager: (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)).SessionManager as CodingFixtures["SessionManager"],
		ProjectTrustStore: (await importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href)).ProjectTrustStore as CodingFixtures["ProjectTrustStore"],
		getDefaultSessionDir: (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)).getDefaultSessionDir as CodingFixtures["getDefaultSessionDir"],
	};
}

async function expectCompletedPlanTurn(page: Page, sessionFile: string, toolCallId: string): Promise<void> {
	await expect.poll(async () => {
		const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		const result = entries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId);
		return entries.reverse().find((entry) => entry.type === "runtime_turn" && entry.turnId === result?.turnId)?.state;
	}, { timeout: 20_000 }).toBe("completed");
	await expect(page.getByText("Task stopped", { exact: true })).toHaveCount(0);
}

test("packaged plan mode explores, revises, recovers, executes, and cancels", async () => {
	test.setTimeout(240_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const fixtures = await loadCodingFixtures();
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-plan-mode-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	const planWritePath = path.join(projectDir, "plan-write.txt");
	const acceptedWritePath = path.join(projectDir, "greeting.txt");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	const sessionId = "91000000-0000-4000-8000-000000000001";
	const manager = fixtures.SessionManager.create(
		projectDir,
		fixtures.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "code", permissionPreset: "full" },
	);
	manager.appendSessionInfo("Plan mode fixture");
	const sessionFile = manager.getSessionFile()!;
	manager.close();
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const providerPayloads: ProviderPayload[] = [];
	let providerStage: "idle" | "awaiting-bash-1" = "idle";
	let bash1Id = "";
	let plan2Submitted = false;
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as ProviderPayload;
		if (transcript(payload).includes("conversation title generator")) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sseText("Plan mode fixture"));
			return;
		}
		providerPayloads.push(payload);
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (lastUserText(payload).includes("Try submit_plan outside Plan mode")) {
			response.end(hasToolResult(payload, "call-submit-outside-plan")
				? sseText("Please enable Plan mode before submitting a plan.")
				: sseToolCall("call-submit-outside-plan", "submit_plan", { title: "Not in Plan", markdown: "# This must not create a proposal" }));
			return;
		}
		if (providerStage === "awaiting-bash-1" && hasToolResult(payload, bash1Id)) {
			providerStage = "idle";
			response.end(
				sseToolCall("call-submit-plan-1", "submit_plan", {
					title: "Add safe greeting",
					markdown: "# Goal\n\nAdd a greeting without changing unrelated files.\n\n## Steps\n\n1. Add the greeting.\n2. Run the focused test.",
				}),
			);
			return;
		}
		if (
			hasUserText(payload, "Use a friendlier greeting") &&
			!transcript(payload).includes("call-submit-plan-2") &&
			!plan2Submitted
		) {
			plan2Submitted = true;
			response.end(
				sseToolCall("call-submit-plan-2", "submit_plan", {
					title: "Add friendly greeting",
					markdown: "# Goal\n\nAdd a friendlier greeting.\n\n## Steps\n\n1. Update the greeting.\n2. Run the focused test.",
				}),
			);
			return;
		}
		if (
			plan2Submitted &&
			(lastUserText(payload).includes("Draft another safe plan") || hasUserText(payload, "Draft another safe plan")) &&
			!transcript(payload).includes("call-submit-plan-3") &&
			!lastUserText(payload).includes("Use a friendlier greeting")
		) {
			response.end(
				sseToolCall("call-submit-plan-3", "submit_plan", {
					title: "Draft another safe plan",
					markdown: "# Goal\n\nDraft another safe plan.\n\n## Steps\n\n1. Keep the greeting safe.\n2. Run the focused test.",
				}),
			);
			return;
		}
		const latestUserText = lastUserText(payload);
		if (isPlanExecutionTurn(payload)) {
			response.end(hasToolResult(payload, "call-execute-plan")
				? sseText("Execution received the accepted revision.")
				: sseToolCall("call-execute-plan", "write", { path: acceptedWritePath, content: "Hello, friend!\n" }));
			return;
		}
		if (latestUserText.includes("Create a safe plan") && providerStage === "idle" && !plan2Submitted) {
			bash1Id = "call-plan-bash-1";
			providerStage = "awaiting-bash-1";
			response.end(sseToolCall(bash1Id, "bash", { command: "printf forbidden > plan-write.txt" }));
			return;
		}
		response.end(sseText("Plan exploration complete."));
	});
	const providerPort = await listen(fakeProvider);
	await Promise.all([
		writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			plan: {
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				apiKey: "plan-key",
				api: "openai-completions",
				models: [{ id: "plan-model", name: "Plan Model", contextWindow: 32_000, maxTokens: 1_024 }],
			},
		} })),
		writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "plan",
			defaultModel: "plan-model",
			retry: { enabled: false },
		})),
	]);

	const debuggingPort = await reservePort();
	const app = spawn(executable, [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`], {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			METIS_CODING_AGENT_DIR: agentDir,
			HOME: homeDir,
			USERPROFILE: homeDir,
			METIS_UPDATE_BASE_URL: "",
			ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
		},
		stdio: "ignore",
	});
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(20_000);
		await page.setViewportSize({ width: 1280, height: 900 });
		await waitForServerReady(page);
		phase = "opening code session";
		await createCodeSession(page, sessionId);

		phase = "checking submit_plan outside Plan mode";
		const input = page.locator("#composer-input");
		await expect(input).toHaveAttribute("contenteditable", "true");
		await input.fill("Try submit_plan outside Plan mode");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.getByText("Please enable Plan mode before submitting a plan.", { exact: true })).toBeVisible();
		await expect(page.locator(".plan-card")).toHaveCount(0);
		const defaultTools = toolNames(providerPayloads[0]!);
		expect(defaultTools).toContain("submit_plan");
		const feedbackPayload = providerPayloads.find((payload) => transcript(payload).includes("You are not in Plan mode"));
		expect(feedbackPayload).toBeDefined();
		expect(transcript(feedbackPayload!)).toContain("call-submit-outside-plan");
		expect(transcript(feedbackPayload!)).toContain('"name":"submit_plan"');

		phase = "entering plan mode";
		await enterPlanMode(page);
		const exitPlanMode = page.getByRole("button", { name: "Exit Plan mode", exact: true });
		const leadingClasses = await page.locator(".composer-leading > *").evaluateAll((elements) =>
			elements.slice(0, 3).map((element) => element.className),
		);
		expect(leadingClasses[0]).toContain("composer-add");
		expect(leadingClasses[1]).toContain("permission-selector");
		expect(leadingClasses[2]).toContain("collaboration-mode-control");
		await expect(exitPlanMode.locator(".collaboration-mode-active-icon")).toHaveCSS("opacity", "1");
		await expect(exitPlanMode.locator(".collaboration-mode-exit-icon")).toHaveCSS("opacity", "0");
		await exitPlanMode.hover();
		await expect(exitPlanMode.locator(".collaboration-mode-active-icon")).toHaveCSS("opacity", "0");
		await expect(exitPlanMode.locator(".collaboration-mode-exit-icon")).toHaveCSS("opacity", "1");
		await exitPlanMode.click();
		await expect(exitPlanMode).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Select permissions, current Full", exact: true })).toBeVisible();
		await enterPlanMode(page);

		phase = "creating first plan";
		await expect(input).toHaveAttribute("contenteditable", "true");
		await input.fill("Create a safe plan");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card")).toHaveCount(1, { timeout: 60_000 });
		expect(existsSync(planWritePath)).toBe(false);
		await expectCompletedPlanTurn(page, sessionFile, "call-submit-plan-1");

		const explorationPayload = providerPayloads.find((payload) => lastUserText(payload).includes("Create a safe plan"))!;
		const explorationTools = toolNames(explorationPayload);
		expect(explorationTools).toEqual(expect.arrayContaining(["read", "bash", "ask_user", "submit_plan"]));
		expect(explorationTools).toEqual(expect.arrayContaining(["edit", "write", "set_tasks"]));
		expect([...explorationTools].sort()).toEqual([...defaultTools].sort());

		await expect(page.locator(".plan-card-body")).toHaveCount(0);
		await page.locator('[data-plan-action="open"]').click();
		await expect(page.locator(".plan-preview")).toContainText("Add safe greeting");

		phase = "recovering before revision";
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(page);
		await createCodeSession(page, sessionId);
		await expect(page.locator(".plan-card").last()).toContainText("Proposed");

		phase = "revising plan";
		await page.locator('[data-plan-action="revise"]').click();
		await expect(page.locator(".composer-plan-revision-chip")).toContainText("Add safe greeting");
		await input.fill("Use a friendlier greeting");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card")).toHaveCount(2, { timeout: 60_000 });
		await expect(page.locator(".plan-card").first()).toContainText("Superseded");
		await expect(page.locator(".plan-card").last()).toContainText("Proposed");
		await expectCompletedPlanTurn(page, sessionFile, "call-submit-plan-2");

		phase = "opening plan preview";
		await page.locator('[data-plan-action="open"]').last().click();
		await expect(page.locator(".plan-preview")).toContainText("Add friendly greeting");

		phase = "recovering renderer and app-server";
		const rootPid = app.pid!;
		const serverPidBefore = appServerPid(rootPid);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(page);
		await createCodeSession(page, sessionId);
		await expect(page.locator(".plan-card").first()).toContainText("Superseded");
		await expect(page.locator(".plan-card").last()).toContainText("Proposed");
		if (serverPidBefore) {
			process.kill(serverPidBefore, "SIGKILL");
			await expect.poll(() => appServerPid(rootPid), { timeout: 15_000 }).not.toBe(serverPidBefore);
			await waitForServerReady(page);
			await expect(page.locator(".plan-card").last()).toContainText("Proposed");
		}

		phase = "starting execution";
		const requestsBeforeStart = providerPayloads.length;
		await page.locator('[data-plan-action="start"]').last().click();
		await expect(exitPlanMode).toHaveCount(0);
		let executionPayload: ProviderPayload | undefined;
		await expect.poll(() => {
			executionPayload = providerPayloads
				.slice(requestsBeforeStart)
				.find((payload) => {
					const tools = toolNames(payload);
					return tools.includes("write") && tools.includes("set_tasks") && tools.includes("submit_plan") && isPlanExecutionTurn(payload);
				});
			return executionPayload !== undefined;
		}, { timeout: 60_000 }).toBe(true);
		expect([...toolNames(executionPayload!)].sort()).toEqual([...defaultTools].sort());
		expect(transcript(executionPayload!)).toMatch(/friendlier greeting/i);
		expect(transcript(executionPayload!)).not.toContain("call-submit-plan-1");
		expect(transcript(executionPayload!)).not.toContain("Add a greeting without changing unrelated files");
		await expect.poll(() => existsSync(acceptedWritePath), { timeout: 20_000 }).toBe(true);
		expect(await readFile(acceptedWritePath, "utf8")).toBe("Hello, friend!\n");
		await expect(page.getByText("Execution received the accepted revision.", { exact: true })).toBeVisible();
		await expect(page.locator(".permission-approval-panel")).toHaveCount(0);
		await expect(page.getByText("Task stopped", { exact: true })).toHaveCount(0);

		phase = "creating and cancelling second plan";
		await expect(page.getByText("Session ready")).toBeVisible({ timeout: 60_000 });
		await enterPlanMode(page);
		const requestsBeforeDraft = providerPayloads.length;
		await input.fill("Draft another safe plan");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card").filter({ hasText: "Proposed" })).toHaveCount(1, { timeout: 60_000 });
		await expect(page.locator('[data-plan-action="cancel"]').last()).toBeVisible({ timeout: 60_000 });
		await expect.poll(() => providerPayloads.length >= requestsBeforeDraft + 1, { timeout: 60_000 }).toBe(true);
		await expectCompletedPlanTurn(page, sessionFile, "call-submit-plan-3");
		phase = "recovering before cancellation";
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(page);
		await createCodeSession(page, sessionId);
		await expect(page.locator(".plan-card").last()).toContainText("Proposed");
		const requestsBeforeCancel = providerPayloads.length;
		await page.locator('[data-plan-action="cancel"]').last().click();
		await expect(exitPlanMode).toHaveCount(0);
		expect(providerPayloads.length).toBe(requestsBeforeCancel);
		await expect(page.locator(".plan-card").last()).toContainText("Cancelled");
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		fakeProvider.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
});
