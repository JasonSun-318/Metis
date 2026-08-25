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

function lastUserText(payload: ProviderPayload): string {
	const messages = payload.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		if (Reflect.get(message, "role") !== "user") continue;
		return messageText(Reflect.get(message, "content"));
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
		create(cwd: string, sessionDir: string, options: { id: string; mode: "code"; permissionMode: "full" }): {
			appendSessionInfo(name: string): void;
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

	const sessionId = "91000000-0000-4000-8000-000000000001";
	const manager = fixtures.SessionManager.create(
		projectDir,
		fixtures.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "code", permissionMode: "full" },
	);
	manager.appendSessionInfo("Plan mode fixture");
	manager.close();
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const providerPayloads: ProviderPayload[] = [];
	let providerStage: "idle" | "awaiting-bash-1" | "after-plan-1" | "after-plan-2" | "after-plan-3" = "idle";
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
		if (providerStage === "after-plan-1" || providerStage === "after-plan-2" || providerStage === "after-plan-3") {
			providerStage = "idle";
			response.end(sseText("Plan exploration complete."));
			return;
		}
		if (providerStage === "awaiting-bash-1" && hasToolResult(payload, bash1Id)) {
			providerStage = "after-plan-1";
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
			providerStage = "after-plan-2";
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
			providerStage = "after-plan-3";
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
			response.end(sseText("Execution received the accepted revision."));
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

		const explorationPayload = providerPayloads.find((payload) => toolNames(payload).includes("submit_plan"))!;
		const explorationTools = toolNames(explorationPayload);
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
		await expect(page.locator(".plan-card").first()).toContainText("Superseded");
		await expect(page.locator(".plan-card").last()).toContainText("Proposed");

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
		await expect(planToggle).toHaveAttribute("aria-pressed", "false");
		let executionPayload: ProviderPayload | undefined;
		await expect.poll(() => {
			executionPayload = providerPayloads
				.slice(requestsBeforeStart)
				.find((payload) => /friendlier greeting/i.test(transcript(payload)));
			return executionPayload !== undefined;
		}, { timeout: 60_000 }).toBe(true);
		expect(transcript(executionPayload!)).not.toContain("call-submit-plan-1");
		expect(transcript(executionPayload!)).not.toContain("Add a greeting without changing unrelated files");

		phase = "creating and cancelling second plan";
		await planToggle.click();
		await expect(planToggle).toHaveAttribute("aria-pressed", "true");
		const requestsBeforeDraft = providerPayloads.length;
		await input.fill("Draft another safe plan");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".plan-card").filter({ hasText: "Proposed" })).toHaveCount(1, { timeout: 60_000 });
		await expect(page.locator('[data-plan-action="cancel"]').last()).toBeVisible({ timeout: 60_000 });
		await expect.poll(() => providerPayloads.length >= requestsBeforeDraft + 2, { timeout: 60_000 }).toBe(true);
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
