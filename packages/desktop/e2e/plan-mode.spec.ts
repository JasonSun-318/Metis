import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	appServerPid,
	connectToApp,
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

function hasUserText(payload: ProviderPayload, text: string): boolean {
	return transcript(payload).includes(text);
}

function hasToolResult(payload: ProviderPayload, toolCallId: string): boolean {
	return transcript(payload).includes(toolCallId);
}

function payloadContainsPlanExecution(payload: ProviderPayload): boolean {
	return transcript(payload).includes("Add friendly greeting");
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

async function createCodeSession(page: Page, fixtures: CodingFixtures, projectDir: string, agentDir: string): Promise<string> {
	const sessionId = "91000000-0000-4000-8000-000000000001";
	const manager = fixtures.SessionManager.create(
		projectDir,
		fixtures.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "code", permissionMode: "full" },
	);
	manager.appendSessionInfo("Plan mode fixture");
	manager.close();
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.locator(`.session-button[aria-label="Plan mode fixture"]`).click();
	await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
	return sessionId;
}

interface CodingFixtures {
	readonly SessionManager: {
		create(cwd: string, sessionDir: string, options: { id: string; mode: "code"; permissionMode: "full" }): {
			appendSessionInfo(name: string): void;
			close(): void;
		};
	};
	readonly ProjectTrustStore: new (agentDir: string) => { set(cwd: string, trusted: boolean): void };
	readonly getDefaultSessionDir: (cwd: string, agentDir: string) => string;
}

async function loadCodingFixtures(): Promise<CodingFixtures> {
	const coreRoot = path.resolve(import.meta.dirname, "../../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	return {
		SessionManager: (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)).SessionManager as CodingFixtures["SessionManager"],
		ProjectTrustStore: (await importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href)).ProjectTrustStore as CodingFixtures["ProjectTrustStore"],
		getDefaultSessionDir: (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)).getDefaultSessionDir as CodingFixtures["getDefaultSessionDir"],
	};
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
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	const providerPayloads: ProviderPayload[] = [];
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
		if (hasUserText(payload, "Create a safe plan")) {
			response.end(sseToolCall("call-plan-bash", "bash", { command: "printf forbidden > plan-write.txt" }));
			return;
		}
		if (hasToolResult(payload, "call-plan-bash")) {
			response.end(
				sseToolCall("call-submit-plan-1", "submit_plan", {
					title: "Add safe greeting",
					markdown: "# Goal\n\nAdd a greeting without changing unrelated files.\n\n## Steps\n\n1. Add the greeting.\n2. Run the focused test.",
				}),
			);
			return;
		}
		if (hasUserText(payload, "Use a friendlier greeting")) {
			response.end(
				sseToolCall("call-submit-plan-2", "submit_plan", {
					title: "Add friendly greeting",
					markdown: "# Goal\n\nAdd a friendlier greeting.\n\n## Steps\n\n1. Update the greeting.\n2. Run the focused test.",
				}),
			);
			return;
		}
		if (payloadContainsPlanExecution(payload)) {
			response.end(sseText("Execution received the accepted revision."));
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
		await createCodeSession(page, fixtures, projectDir, agentDir);

		phase = "entering plan mode";
		const planToggle = page.getByRole("button", { name: "Plan mode", exact: true });
		await planToggle.click();
		await expect(planToggle).toHaveAttribute("aria-pressed", "true");

		phase = "creating first plan";
		const input = page.locator("#composer-input");
		await input.fill("Create a safe plan");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card")).toHaveCount(1, { timeout: 60_000 });
		expect(existsSync(planWritePath)).toBe(false);

		const explorationTools = toolNames(providerPayloads.at(-1)!);
		expect(explorationTools).toEqual(expect.arrayContaining(["read", "bash", "ask_user", "submit_plan"]));
		expect(explorationTools).not.toEqual(expect.arrayContaining(["edit", "write", "set_tasks"]));

		const planBody = page.locator(".plan-card-body").first();
		const bodyMetrics = await planBody.evaluate((element) => {
			const style = getComputedStyle(element);
			return { height: style.height, overflowY: style.overflowY, overscrollBehavior: style.overscrollBehavior };
		});
		expect(bodyMetrics.height).toBe("280px");
		expect(bodyMetrics.overflowY).toBe("auto");
		expect(bodyMetrics.overscrollBehavior).toBe("contain");

		phase = "revising plan";
		await page.locator('[data-plan-action="revise"]').click();
		await expect(page.locator(".composer-plan-revision-chip")).toContainText("Add safe greeting");
		await input.fill("Use a friendlier greeting");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card")).toHaveCount(2, { timeout: 60_000 });
		await expect(page.getByText("Superseded", { exact: true })).toBeVisible();
		await expect(page.getByText("Proposed", { exact: true })).toBeVisible();

		phase = "opening plan preview";
		await page.locator('[data-plan-action="open"]').last().click();
		await expect(page.locator(".plan-preview")).toContainText("Add friendly greeting");

		phase = "recovering renderer and app-server";
		const rootPid = app.pid!;
		const serverPidBefore = appServerPid(rootPid);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(page);
		await expect(page.getByText("Superseded", { exact: true })).toBeVisible();
		await expect(page.getByText("Proposed", { exact: true })).toBeVisible();
		if (serverPidBefore) {
			process.kill(serverPidBefore, "SIGKILL");
			await expect.poll(() => appServerPid(rootPid), { timeout: 15_000 }).not.toBe(serverPidBefore);
			await waitForServerReady(page);
			await expect(page.getByText("Proposed", { exact: true })).toBeVisible();
		}

		phase = "starting execution";
		const requestsBeforeStart = providerPayloads.length;
		await page.locator('[data-plan-action="start"]').last().click();
		await expect(planToggle).toHaveAttribute("aria-pressed", "false");
		await expect.poll(() => providerPayloads.length).toBeGreaterThan(requestsBeforeStart);
		const executionPayload = providerPayloads.at(-1)!;
		const executionTools = toolNames(executionPayload);
		expect(executionTools).not.toContain("submit_plan");
		expect(executionTools).toEqual(expect.arrayContaining(["write", "set_tasks"]));
		expect(transcript(executionPayload)).toContain("Add friendly greeting");
		expect(transcript(executionPayload)).not.toContain("Add a greeting without changing unrelated files");
		expect(transcript(executionPayload)).not.toContain("call-submit-plan-1");

		phase = "creating and cancelling second plan";
		await planToggle.click();
		await input.fill("Create a safe plan");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator('[data-plan-action="cancel"]').last()).toBeVisible({ timeout: 60_000 });
		const requestsBeforeCancel = providerPayloads.length;
		await page.locator('[data-plan-action="cancel"]').last().click();
		await expect(planToggle).toHaveAttribute("aria-pressed", "false");
		expect(providerPayloads.length).toBe(requestsBeforeCancel);
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
