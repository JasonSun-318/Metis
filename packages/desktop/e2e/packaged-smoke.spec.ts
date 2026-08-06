import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";
import {
	appServerPid,
	closeServer,
	connectToApp,
	createAndRestoreChatSession,
	desktopRoot,
	listen,
	packagedAsar,
	packagedExecutable,
	processIsAlive,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

const CHAT_ACTIVE_ID = "10000000-0000-4000-8000-000000000001";
const CHAT_ARCHIVED_ID = "10000000-0000-4000-8000-000000000002";
const CODE_ID = "10000000-0000-4000-8000-000000000003";
const SCHEDULE_ID = "10000000-0000-4000-8000-000000000004";
const SESSION_ACTION_ID = "10000000-0000-4000-8000-000000000005";

interface FixtureSessionManager {
	appendCustomEntry(customType: string, data?: unknown): string;
	appendMessage(message: object, toolOutput?: unknown): string;
	appendSubagentControl(payload: object): string;
	appendSessionInfo(name: string): string;
	appendThinkingLevelChange(thinkingLevel: string): string;
	close(): void;
	getSessionFile(): string | undefined;
}

function assistantMessage(timestamp: number, totalTokens: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "profile-fixture",
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

interface CodingFixtures {
	readonly createSessionWorkDir: (agentDir: string, sessionId: string) => string;
	readonly ensureModeScopedMemoryLayout: (agentDir: string) => Promise<void>;
	readonly getAutoMemoryPaths: (
		agentDir: string,
		cwd: string,
		mode: "chat" | "code",
	) => { readonly project: { readonly directory: string; readonly indexPath: string } };
	readonly getDefaultSessionDir: (cwd: string, agentDir: string) => string;
	readonly getSessionAttachmentDir: (agentDir: string, sessionId: string) => string;
	readonly getSessionImageDir: (sessionFile: string) => string;
	readonly getSessionSubagentDir: (agentDir: string, sessionId: string) => string;
	readonly getSessionToolOutputDir: (sessionFile: string) => string;
	readonly moveSessionFileWithLease: (source: string, destination: string) => void;
	readonly ProjectTrustStore: new (agentDir: string) => {
		get(cwd: string): boolean | null;
		set(cwd: string, decision: boolean): void;
	};
	readonly ScheduleManager: {
		create(options: { agentDir: string }): {
			create(input: object): Promise<unknown>;
			delete(taskId: string, input: { deleteSessions: boolean }): Promise<unknown>;
		};
	};
	readonly SessionManager: {
		open(path: string): FixtureSessionManager;
		create(
			cwd: string,
			sessionDir: string,
			options: {
				id: string;
				mode: "chat" | "code";
				permissionMode?: "ask" | "full";
				subagent?: { agentId: string; name: string; parentSessionId: string };
			},
		): FixtureSessionManager;
	};
}

async function loadCodingFixtures(): Promise<CodingFixtures> {
	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	const [memory, attachments, sessions, schedules, trust] = await Promise.all([
		importEsm(pathToFileURL(path.join(coreRoot, "auto-memory.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "session-attachments.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "schedules", "manager.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href),
	]);
	return {
		createSessionWorkDir: attachments.createSessionWorkDir,
		ensureModeScopedMemoryLayout: memory.ensureModeScopedMemoryLayout,
		getAutoMemoryPaths: memory.getAutoMemoryPaths,
		getDefaultSessionDir: sessions.getDefaultSessionDir,
		getSessionAttachmentDir: attachments.getSessionAttachmentDir,
		getSessionImageDir: sessions.getSessionImageDir,
		getSessionSubagentDir: sessions.getSessionSubagentDir,
		getSessionToolOutputDir: sessions.getSessionToolOutputDir,
		moveSessionFileWithLease: sessions.moveSessionFileWithLease,
		ProjectTrustStore: trust.ProjectTrustStore,
		ScheduleManager: schedules.ScheduleManager,
		SessionManager: sessions.SessionManager,
	} as CodingFixtures;
}

function createStoredSession(
	fixtures: CodingFixtures,
	agentDir: string,
	projectDir: string,
	sessionId: string,
	mode: "chat" | "code",
	archived = false,
	name?: string,
): string {
	const manager = fixtures.SessionManager.create(projectDir, fixtures.getDefaultSessionDir(projectDir, agentDir), {
		id: sessionId,
		mode,
	});
	if (name) manager.appendSessionInfo(name);
	const activePath = manager.getSessionFile();
	manager.close();
	if (!activePath) throw new Error(`Session fixture was not persisted: ${sessionId}`);
	if (!archived) return activePath;
	const sessionsRoot = path.join(agentDir, "sessions");
	const archivedPath = path.join(sessionsRoot, ".archive", path.relative(sessionsRoot, activePath));
	mkdirSync(path.dirname(archivedPath), { recursive: true });
	fixtures.moveSessionFileWithLease(activePath, archivedPath);
	return archivedPath;
}

async function writeFixtureFile(filePath: string, content: string): Promise<string> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
	return filePath;
}

function git(cwd: string, ...args: readonly string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
	if (result.status !== 0) throw new Error(result.stderr || `git ${args[0] ?? ""} failed`);
}

async function seedOwnedSessionData(
	fixtures: CodingFixtures,
	agentDir: string,
	sessionId: string,
	sessionFile: string,
): Promise<string[]> {
	const workDir = fixtures.createSessionWorkDir(agentDir, sessionId);
	const previousAgentDir = process.env.ARCMIND_CODING_AGENT_DIR;
	process.env.ARCMIND_CODING_AGENT_DIR = agentDir;
	const imageDir = fixtures.getSessionImageDir(sessionFile);
	const toolOutputDir = fixtures.getSessionToolOutputDir(sessionFile);
	if (previousAgentDir === undefined) delete process.env.ARCMIND_CODING_AGENT_DIR;
	else process.env.ARCMIND_CODING_AGENT_DIR = previousAgentDir;
	return Promise.all([
		writeFixtureFile(path.join(imageDir, "image.png"), "chat image"),
		writeFixtureFile(path.join(toolOutputDir, "tool.txt"), "chat tool output"),
		writeFixtureFile(path.join(fixtures.getSessionAttachmentDir(agentDir, sessionId), "attachment.txt"), "chat attachment"),
		writeFixtureFile(path.join(fixtures.getSessionSubagentDir(agentDir, sessionId), "subagent.jsonl"), "chat subagent"),
		writeFixtureFile(path.join(workDir, "document.txt"), "chat document work"),
	]);
}

function projectGroup(page: Page, name: string) {
	return page.locator(".project-group").filter({ has: page.locator(".project-heading", { hasText: name }) });
}

async function showProjectActions(group: Locator) {
	await group.getByRole("button", { name: "Project actions" }).focus();
	await expect(group.locator(".project-action-buttons")).toHaveCSS("opacity", "1");
}

async function clickCenter(page: Page, target: Locator): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error("Interactive target has no bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function resizeToolsSidebar(page: Page, targetWidth: number): Promise<void> {
	const sidebar = page.locator(".tool-sidebar");
	const resizer = page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
	if ((targetWidth - 280) % 16 !== 0) throw new Error(`Tools sidebar target ${targetWidth}px is not keyboard reachable`);
	for (let index = 0; index < 80; index += 1) {
		const width = Math.round((await sidebar.boundingBox())?.width ?? 0);
		if (width === 280) break;
		await resizer.press("ArrowRight");
	}
	await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
	for (let index = 0; index < (targetWidth - 280) / 16; index += 1) await resizer.press("ArrowLeft");
	await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(targetWidth);
}

async function codeEditorText(editor: Locator): Promise<string> {
	return (await editor.locator(".cm-line").allTextContents()).join("\n");
}

async function openSessionGroupingOptions(page: Page) {
	await page.getByRole("button", { name: "Group sessions", exact: true }).click();
	await page.getByRole("menu", { name: "Session grouping" }).getByRole("menuitem").click();
}

async function groupSessionsBy(page: Page, grouping: "Date" | "Project" | "Unread" | "None") {
	await openSessionGroupingOptions(page);
	await page.getByRole("menu", { name: "Group sessions" }).getByRole("menuitemradio", { name: grouping, exact: true }).click();
}

function launchPackagedApp(
	executable: string,
	debuggingPort: number,
	userDataDir: string,
	projectDir: string,
	agentDir: string,
	homeDir: string,
	diagnostics: string[],
	extraArguments: readonly string[] = [],
) {
	const app = spawn(executable, [
		`--remote-debugging-port=${debuggingPort}`,
		`--user-data-dir=${userDataDir}`,
		...extraArguments,
	], {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			ARCMIND_CODING_AGENT_DIR: agentDir,
			HOME: homeDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
			USERPROFILE: homeDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	app.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));
	return app;
}

test("packaged worker, WASM, trusted extension, and utility lifecycle stay functional", async () => {
	test.setTimeout(90_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-packaged-smoke-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const extensionDir = path.join(projectDir, ".arcmind", "extensions");
	const projectSkillDir = path.join(projectDir, ".arcmind", "skills", "packaged-project-skill");
	const userDataDir = path.join(tempRoot, "electron");
	const scheduleQaDir = path.join(desktopRoot, "test-results", "design-qa", "scheduled-tasks");
	const assetQaDir = path.join(desktopRoot, "test-results", "design-qa", "assets");
	const groupingQaDir = path.join(desktopRoot, "test-results", "design-qa", "session-grouping");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(extensionDir, { recursive: true }),
		mkdir(projectSkillDir, { recursive: true }),
		mkdir(userDataDir),
		mkdir(scheduleQaDir, { recursive: true }),
		mkdir(assetQaDir, { recursive: true }),
		mkdir(groupingQaDir, { recursive: true }),
	]);

	let providerRequests = 0;
	const providerToolNames: string[][] = [];
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> };
		providerToolNames.push(
			(payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((name): name is string => Boolean(name)),
		);
		providerRequests += 1;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`data: ${JSON.stringify({
				id: "chatcmpl-packaged-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model: "packaged-smoke-model",
				choices: [
					{ index: 0, delta: { role: "assistant", content: "packaged-turn-ok" }, finish_reason: null },
				],
			})}\n\ndata: ${JSON.stringify({
				id: "chatcmpl-packaged-smoke",
				object: "chat.completion.chunk",
				created: 1,
				model: "packaged-smoke-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
		);
	});
	const providerPort = await listen(fakeProvider);
	const codingAgentUrl = pathToFileURL(
		path.join(packagedAsar(), ".webpack", "app-server", "node_modules", "@arcmind", "coding-agent", "dist", "index.js"),
	).href;
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"packaged-smoke": {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "packaged-smoke-key",
						api: "openai-completions",
						models: [
							{
								id: "packaged-smoke-model",
								name: "Packaged Smoke Model",
								contextWindow: 32_000,
								maxTokens: 1_024,
							},
						],
					},
				},
			}),
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "packaged-smoke",
				defaultModel: "packaged-smoke-model",
				retry: { enabled: false },
				webSearch: { enabled: true, provider: "brave" },
			}),
		),
		writeFile(
			path.join(extensionDir, "packaged-image.ts"),
			`export default function (arcmind) {
	arcmind.on("session_start", async (_event, ctx) => {
		try {
			const { resizeImage } = await import(${JSON.stringify(codingAgentUrl)});
			const input = Uint8Array.from(Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"));
			const result = await resizeImage(input, "image/png", { maxWidth: 1, maxHeight: 1 });
			const message = result?.width === 1 && result.height === 1
				? "Worker and WASM returned 1x1"
				: "Worker or WASM returned an unexpected result";
			await ctx.ui.confirm("Packaged image pipeline", message);
		} catch (error) {
			await ctx.ui.confirm(
				"Packaged image pipeline",
				\`Image pipeline error: \${error instanceof Error ? error.message : String(error)}\`,
			);
		}
	});
}
`,
		),
		writeFile(
			path.join(projectSkillDir, "SKILL.md"),
			"---\nname: packaged-project-skill\ndescription: Visible in the packaged Project catalog\n---\n",
		),
	]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	let finalUtilityPid: number | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		phase = "verifying draft creation timing";
		await waitForServerReady(page);
		phase = "verifying packaged Skills catalog";
		await page.getByRole("button", { name: "Skills", exact: true }).click();
		await page.getByRole("button", { name: "System", exact: true }).click();
		await expect(page.getByText("pdf", { exact: true })).toBeVisible();
		await page.locator(".skills-breadcrumbs").getByRole("button", { name: "Skills", exact: true }).click();
		await page.getByRole("button", { name: "User", exact: true }).click();
		await expect(page.locator(".skills-empty-state .traced-svg-icon")).toBeVisible();
		await expect(page.getByText("No user skills", { exact: true })).toBeVisible();
		await page.screenshot({ path: path.join(assetQaDir, "skills-empty.png") });
		await page.getByRole("button", { name: "New task", exact: true }).click();

		phase = "verifying draft creation timing";
		const bridge = await page.evaluate(() => {
			const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
			return {
				hasAttachmentPicker: typeof api.selectAttachmentFiles === "function",
				hasSkillList: typeof api.listSkills === "function",
			};
		});
		expect(bridge).toEqual({ hasAttachmentPicker: true, hasSkillList: true });
		const sessionsBeforeDraft = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsBeforeDraft.sessions).toHaveLength(0);
		await page.getByRole("button", { name: "New task" }).click();
		const sessionsAfterNewTask = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterNewTask.sessions).toHaveLength(0);
		await page.locator("#composer-input").fill("managed packaged smoke");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		expect(providerToolNames[0]).toEqual(expect.arrayContaining(["web_fetch", "web_search"]));
		const sessionsAfterFirstSend = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterFirstSend.sessions).toHaveLength(1);
		expect(sessionsAfterFirstSend.sessions[0]).toMatchObject({ mode: "chat", cwdOrigin: "managed" });
		const todaySection = page.locator(".session-section").filter({ has: page.getByRole("button", { name: "Today", exact: true }) });
		await expect(todaySection).toBeVisible();
		await page.locator(".session-sidebar").screenshot({ path: path.join(groupingQaDir, "date-default.png") });
		await todaySection.getByRole("button", { name: "Today", exact: true }).click();
		await expect(todaySection.locator(".session-section-drawer")).toHaveAttribute("inert", "");
		await todaySection.getByRole("button", { name: "Today", exact: true }).click();
		await openSessionGroupingOptions(page);
		await expect(page.getByRole("menu", { name: "Group sessions" })).toBeVisible();
		await page.screenshot({ path: path.join(groupingQaDir, "group-menu.png") });
		await page.getByRole("menu", { name: "Group sessions" }).getByRole("menuitemradio", { name: "Unread", exact: true }).click();
		await expect(page.getByRole("button", { name: "Read", exact: true })).toBeVisible();
		await page.locator(".session-sidebar").screenshot({ path: path.join(groupingQaDir, "unread.png") });
		await groupSessionsBy(page, "None");
		await expect(page.locator(".session-section")).toHaveCount(0);
		await expect(page.locator(".session-row")).toHaveCount(1);
		await groupSessionsBy(page, "Project");
		await expect(page.getByText("Tasks", { exact: true })).toBeVisible();

		phase = "creating trusted project session";
		const trustedSessionId = await createAndRestoreChatSession(page, projectDir, false);
		await expect(page.getByRole("heading", { name: "Trust this project?" })).toBeVisible();
		await page.getByRole("button", { name: /Trust \(this session only\)/ }).click();

		phase = "running the packaged extension image pipeline";
		await expect(page.getByRole("heading", { name: "Packaged image pipeline" })).toBeVisible();
		await expect(page.getByText("Worker and WASM returned 1x1", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Confirm" }).click();
		await page.locator(`[data-active-session-id="${trustedSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });

		phase = "verifying packaged Project Skill catalog";
		await page.getByRole("button", { name: "Skills", exact: true }).click();
		await page.getByRole("button", { name: "Project", exact: true }).click();
		await page.locator(".skills-directory-list").getByRole("button", { name: "Chat", exact: true }).click();
		await page.getByRole("button", { name: path.basename(projectDir), exact: true }).click();
		await expect(page.getByText("packaged-project-skill", { exact: true })).toBeVisible();
		await page.locator(".project-group").filter({ hasText: path.basename(projectDir) }).locator(".session-button").click();
		await page.locator(`[data-active-session-id="${trustedSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });

		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		await expect.poll(() => appServerPid(rootPid)).not.toBeUndefined();

		phase = "running a fake provider turn";
		await page.locator("#composer-input").fill("packaged smoke turn");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		expect(providerRequests).toBe(2);

		phase = "creating and running a packaged scheduled task";
		await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Create your first scheduled task" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-empty.png") });
		await page.getByLabel("Sort scheduled tasks").click();
		await expect(page.getByRole("listbox", { name: "Sort scheduled tasks" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-sort-menu.png") });
		await page.getByRole("option", { name: "Next run", exact: true }).click();
		const headerNewTaskTrigger = page.locator(".scheduled-tasks-header").getByRole("button", { name: "Create scheduled task", exact: true });
		await headerNewTaskTrigger.click();
		await expect(page.getByRole("listbox", { name: "Create scheduled task" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-new-task-menu-top.png") });
		await headerNewTaskTrigger.click();
		const emptyNewTaskTrigger = page.locator(".scheduled-tasks-empty").getByRole("button", { name: "Create scheduled task", exact: true });
		await emptyNewTaskTrigger.click();
		const newTaskMenu = page.getByRole("listbox", { name: "Create scheduled task" });
		await expect(newTaskMenu).toBeVisible();
		const [newTaskTriggerBox, newTaskMenuBox] = await Promise.all([emptyNewTaskTrigger.boundingBox(), newTaskMenu.boundingBox()]);
		expect(newTaskMenuBox?.width).toBeGreaterThanOrEqual(204);
		expect(Math.abs((newTaskMenuBox?.x ?? 0) + (newTaskMenuBox?.width ?? 0) - ((newTaskTriggerBox?.x ?? 0) + (newTaskTriggerBox?.width ?? 0)))).toBeLessThanOrEqual(1);
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-new-task-menu.png") });
		await page.getByRole("option", { name: "Create with ArcMind", exact: true }).click();
		const workspaceDialog = page.getByRole("dialog", { name: "Where should this task work?" });
		await expect(workspaceDialog).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "create-with-arcmind-workspace.png") });
		await workspaceDialog.getByRole("button", { name: /Use default workspace/u }).click();
		await expect.poll(() => providerRequests).toBe(3);
		await expect(page.getByRole("heading", { name: "Set up a scheduled task", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await page.locator(".scheduled-tasks-empty").getByRole("button", { name: "Create scheduled task", exact: true }).click();
		await page.getByRole("option", { name: "Set up manually", exact: true }).click();
		const scheduleDialog = page.getByRole("dialog", { name: "Create scheduled task" });
		await expect(scheduleDialog).toBeVisible();
		await scheduleDialog.getByLabel("Name").fill("Morning brief");
		await scheduleDialog.getByLabel("Description").fill("Calendar and inbox summary");
		await scheduleDialog.getByLabel("Instructions").fill("Summarize the current project status.");
		await scheduleDialog.getByLabel("Work in").click();
		await page.getByRole("listbox", { name: "Work in" }).getByRole("option").nth(1).click();
		await scheduleDialog.getByLabel("Model").click();
		await page.getByRole("option", { name: "Packaged Smoke Model · packaged-smoke", exact: true }).click();
		await page.screenshot({ path: path.join(scheduleQaDir, "create-dialog.png") });
		await scheduleDialog.getByLabel("Repeat").click();
		await expect(page.getByRole("listbox", { name: "Repeat" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "create-dialog-menu.png") });
		await page.getByRole("option", { name: "Daily", exact: true }).click();
		await scheduleDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Morning brief", exact: true })).toBeVisible();
		const runNowButton = page.getByRole("button", { name: "Run now", exact: true });
		await runNowButton.click();
		await expect(runNowButton).toBeDisabled();
		await expect(page.locator(".scheduled-task-history").getByText("succeeded", { exact: true })).toBeVisible({ timeout: 20_000 });
		expect(providerRequests).toBe(4);
		expect(providerToolNames[3]?.sort()).toEqual(
			["bash", "edit", "find", "grep", "ls", "read", "web_fetch", "web_search", "write"].sort(),
		);
		await expect(runNowButton).toBeEnabled();
		await page.mouse.move(0, 0);
		expect(await runNowButton.evaluate((element) => {
			const style = getComputedStyle(element);
			return { backgroundColor: style.backgroundColor, opacity: style.opacity };
		})).toEqual({ backgroundColor: "rgb(239, 238, 233)", opacity: "1" });
		await page.screenshot({ path: path.join(scheduleQaDir, "task-detail.png") });
		await page.locator(".scheduled-task-history").getByRole("button").click();
		await expect(page.locator('.session-row[data-scheduled="true"]')).toContainText("Scheduled");

		phase = "deleting the packaged task and its generated session";
		await page.locator(".session-sidebar").getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await page.locator(".scheduled-task-quick-list").getByRole("button", { name: /Morning brief/u }).click();
		await page.getByRole("button", { name: "Delete task" }).click();
		const deleteTaskDialog = page.getByRole("dialog", { name: "Delete “Morning brief”?" });
		const deleteSessions = deleteTaskDialog.getByRole("checkbox", {
			name: /Also delete all session files generated by this task/u,
		});
		await expect(deleteSessions).not.toBeChecked();
		await deleteSessions.check();
		await deleteTaskDialog.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(page.locator('.session-row[data-scheduled="true"]')).toHaveCount(0);
		const remainingSessions = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.listSessions({ limit: 200 }),
		);
		expect(remainingSessions.sessions).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Morning brief", scheduled: expect.any(Object) })]),
		);
		await page.locator(".session-sidebar").getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Scheduled tasks", exact: true })).toBeVisible();
		await expect(page.locator(".scheduled-task-quick-list").getByText("Morning brief", { exact: true })).toHaveCount(0);

		phase = "reloading and restarting";
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.locator(".session-row").filter({ hasText: "packaged smoke turn" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		const firstUtilityPid = appServerPid(rootPid);
		if (!firstUtilityPid) throw new Error("Could not find the packaged App Server");
		process.kill(firstUtilityPid, "SIGKILL");
		await expect.poll(() => appServerPid(rootPid)).not.toBe(firstUtilityPid);
		await waitForServerReady(page);
		finalUtilityPid = appServerPid(rootPid);
		if (!finalUtilityPid) throw new Error("Packaged App Server did not restart");

		phase = "quitting without an orphan";
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		await expect.poll(() => processIsAlive(finalUtilityPid!)).toBe(false);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase} requests=${providerRequests}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged personal profile renders cached Token and Skill activity", async () => {
	test.setTimeout(60_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-profile-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "profile-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "profile");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	const now = Date.now();
	const skillNames = ["pdf", "ponytail", "writing-plans"];
	for (let index = 0; index < 18; index += 1) {
		const mode = index < 12 ? "code" : "chat";
		const manager = fixtures.SessionManager.create(
			projectDir,
			fixtures.getDefaultSessionDir(projectDir, agentDir),
			{ id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, mode },
		);
		const timestamp = now - index * 2 * 86_400_000;
		manager.appendMessage({ role: "user", content: `profile fixture ${index}`, timestamp });
		manager.appendThinkingLevelChange(index < 12 ? "high" : "medium");
		manager.appendMessage(assistantMessage(timestamp + 30 * 60_000, (index + 1) * 850));
		manager.appendCustomEntry("arcmind.skill_usage.v1", { name: skillNames[index % skillNames.length], trigger: "read" });
		manager.close();
	}

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1440, height: 900 });
		await waitForServerReady(page);

		phase = "opening Settings";
		await page.getByRole("button", { name: "ArcMind", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
		await page.screenshot({ path: path.join(qaDir, "account-menu.png") });
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		await expect(page.getByRole("heading", { name: "ArcMind User", exact: true })).toBeVisible();
		await expect(page.getByText("Most used Skills", { exact: true })).toBeVisible();
		await expect(page.locator(".profile-heatmap-week")).toHaveCount(53);
		await expect(page.getByText("pdf", { exact: true })).toBeVisible();

		phase = "checking profile data and cache";
		const measurements = await page.evaluate(async () => {
			const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
			const firstStarted = performance.now();
			const first = await api.getProfile();
			const secondStarted = performance.now();
			const second = await api.getProfile();
			return { first, second, firstMs: secondStarted - firstStarted, secondMs: performance.now() - secondStarted };
		});
		const { generatedAt: firstGeneratedAt, ...firstProfile } = measurements.first;
		const { generatedAt: secondGeneratedAt, ...secondProfile } = measurements.second;
		expect(firstProfile).toEqual(secondProfile);
		expect(Date.parse(secondGeneratedAt)).toBeGreaterThanOrEqual(Date.parse(firstGeneratedAt));
			expect(measurements.first).toMatchObject({
				totalTokens: 145_350,
				sessionCount: 18,
				mostUsedMode: "code",
				mostUsedModePercent: 67,
				mostUsedThinkingLevel: "high",
				mostUsedThinkingLevelPercent: 67,
				usedSkillCount: 3,
			skillUseCount: 18,
			topSkills: [
				{ name: "pdf", count: 6 },
				{ name: "ponytail", count: 6 },
				{ name: "writing-plans", count: 6 },
			],
		});
		expect(measurements.firstMs).toBeLessThan(5_000);
		expect(measurements.secondMs).toBeLessThan(1_000);

		phase = "capturing the profile";
		const activeCells = page.locator('.profile-heatmap-cell:not([data-level="0"])');
		expect(await activeCells.count()).toBe(18);
		const heatmap = await page.locator(".profile-heatmap").evaluate((element) => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
		}));
		expect(heatmap.scrollWidth).toBeLessThanOrEqual(heatmap.clientWidth + 1);
		const reveal = await page.locator(".profile-heatmap-cell").evaluateAll((cells) => {
			const first = getComputedStyle(cells[0]!);
			const last = getComputedStyle(cells[cells.length - 1]!);
			return { name: first.animationName, firstDelay: first.animationDelay, lastDelay: last.animationDelay };
		});
		expect(reveal.name).toBe("profile-cell-reveal");
		expect(Number.parseFloat(reveal.lastDelay)).toBeGreaterThan(Number.parseFloat(reveal.firstDelay));
		const revealWave = await page.locator(".profile-heatmap-cell").evaluateAll((cells) => {
			const animations = cells.flatMap((cell) => cell.getAnimations());
			for (const animation of animations) animation.currentTime = 300;
			const opacity = {
				first: Number.parseFloat(getComputedStyle(cells[0]!).opacity),
				last: Number.parseFloat(getComputedStyle(cells[cells.length - 1]!).opacity),
			};
			for (const animation of animations) animation.finish();
			return opacity;
		});
		expect(revealWave.first).toBeGreaterThan(revealWave.last);
		await activeCells.last().hover();
		await page.screenshot({ path: path.join(qaDir, "profile-1440x900.png") });

		phase = "checking compact layout";
		await page.setViewportSize({ width: 960, height: 720 });
		await expect(page.getByRole("heading", { name: "ArcMind User", exact: true })).toBeVisible();
		expect(
			await page.locator(".profile-stats").evaluate((element) =>
				getComputedStyle(element).gridTemplateColumns.split(" ").length,
			),
		).toBe(3);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
		).toBeLessThanOrEqual(0);
		await page.screenshot({ path: path.join(qaDir, "profile-960x720.png") });
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged Code subagent sidebar lists durable work and opens its transcript", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-subagent-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "subagent-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "subagents");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	const parentPath = createStoredSession(fixtures, agentDir, projectDir, CODE_ID, "code", false, "Subagent fixture");
	const parent = fixtures.SessionManager.open(parentPath);
	parent.appendSubagentControl({
		type: "subagent_closed",
		tombstone: {
			agentId: "30000000-0000-4000-8000-000000000003",
			name: "archived-inspector",
			status: "closed",
			taskSummary: "Review archived result",
			finalSummary: "## Archived result\n\nFound **no remaining issues**.",
			closedAt: "2026-08-06T00:00:00.000Z",
		},
	});
	parent.close();
	const childId = "30000000-0000-4000-8000-000000000001";
	const runId = "30000000-0000-4000-8000-000000000002";
	const child = fixtures.SessionManager.create(
		projectDir,
		fixtures.getSessionSubagentDir(agentDir, CODE_ID),
		{
			id: childId,
			mode: "code",
			permissionMode: "ask",
			subagent: { agentId: childId, name: "packaged-inspector", parentSessionId: CODE_ID },
		},
	);
	const config = {
		agentId: childId,
		name: "packaged-inspector",
		task: "Inspect packaged project",
		taskSummary: "Inspect packaged project",
		mode: "code",
		tools: ["read"],
		permissionMode: "ask",
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		cwd: projectDir,
		forkTurns: 0,
		timeoutSeconds: 60,
	};
	child.appendSubagentControl({ type: "subagent_created", config });
	child.appendSubagentControl({
		type: "subagent_state",
		agentId: childId,
		runId,
		status: "queued",
		background: true,
	});
	child.appendSubagentControl({
		type: "subagent_state",
		agentId: childId,
		runId,
		status: "running",
		background: true,
	});
	const fixtureTimestamp = Date.now();
	child.appendMessage({ role: "user", content: "Inspect packaged project", timestamp: fixtureTimestamp });
	for (let index = 0; index < 196; index += 1) {
		child.appendMessage({
			...assistantMessage(fixtureTimestamp + index + 1, 0),
			content: [{ type: "text", text: `Historical child activity ${index + 1}` }],
		});
	}
	const toolCallId = "fixture-read-1";
	child.appendMessage({
		...assistantMessage(fixtureTimestamp + 197, 0),
		content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } }],
		stopReason: "toolUse",
	});
	child.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "Packaged tool output" }],
		isError: false,
		timestamp: fixtureTimestamp + 198,
	});
	child.appendMessage({
		...assistantMessage(fixtureTimestamp + 199, 35),
		content: [{ type: "text", text: "Packaged child completed" }],
	});
	child.appendSubagentControl({
		type: "subagent_state",
		agentId: childId,
		runId,
		status: "done",
		background: true,
		reason: "completed",
		finalSummary: "Packaged child completed",
		usage: {
			model: config.model,
			input: 10,
			output: 20,
			cacheRead: 3,
			cacheWrite: 2,
			elapsedMs: 65_000,
			toolCalls: 4,
		},
	});
	child.close();

	let debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	let app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
		await page.setViewportSize({ width: 1280, height: 1000 });
		await waitForServerReady(page);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Subagent fixture", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);
		expect(await page.evaluate(() => typeof (window as Window & { arcMind?: { interruptSubagent?: unknown } }).arcMind?.interruptSubagent)).toBe("function");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged child completed");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged tool output");

		phase = "opening the Subagent tool";
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Subagent", exact: true }).click();
		await expect(page.getByText("Background tasks", { exact: true })).toBeVisible();
		await expect(page.getByText("Inspect packaged project", { exact: true })).toBeVisible();
		await expect(page.getByText("35 tokens", { exact: true })).toBeVisible();
		await expect(page.getByText("4 tool uses", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "View summary for Review archived result", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Archived result", exact: true })).toBeVisible();
		await expect(page.getByText("no remaining issues", { exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "Subagent transcript", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Back to background tasks", exact: true }).click();
		await resizeToolsSidebar(page, 392);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await expect(page.getByRole("button", { name: "Hide tools sidebar", exact: true })).toBeInViewport();
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "list-392x986.png") });
		await resizeToolsSidebar(page, 280);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await expect(page.getByRole("button", { name: "Add tool", exact: true })).toBeInViewport();
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "list-280x986.png") });
		await resizeToolsSidebar(page, 392);

		phase = "opening the child transcript";
		await page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true }).click();
		const transcript = page.getByRole("region", { name: "Subagent transcript", exact: true });
		await expect(transcript).toBeVisible();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		expect(await transcript.locator("[data-transcript-item]").count()).toBeLessThanOrEqual(24);
		expect(await transcript.locator(".code-execution > summary").count()).toBeGreaterThanOrEqual(2);
		await transcript.locator(".code-execution > summary").last().click();
		await expect(transcript.getByText("Packaged tool output", { exact: true })).toBeVisible();
		expect(await transcript.locator(".code-command-output").evaluate((element) => getComputedStyle(element).overflow)).toBe("auto");
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "detail-392x986.png") });
		await page.setViewportSize({ width: 1280, height: 938 });
		await resizeToolsSidebar(page, 856);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "detail-856x924.png") });
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged child completed");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged tool output");

		phase = "reopening the Subagent tab";
		await page.getByRole("button", { name: "Close Subagent", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Subagent", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true }).click();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		await page.getByRole("region", { name: "Subagent transcript", exact: true }).locator(".code-execution > summary").last().click();
		await expect(page.getByText("Packaged tool output", { exact: true })).toBeVisible();

		phase = "checking a narrow app window";
		await page.setViewportSize({ width: 900, height: 640 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await expect(page.getByRole("button", { name: "Hide tools sidebar", exact: true })).toBeInViewport();
		await page.screenshot({ path: path.join(qaDir, "narrow-window-900x640.png") });

		phase = "restoring the child after app restart";
		const browserSession = await browser.newBrowserCDPSession();
		void browserSession.send("Browser.close").catch(() => undefined);
		await expect.poll(() => app.exitCode !== null || app.signalCode !== null).toBe(true);
		browser = undefined;
		debuggingPort = await reservePort();
		app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Subagent fixture", exact: true }).click();
		await expect(page.locator(`[data-active-session-id="${CODE_ID}"]`)).toBeVisible();
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Subagent", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true }).click();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		await page.getByRole("region", { name: "Subagent transcript", exact: true }).locator(".code-execution > summary").last().click();
		await expect(page.getByText("Packaged tool output", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to background tasks", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Inspect packaged project", exact: true })).toBeFocused();
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged terminal sidebar runs a real PTY and keeps independent tabs", async () => {
	test.setTimeout(60_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-terminal-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "terminal-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "terminal");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		await createAndRestoreChatSession(page, projectDir);

		phase = "opening the terminal tool";
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect(page.locator(".tool-sidebar-menu")).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "tool-menu-1280x840.png") });
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Terminal", exact: true }).click();
		await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();
		const firstTerminalId = await page.locator('.terminal-panel[aria-hidden="false"]').getAttribute("id");
		if (!firstTerminalId?.startsWith("terminal-panel-")) throw new Error("Terminal panel id is missing");
		const terminalId = firstTerminalId.slice("terminal-panel-".length);
		await expect.poll(async () => page!.evaluate(async (id) => {
			try {
				await (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.writeTerminal({ terminalId: id, data: "" });
				return true;
			} catch {
				return false;
			}
		}, terminalId)).toBe(true);
		await page.evaluate(async (id) => {
			await (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.writeTerminal({
				terminalId: id,
				data: "printf '\\x41\\x52\\x43\\x4d\\x49\\x4e\\x44\\x5f\\x54\\x45\\x52\\x4d\\x49\\x4e\\x41\\x4c\\x5f\\x45\\x32\\x45\\n'\r",
			});
		}, terminalId);
		await expect(page.locator('.terminal-panel[aria-hidden="false"] .xterm-rows')).toContainText("ARCMIND_TERMINAL_E2E");
		const sidebar = page.locator(".tool-sidebar");
		const [sidebarBox, firstTabBox, addButtonBox] = await Promise.all([
			sidebar.boundingBox(),
			page.locator(".tool-tab").first().boundingBox(),
			page.getByRole("button", { name: "Add tool", exact: true }).boundingBox(),
		]);
		if (!sidebarBox || !firstTabBox || !addButtonBox) throw new Error("Terminal sidebar geometry is missing");
		expect(sidebarBox.y).toBe(7);
		expect(1280 - sidebarBox.x - sidebarBox.width).toBe(7);
		const addGap = addButtonBox.x - firstTabBox.x - firstTabBox.width;
		expect(addGap).toBeGreaterThanOrEqual(0);
		expect(addGap).toBeLessThanOrEqual(2);
		expect(await sidebar.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("9px");
		await page.screenshot({ path: path.join(qaDir, "single-terminal-1280x840.png") });

		phase = "adding and resizing terminal tabs";
		await clickCenter(page, page.getByRole("button", { name: "Add tool", exact: true }));
		await page.screenshot({ path: path.join(qaDir, "add-tool-menu-1280x840.png") });
		await page.locator(".tool-add-menu").getByRole("menuitem", { name: "Terminal", exact: true }).click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		const before = await sidebar.boundingBox();
		const handle = await page.getByRole("separator", { name: "Resize tools sidebar" }).boundingBox();
		if (!before || !handle) throw new Error("Terminal sidebar resize handle is missing");
		await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
		await page.mouse.down();
		await page.mouse.move(handle.x - 72, handle.y + 100);
		await page.mouse.up();
		await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(before.width + 50);
		await page.screenshot({ path: path.join(qaDir, "two-terminals-resized-1280x840.png") });

		phase = "preserving the tabs while collapsed";
		await page.getByRole("button", { name: "Hide tools sidebar", exact: true }).click();
		await expect(sidebar).toBeHidden();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await clickCenter(page, page.getByRole("button", { name: "Close Terminal 2", exact: true }));
		await expect(page.getByRole("tab")).toHaveCount(1);
		await sidebar.screenshot({ path: path.join(qaDir, "single-terminal-resized-panel.png") });
		await clickCenter(page, page.getByRole("button", { name: "Close Terminal", exact: true }));
		await expect(page.locator(".tool-sidebar-menu")).toBeVisible();
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged Code files edit the authorized workspace with safe saves and previews", async () => {
	test.setTimeout(75_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-files-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "files-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "files");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	await mkdir(path.join(projectDir, ".git"));
	await mkdir(path.join(projectDir, "archive"));
	await Promise.all([
		writeFixtureFile(path.join(projectDir, "README.md"), "# ArcMind workspace\n\nA real Markdown preview."),
		writeFixtureFile(path.join(projectDir, "notes.txt"), "plain text preview"),
		writeFixtureFile(path.join(projectDir, "docs", "guide.md"), "# Guide\n\nNested file."),
		writeFixtureFile(path.join(projectDir, ".env"), "ARCMIND_FILE_BROWSER=1"),
		writeFixtureFile(path.join(projectDir, ".gitignore"), "ignored.log\n"),
		writeFixtureFile(path.join(projectDir, "ignored.log"), "excluded from search"),
		writeFile(path.join(projectDir, "pixel.png"), Buffer.from(TINY_PNG, "base64")),
		writeFile(path.join(projectDir, "binary.bin"), Buffer.from([0, 1, 2, 3])),
	]);
	createStoredSession(fixtures, agentDir, projectDir, CODE_ID, "code", false, "File browser fixture");

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1304, height: 1000 });
		await waitForServerReady(page);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "File browser fixture", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);

		phase = "opening the Files tool";
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Files", exact: true }).click();
		const sidebar = page.locator(".tool-sidebar");
		const workspaceWidth = Math.round((await page.locator(".workspace").boundingBox())?.width ?? 0);
		await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(
			Math.round(workspaceWidth * 0.44),
		);
		expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await sidebar.screenshot({ path: path.join(qaDir, "open-file-default-width.png") });
		const readme = page.locator('.file-tree-row [title="README.md"]');
		await expect(readme.locator(".file-kind-icon.is-markdown")).toBeVisible();
		await readme.click();
		const editor = page.getByRole("textbox", { name: "Edit README.md", exact: true });
		await expect.poll(() => codeEditorText(editor)).toBe("# ArcMind workspace\n\nA real Markdown preview.");
		await sidebar.screenshot({ path: path.join(qaDir, "direct-editor-default-width.png") });
		const resizeHandle = page.getByRole("separator", { name: "Resize tools sidebar" });
		const resizeSidebar = async (targetWidth: number) => {
			const [box, handle] = await Promise.all([sidebar.boundingBox(), resizeHandle.boundingBox()]);
			if (!box || !handle) throw new Error("Files sidebar resize geometry is missing");
			await page!.mouse.move(handle.x + handle.width / 2, handle.y + 100);
			await page!.mouse.down();
			await page!.mouse.move(handle.x + handle.width / 2 - (targetWidth - box.width), handle.y + 100);
			await page!.mouse.up();
			await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(targetWidth);
		};
		await resizeSidebar(520);
		await page.getByRole("button", { name: "Hide tools sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(520);
		await resizeSidebar(393);
		let [previewBox, treeBox] = await Promise.all([
			page.locator(".file-preview").boundingBox(),
			page.locator(".file-tree").boundingBox(),
		]);
		if (!previewBox || !treeBox) throw new Error("Files split layout is missing");
		expect(treeBox.x).toBeGreaterThanOrEqual(previewBox.x + previewBox.width - 1);
		await sidebar.screenshot({ path: path.join(qaDir, "direct-editor-side-by-side-393x986.png") });
		await resizeSidebar(280);
		[previewBox, treeBox] = await Promise.all([
			page.locator(".file-preview").boundingBox(),
			page.locator(".file-tree").boundingBox(),
		]);
		if (!previewBox || !treeBox) throw new Error("Files stacked layout is missing");
		expect(treeBox.y).toBeGreaterThanOrEqual(previewBox.y + previewBox.height - 1);
		await sidebar.screenshot({ path: path.join(qaDir, "direct-editor-stacked-280x986.png") });
		await resizeSidebar(850);
		await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(800);
		await expect(page.locator('.file-tree-row [title=".env"]')).toBeVisible();
		await expect(page.locator('.file-tree-row [title="ignored.log"]')).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "open-file-1304x1000.png") });

		phase = "previewing and fixing file tabs";
		await expect(page.locator(".tool-tab.is-preview")).toHaveCount(1);
		await readme.dblclick();
		await expect(page.locator(".tool-tab.is-preview")).toHaveCount(0);
		await page.locator('.file-tree-row [title="notes.txt"]').click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.locator(".tool-tab.is-preview")).toHaveCount(1);
		await readme.click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await editor.fill("# Saved from ArcMind\n");
		await expect(page.locator(".tool-tab.is-dirty")).toHaveCount(1);
		await editor.press("Meta+s");
		await expect(page.locator(".file-preview-notice")).toHaveText("File saved");
		await expect.poll(() => readFile(path.join(projectDir, "README.md"), "utf8")).toBe("# Saved from ArcMind\n");
		await expect(page.locator(".tool-tab.is-dirty")).toHaveCount(0);
		await page.getByRole("button", { name: "Show preview", exact: true }).click();
		await expect(page.locator(".file-markdown h1")).toHaveText("Saved from ArcMind");
		await page.getByRole("button", { name: "View source", exact: true }).click();
		await expect.poll(() => codeEditorText(editor)).toBe("# Saved from ArcMind\n");
		await page.getByRole("button", { name: "Copy path", exact: true }).click();
		await expect(page.locator(".file-preview-notice")).toHaveText("Path copied");
		await page.getByRole("button", { name: "Copy contents", exact: true }).click();
		await expect(page.locator(".file-preview-notice")).toHaveText("Contents copied");

		phase = "creating and managing a workspace file";
		await page.getByRole("button", { name: "New file", exact: true }).click();
		let mutationDialog = page.getByRole("dialog", { name: "New file", exact: true });
		await mutationDialog.getByRole("textbox", { name: "Name", exact: true }).fill("scratch.ts");
		await mutationDialog.getByRole("button", { name: "Create", exact: true }).click();
		let scratchEditor = page.getByRole("textbox", { name: "Edit scratch.ts", exact: true });
		await expect(scratchEditor).toBeVisible();
		await expect(page.locator(".cm-gutters")).toBeVisible();
		await expect(page.getByRole("tab", { name: "scratch.ts", exact: true }).locator(".file-kind-icon.is-typescript")).toBeVisible();
		await scratchEditor.fill("export const managed = true;\n");
		await expect(scratchEditor.locator("span", { hasText: /^export$/u })).toHaveCSS("color", "rgb(255, 123, 114)");
		await expect(page.getByRole("button", { name: "Actions for scratch.ts", exact: true }).locator("xpath=..")
			.locator(".file-kind-icon.is-typescript")).toBeVisible();
		await scratchEditor.press("Meta+f");
		await expect(page.locator(".cm-search")).toBeVisible();
		await sidebar.screenshot({ path: path.join(qaDir, "code-editor-find.png") });
		await scratchEditor.press("Escape");

		await page.getByRole("button", { name: "Actions for scratch.ts", exact: true }).click();
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "Rename", exact: true }).click();
		mutationDialog = page.getByRole("dialog", { name: "Rename", exact: true });
		await mutationDialog.getByRole("textbox", { name: "Name", exact: true }).fill("managed.ts");
		await sidebar.screenshot({ path: path.join(qaDir, "rename-file-dialog.png") });
		await mutationDialog.getByRole("button", { name: "Rename", exact: true }).click();
		scratchEditor = page.getByRole("textbox", { name: "Edit managed.ts", exact: true });
		await expect.poll(() => codeEditorText(scratchEditor)).toBe("export const managed = true;\n");
		expect(existsSync(path.join(projectDir, "scratch.ts"))).toBe(false);
		expect(existsSync(path.join(projectDir, "managed.ts"))).toBe(true);

		await page.getByRole("button", { name: "Actions for managed.ts", exact: true }).click();
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "Move to…", exact: true }).click();
		mutationDialog = page.getByRole("dialog", { name: "Move to…", exact: true });
		await mutationDialog.getByRole("textbox", { name: "Destination folder", exact: true }).fill("archive");
		await mutationDialog.getByRole("button", { name: "Move", exact: true }).click();
		await expect(mutationDialog).toBeHidden();
		await scratchEditor.press("Meta+s");
		await expect(page.locator(".file-preview-notice")).toHaveText("File saved");
		await expect.poll(() => readFile(path.join(projectDir, "archive", "managed.ts"), "utf8"))
			.toBe("export const managed = true;\n");
		expect(existsSync(path.join(projectDir, "managed.ts"))).toBe(false);

		await page.locator('.file-tree-row [title="archive"]').click();
		await page.getByRole("button", { name: "Actions for managed.ts", exact: true }).click();
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
		mutationDialog = page.getByRole("dialog", { name: "Move to Trash", exact: true });
		await expect(mutationDialog).toContainText("The saved version can be recovered from Trash.");
		await sidebar.screenshot({ path: path.join(qaDir, "move-file-to-trash-dialog.png") });
		await mutationDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		expect(existsSync(path.join(projectDir, "archive", "managed.ts"))).toBe(true);
		await page.getByRole("button", { name: "Close managed.ts", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Edit managed.ts", exact: true })).toHaveCount(0);

		await resizeSidebar(393);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-393x986.png") });
		await resizeSidebar(280);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-stacked-280x986.png") });
		await resizeSidebar(850);

		phase = "loading nested files and searching with packaged ripgrep";
		await page.locator('.file-tree-row [title="docs"]').click();
		await expect(page.locator('.file-tree-row [title="docs/guide.md"]')).toBeVisible();
		const filter = page.getByRole("searchbox", { name: "Filter files", exact: true });
		await filter.fill("guide");
		await expect(page.locator('.file-tree-row [title="docs/guide.md"]')).toBeVisible();
		await filter.fill("ignored");
		await expect(page.getByText("No matching files", { exact: true })).toBeVisible();
		await filter.fill("");
		await page.locator('.file-tree-row [title="pixel.png"]').click();
		await expect(page.locator(".file-image")).toBeVisible();
		await page.locator('.file-tree-row [title="binary.bin"]').click();
		await expect(page.getByText("Binary file cannot be previewed", { exact: true })).toBeVisible();
		await readme.click();
		await expect.poll(() => codeEditorText(editor)).toBe("# Saved from ArcMind\n");
		await page.getByRole("button", { name: "Close binary.bin", exact: true }).click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await page.setViewportSize({ width: 1220, height: 938 });
		await resizeSidebar(900);
		[previewBox, treeBox] = await Promise.all([
			page.locator(".file-preview").boundingBox(),
			page.locator(".file-tree").boundingBox(),
		]);
		if (!previewBox || !treeBox) throw new Error("Files split layout is missing");
		expect(previewBox.width).toBeGreaterThan(treeBox.width);
		expect(treeBox.width).toBeGreaterThanOrEqual(220);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-900x924.png") });

		phase = "protecting an external file change";
		await writeFile(path.join(projectDir, "README.md"), "# External change\n");
		await editor.fill("# Stale ArcMind draft\n");
		await sidebar.screenshot({ path: path.join(qaDir, "dirty-editor-900x924.png") });
		await editor.press("Meta+s");
		await expect(page.getByRole("alert")).toContainText("Workspace file changed on disk");
		await expect.poll(() => readFile(path.join(projectDir, "README.md"), "utf8")).toBe("# External change\n");
		await expect.poll(() => codeEditorText(editor)).toBe("# Stale ArcMind draft\n");
		await page.getByRole("button", { name: "Close README.md", exact: true }).click();
		await page.screenshot({ path: path.join(qaDir, "unsaved-changes-dialog-1220x938.png") });
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(editor).toBeVisible();
		await page.getByRole("button", { name: "Close README.md", exact: true }).click();
		await page.getByRole("button", { name: "Don’t Save", exact: true }).click();
		await expect(editor).toHaveCount(0);
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged Code review lazily renders diffs and keeps folder-controlled details responsive", async () => {
	test.setTimeout(120_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-review-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "review-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "review");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	const readme = `${Array.from({ length: 120 }, (_, index) =>
		index === 104 ? "hidden-context-marker" : `README line ${index + 1}`).join("\n")}\n`;
	await Promise.all([
		writeFixtureFile(path.join(projectDir, ".codegraph", ".gitignore"), "initial\n"),
		writeFixtureFile(path.join(projectDir, "context.md"), readme),
		writeFixtureFile(path.join(projectDir, "src", "app.ts"), "export const app = true;\n"),
	]);
	git(projectDir, "init");
	git(projectDir, "config", "user.email", "review@example.com");
	git(projectDir, "config", "user.name", "ArcMind Review");
	git(projectDir, "add", ".");
	git(projectDir, "commit", "-m", "initial");
	await writeFixtureFile(path.join(projectDir, "history-only.txt"), "history\n");
	git(projectDir, "add", ".");
	git(projectDir, "commit", "-m", "history fixture");
	git(projectDir, "commit", "--allow-empty", "-m", "empty fixture");
	await writeFile(path.join(projectDir, ".codegraph", ".gitignore"), "changed\n");
	await writeFile(path.join(projectDir, "context.md"), `${readme}Changed in review.\n`);
	await writeFixtureFile(path.join(projectDir, "packages", "nested", "current.ts"), "export const current = true;\n");
	for (let index = 0; index < 175; index += 1) {
		await writeFixtureFile(
			path.join(projectDir, "packages", `group-${Math.floor(index / 16)}`, `change-${index}.ts`),
			`export const change${index} = ${index};\n`,
		);
	}
	createStoredSession(fixtures, agentDir, projectDir, CODE_ID, "code", false, "Review fixture");

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Review fixture", exact: true }).click();
		page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);

		phase = "opening collapsed review files";
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu button").filter({ has: page.getByText("Review", { exact: true }) }).click();
		const sidebar = page.locator(".tool-sidebar");
		const fileHeaders = page.locator(".review-file-header");
		await expect(page.locator(".review-details")).toHaveCount(0);
		await expect(fileHeaders).toHaveCount(178);
		await expect(fileHeaders.first()).toHaveAttribute("aria-expanded", "false");
		await expect(page.locator(".review-patch")).toHaveCount(0);
		const contextHeader = fileHeaders.filter({ hasText: "context.md" });
		await contextHeader.click();
		await expect(page.locator(".review-patch diffs-container")).toHaveCount(1);
		const changedLine = page.locator(".review-patch diffs-container [data-line]").filter({ hasText: "Changed in review." });
		await expect(changedLine).toHaveCount(1);
		await expect(page.locator('.review-patch [data-separator="line-info-basic"]').first()).toBeVisible();
		const unmodifiedLines = page.locator(".review-patch [data-unmodified-lines]").filter({ hasText: "117 unmodified lines" }).first();
		await expect(unmodifiedLines).toBeVisible();
		await expect(page.locator(".review-patch [data-line]").filter({ hasText: "hidden-context-marker" })).toHaveCount(0);
		await unmodifiedLines.click();
		await expect(page.locator(".review-patch [data-line]").filter({ hasText: "hidden-context-marker" })).toHaveCount(1);
		await page.evaluate(() => {
			const state = window as typeof window & { __reviewLongTasks?: number[]; __reviewLongTaskObserver?: PerformanceObserver };
			state.__reviewLongTasks = [];
			if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
				state.__reviewLongTaskObserver = new PerformanceObserver((list) => {
					state.__reviewLongTasks?.push(...list.getEntries().map((entry) => entry.duration));
				});
				state.__reviewLongTaskObserver.observe({ entryTypes: ["longtask"] });
			}
		});
		await sidebar.screenshot({ path: path.join(qaDir, "context-expanded-folder-closed.png") });

		phase = "opening complete information from the folder button";
		await page.getByRole("button", { name: "Show review details", exact: true }).click();
		await expect(page.getByRole("complementary", { name: "Review details", exact: true })).toBeVisible();
		await expect(page.locator(".review-toolbar > span")).toHaveText("master → review-project");
		await expect(page.locator(".review-toolbar > span")).toHaveAttribute("title", await realpath(projectDir));
		await expect(page.getByRole("button", { name: "All Changes", exact: true })).toBeVisible();
		await expect(page.locator('.review-commits button[title="history fixture"]')).toBeVisible();
		await expect(page.locator('.review-details button[aria-expanded="false"]')).toHaveCount(0);
		await expect(page.locator(".review-tree button").filter({ hasText: ".gitignore" })).toBeVisible();
		await expect(page.locator(".review-tree button").filter({ hasText: "current.ts" })).toBeVisible();
		await sidebar.screenshot({ path: path.join(qaDir, "context-expanded-folder-open.png") });

		const resizeHandle = page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
		const resizeSidebar = async (targetWidth: number) => {
			const [box, handle] = await Promise.all([sidebar.boundingBox(), resizeHandle.boundingBox()]);
			if (!box || !handle) throw new Error("Review sidebar resize geometry is missing");
			await page!.mouse.move(handle.x + handle.width / 2, handle.y + 100);
			await page!.mouse.down();
			await page!.mouse.move(handle.x + handle.width / 2 - (targetWidth - box.width), handle.y + 100);
			await page!.mouse.up();
			await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(targetWidth);
		};
		await resizeSidebar(720);
		let [detailsBox, contentBox] = await Promise.all([
			page.locator(".review-details").boundingBox(),
			page.locator(".review-content").boundingBox(),
		]);
		if (!detailsBox || !contentBox) throw new Error("Wide review layout is missing");
		expect(contentBox.x).toBeGreaterThanOrEqual(detailsBox.x + detailsBox.width - 1);
		await sidebar.screenshot({ path: path.join(qaDir, "details-wide.png") });

		await resizeSidebar(500);
		[detailsBox, contentBox] = await Promise.all([
			page.locator(".review-details").boundingBox(),
			page.locator(".review-content").boundingBox(),
		]);
		if (!detailsBox || !contentBox) throw new Error("Narrow review drawer is missing");
		expect(Math.abs(detailsBox.x - contentBox.x)).toBeLessThanOrEqual(1);
		await expect(page.getByRole("button", { name: "Hide review details", exact: true })).toHaveAttribute("aria-expanded", "true");
		await expect(fileHeaders.filter({ hasText: "context.md" })).toHaveAttribute("aria-expanded", "true");
		await sidebar.screenshot({ path: path.join(qaDir, "details-narrow-drawer.png") });

		phase = "preserving state and switching revisions";
		await page.getByRole("button", { name: "Hide review details", exact: true }).click();
		await expect(changedLine).toHaveCount(1);
		await page.getByRole("button", { name: "Show review details", exact: true }).click();
		await page.evaluate(() => {
			const state = window as typeof window & { __reviewBlankTransitions?: number; __reviewBlankObserver?: MutationObserver };
			state.__reviewBlankTransitions = 0;
			const content = document.querySelector(".review-content");
			state.__reviewBlankObserver = new MutationObserver(() => {
				if (content && !content.querySelector(".review-files, .review-empty")) state.__reviewBlankTransitions = (state.__reviewBlankTransitions ?? 0) + 1;
			});
			if (content) state.__reviewBlankObserver.observe(content, { childList: true, subtree: true });
		});
		await page.locator('.review-commits button[title="empty fixture"]').click();
		await expect(page.locator(".review-empty")).toHaveText("No changes");
		await expect(page.locator(".app-error-boundary")).toHaveCount(0);
		await page.locator('.review-commits button[title="history fixture"]').click();
		await expect(fileHeaders).toHaveCount(1);
		await expect(fileHeaders.filter({ hasText: "history-only.txt" })).toBeVisible();
		await expect(fileHeaders.first()).toHaveAttribute("aria-expanded", "false");
		await expect(page.locator('.review-commits button[title="history fixture"]')).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(".app-error-boundary")).toHaveCount(0);
		await page.locator('.review-commits button[title="initial"]').click();
		await expect(fileHeaders).toHaveCount(3);
		await expect(page.locator(".app-error-boundary")).toHaveCount(0);
		await page.getByRole("button", { name: "All Changes", exact: true }).click();
		await expect(fileHeaders).toHaveCount(178);
		await expect(fileHeaders.filter({ hasText: "context.md" })).toBeVisible();
		await expect(fileHeaders.filter({ hasText: "packages/nested/current.ts" })).toBeVisible();
		await expect(page.getByRole("button", { name: "All Changes", exact: true })).toHaveAttribute("aria-pressed", "true");
		expect(await page.evaluate(() => (window as typeof window & { __reviewBlankTransitions?: number }).__reviewBlankTransitions ?? -1)).toBe(0);
		await page.getByRole("button", { name: "Refresh review", exact: true }).click();
		await expect(fileHeaders.first()).toHaveAttribute("aria-expanded", "false");
		const longestTask = await page.evaluate(() => {
			const state = window as typeof window & {
				__reviewBlankObserver?: MutationObserver;
				__reviewLongTaskObserver?: PerformanceObserver;
				__reviewLongTasks?: number[];
			};
			state.__reviewBlankObserver?.disconnect();
			state.__reviewLongTaskObserver?.disconnect();
			return Math.max(0, ...(state.__reviewLongTasks ?? []));
		});
		expect(longestTask).toBeLessThan(100);
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\nrenderer errors:\n${consoleErrors.join("\n").slice(-8_000)}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged browser sidebar loads real pages and persists its isolated profile", async () => {
	test.setTimeout(90_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const fixtureServer = createServer((request, response) => {
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		if (request.url === "/first") {
			response.end("<!doctype html><title>First fixture page</title><main>first page</main>");
			return;
		}
		if (request.url === "/set-cookie") {
			response.setHeader("Set-Cookie", "arcmind-browser=ready; Max-Age=3600; Path=/; SameSite=Lax");
			response.end("<!doctype html><title>ArcMind Browser Fixture</title><main>cookie stored</main>");
			return;
		}
		if (request.url === "/cookie") {
			response.end(`<!doctype html><title>ArcMind Cookie Check</title><main>${request.headers.cookie ?? "missing"}</main>`);
			return;
		}
		if (request.url === "/searchable") {
			response.end("<!doctype html><title>Search Fixture</title><main>open alpha open beta open gamma</main>");
			return;
		}
		if (request.url === "/stateful") {
			response.setHeader("Set-Cookie", "arcmind-browser=ready; Max-Age=3600; Path=/; SameSite=Lax");
			response.end("<!doctype html><title>Stateful Fixture</title><script>localStorage.setItem('arcmind-browser','ready')</script><main>state stored</main>");
			return;
		}
		if (request.url === "/inspect-state") {
			response.end("<!doctype html><title>Inspect State</title><main></main><script>document.querySelector('main').textContent = document.cookie + '|' + (localStorage.getItem('arcmind-browser') || '')</script>");
			return;
		}
		response.writeHead(404).end();
	});
	const fixturePort = await listen(fixtureServer);
	const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-browser-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "browser-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "browser");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);

	let debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const browserTestArguments = process.platform === "darwin" ? ["--use-mock-keychain"] : [];
	let app = launchPackagedApp(
		executable,
		debuggingPort,
		userDataDir,
		projectDir,
		agentDir,
		homeDir,
		diagnostics,
		browserTestArguments,
	);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		const sessionId = await createAndRestoreChatSession(page, projectDir);

		phase = "opening the browser tool";
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		const browserButton = page.locator(".tool-sidebar-menu button").filter({
			has: page.getByText("Browser", { exact: true }),
		});
		await expect(browserButton).toBeEnabled();
		await browserButton.click();
		await expect(page.getByRole("tab", { name: "New tab", exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Browser address", exact: true })).toBeVisible();
		await expect(page.getByText("Start browsing", { exact: true })).toBeVisible();
		const sidebar = page.locator(".tool-sidebar");
		expect(await sidebar.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("9px");
		expect(await sidebar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
		await page.screenshot({ path: path.join(qaDir, "empty-1280x840.png") });
		const resizer = page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
		for (let index = 0; index < 6; index += 1) await resizer.press("ArrowRight");
		await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 1_000).toBeLessThan(340);
		await expect(page.getByRole("button", { name: "Forward", exact: true })).toBeHidden();
		expect(await sidebar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
		await page.screenshot({ path: path.join(qaDir, "empty-narrow-1280x840.png") });
		for (let index = 0; index < 6; index += 1) await resizer.press("ArrowLeft");

		phase = "navigating a real WebContentsView";
		const address = page.getByRole("textbox", { name: "Browser address", exact: true });
		await address.fill(`${fixtureOrigin}/first`);
		await address.press("Enter");
		await expect.poll(() =>
			browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url() === `${fixtureOrigin}/first`),
		).toBe(true);
		let embeddedPage = browser.contexts().flatMap((context) => context.pages())
			.find((candidate) => candidate.url() === `${fixtureOrigin}/first`);
		if (!embeddedPage) throw new Error("Embedded browser target was not exposed");
		await expect(embeddedPage.locator("main")).toHaveText("first page");
		const anchor = page.locator(".browser-view-anchor");
		const embeddedWidth = await embeddedPage.evaluate(() => window.innerWidth);
		const anchorWidth = await anchor.evaluate((element) => Math.round(element.getBoundingClientRect().width));
		expect(Math.abs(embeddedWidth - anchorWidth)).toBeLessThanOrEqual(1);
		await resizer.press("ArrowLeft");
		await expect.poll(() => embeddedPage!.evaluate(() => window.innerWidth)).toBeGreaterThan(embeddedWidth);
		const resizedEmbeddedWidth = await embeddedPage.evaluate(() => window.innerWidth);
		const resizedAnchorWidth = await anchor.evaluate((element) => Math.round(element.getBoundingClientRect().width));
		expect(Math.abs(resizedEmbeddedWidth - resizedAnchorWidth)).toBeLessThanOrEqual(1);
		await resizer.press("ArrowRight");
		await expect(page.getByRole("tab", { name: "First fixture page", exact: true })).toBeVisible();

		await address.fill(`${fixtureOrigin}/set-cookie`);
		await address.press("Enter");
		await expect.poll(() =>
			browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url() === `${fixtureOrigin}/set-cookie`),
		).toBe(true);
		embeddedPage = browser.contexts().flatMap((context) => context.pages())
			.find((candidate) => candidate.url() === `${fixtureOrigin}/set-cookie`);
		if (!embeddedPage) throw new Error("Embedded browser did not navigate to the cookie fixture");
		await expect(embeddedPage.locator("main")).toHaveText("cookie stored");
		await expect(page.getByRole("tab", { name: "ArcMind Browser Fixture", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Back", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "Back", exact: true }).click();
		await expect(embeddedPage).toHaveURL(`${fixtureOrigin}/first`);
		await expect(page.getByRole("button", { name: "Forward", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "Forward", exact: true }).click();
		await expect(embeddedPage).toHaveURL(`${fixtureOrigin}/set-cookie`);
		await page.getByRole("button", { name: "Reload", exact: true }).click();
		await expect(embeddedPage.locator("main")).toHaveText("cookie stored");
		await embeddedPage.screenshot({ path: path.join(qaDir, "loaded-page-1280x840.png") });

		phase = "preserving the browser while collapsed";
		await page.getByRole("button", { name: "Hide tools sidebar", exact: true }).click();
		await expect(sidebar).toBeHidden();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect(page.getByRole("tab", { name: "ArcMind Browser Fixture", exact: true })).toBeVisible();
		expect(embeddedPage.isClosed()).toBe(false);
		await expect(embeddedPage).toHaveURL(`${fixtureOrigin}/set-cookie`);

		phase = "restarting with the same browser profile";
		const browserSession = await browser.newBrowserCDPSession();
		void browserSession.send("Browser.close").catch(() => undefined);
		await expect.poll(() => app.exitCode !== null || app.signalCode !== null).toBe(true);
		browser = undefined;
		debuggingPort = await reservePort();
		app = launchPackagedApp(
			executable,
			debuggingPort,
			userDataDir,
			projectDir,
			agentDir,
			homeDir,
			diagnostics,
			browserTestArguments,
		);
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);
		await expect(page.locator(`[data-active-session-id="${sessionId}"]`)).toBeVisible();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu button").filter({ has: page.getByText("Browser", { exact: true }) }).click();
		const restartedAddress = page.getByRole("textbox", { name: "Browser address", exact: true });
		await restartedAddress.fill(`${fixtureOrigin}/cookie`);
		await restartedAddress.press("Enter");
		await expect.poll(() =>
			browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url() === `${fixtureOrigin}/cookie`),
		).toBe(true);
		const cookiePage = browser.contexts().flatMap((context) => context.pages())
			.find((candidate) => candidate.url() === `${fixtureOrigin}/cookie`);
		if (!cookiePage) throw new Error("Restarted embedded browser target was not exposed");
		await expect(cookiePage.locator("main")).toContainText("arcmind-browser=ready");
		await expect(page.getByRole("tab", { name: "ArcMind Cookie Check", exact: true })).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "cookie-restored-1280x840.png") });

		phase = "finding and zooming inside the native page";
		await restartedAddress.fill(`${fixtureOrigin}/searchable`);
		await restartedAddress.press("Enter");
		await expect(cookiePage).toHaveURL(`${fixtureOrigin}/searchable`);
		await expect(cookiePage.locator("main")).toHaveText("open alpha open beta open gamma");
		await page.getByRole("button", { name: "More browser actions", exact: true }).click();
		const actionsMenu = page.locator(".browser-more-menu");
		await expect(actionsMenu).toBeVisible();
		await expect(page.locator(".browser-view-preview")).toBeVisible();
		const [actionsMenuBox, restartedSidebarBox] = await Promise.all([
			actionsMenu.boundingBox(),
			page.locator(".tool-sidebar").boundingBox(),
		]);
		expect(actionsMenuBox).not.toBeNull();
		expect(restartedSidebarBox).not.toBeNull();
		expect(actionsMenuBox!.x).toBeGreaterThanOrEqual(restartedSidebarBox!.x);
		expect(actionsMenuBox!.x + actionsMenuBox!.width).toBeLessThanOrEqual(
			restartedSidebarBox!.x + restartedSidebarBox!.width,
		);
		await page.screenshot({ path: path.join(qaDir, "actions-menu-1280x840.png"), animations: "disabled" });
		await page.getByRole("menuitem", { name: /Find in page/u }).click();
		const findInput = page.getByRole("textbox", { name: "Find in page", exact: true });
		await expect(findInput).toBeVisible();
		await findInput.fill("open");
		await expect(page.locator(".browser-find-count")).toHaveText("1 / 3 results");
		await findInput.press("Enter");
		await expect(page.locator(".browser-find-count")).toHaveText("2 / 3 results");
		await findInput.press("Shift+Enter");
		await expect(page.locator(".browser-find-count")).toHaveText("1 / 3 results");
		await page.screenshot({ path: path.join(qaDir, "find-panel-1280x840.png"), animations: "disabled" });
		await cookiePage.screenshot({ path: path.join(qaDir, "find-highlights.png"), animations: "disabled" });
		await findInput.press("Escape");
		await expect(findInput).toBeHidden();

		const widthAt100 = await cookiePage.evaluate(() => window.innerWidth);
		await page.getByRole("button", { name: "More browser actions", exact: true }).click();
		const preview = page.locator(".browser-view-preview");
		const previewAt100 = await preview.getAttribute("src");
		await page.getByRole("menuitem", { name: "Zoom in", exact: true }).click();
		await expect.poll(() => cookiePage.evaluate(() => window.innerWidth)).toBeLessThan(widthAt100);
		const zoomInput = page.getByRole("spinbutton", { name: "Zoom percentage", exact: true });
		await expect(zoomInput).toHaveValue("110");
		await expect(page.locator(".browser-more-menu")).toBeVisible();
		await expect.poll(() => preview.getAttribute("src")).not.toBe(previewAt100);
		const widthAt110 = await cookiePage.evaluate(() => window.innerWidth);
		await zoomInput.fill("137");
		await zoomInput.press("Enter");
		await expect(zoomInput).toHaveValue("137");
		await expect.poll(() => cookiePage.evaluate(() => window.innerWidth)).toBeLessThan(widthAt110);
		await page.screenshot({ path: path.join(qaDir, "zoom-custom-137-1280x840.png"), animations: "disabled" });
		await page.getByRole("menuitem", { name: "Reset zoom", exact: true }).click();
		await expect.poll(() => cookiePage.evaluate(() => window.innerWidth)).toBe(widthAt100);
		await expect(zoomInput).toHaveValue("100");
		await page.getByRole("button", { name: "More browser actions", exact: true }).click();

		phase = "clearing shared browsing data without refreshing the tab";
		await restartedAddress.fill(`${fixtureOrigin}/stateful`);
		await restartedAddress.press("Enter");
		await expect(cookiePage).toHaveURL(`${fixtureOrigin}/stateful`);
		await expect(cookiePage.locator("main")).toHaveText("state stored");
		const statefulTitle = await cookiePage.title();
		await page.getByRole("button", { name: "More browser actions", exact: true }).click();
		await page.getByRole("menuitem", { name: "Clear browsing data", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Clear browsing data?", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Clear data", exact: true }).click();
		await expect(page.locator(".browser-toolbar-notice")).toHaveText("Browser data cleared");
		expect(cookiePage.url()).toBe(`${fixtureOrigin}/stateful`);
		expect(await cookiePage.title()).toBe(statefulTitle);
		await expect(cookiePage.locator("main")).toHaveText("state stored");
		await restartedAddress.fill(`${fixtureOrigin}/inspect-state`);
		await restartedAddress.press("Enter");
		await expect(cookiePage).toHaveURL(`${fixtureOrigin}/inspect-state`);
		await expect(cookiePage.locator("main")).toHaveText("|");
		await page.screenshot({ path: path.join(qaDir, "page-actions-1280x840.png"), animations: "disabled" });

		await page.getByRole("button", { name: "Close Inspect State", exact: true }).click();
		await expect(page.locator(".tool-sidebar-menu")).toBeVisible();
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fixtureServer);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged Language menu switches immediately and persists across restart", async () => {
	test.setTimeout(60_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-language-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "language-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "language");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);

	const diagnostics: string[] = [];
	const firstPort = await reservePort();
	let app = launchPackagedApp(
		executable,
		firstPort,
		userDataDir,
		projectDir,
		agentDir,
		homeDir,
		diagnostics,
	);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(firstPort));
		page.setDefaultTimeout(10_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		await waitForServerReady(page);

		phase = "opening Language menu";
		await page.getByRole("button", { name: "ArcMind", exact: true }).click();
		await page.getByRole("menuitem", { name: "Language", exact: true }).click();
		await expect(page.getByRole("menuitemradio", { name: "English", exact: true })).toHaveAttribute("aria-checked", "true");
		await expect(page.getByRole("menuitemradio")).toHaveCount(2);
		const accountMenuBox = await page.locator(".account-menu-popover").boundingBox();
		const languageMenuBox = await page.locator(".account-language-popover").boundingBox();
		expect(accountMenuBox).not.toBeNull();
		expect(languageMenuBox).not.toBeNull();
		expect(languageMenuBox!.x).toBeGreaterThanOrEqual(accountMenuBox!.x + accountMenuBox!.width + 6);
		await page.screenshot({ path: path.join(qaDir, "language-menu-english-1440x900.png") });
		await page.screenshot({
			clip: {
				x: accountMenuBox!.x,
				y: Math.min(accountMenuBox!.y, languageMenuBox!.y),
				width: languageMenuBox!.x + languageMenuBox!.width - accountMenuBox!.x,
				height: Math.max(
					accountMenuBox!.y + accountMenuBox!.height,
					languageMenuBox!.y + languageMenuBox!.height,
				) - Math.min(accountMenuBox!.y, languageMenuBox!.y),
			},
			path: path.join(qaDir, "language-menu-focused.png"),
		});

		phase = "switching to Chinese";
		await page.getByRole("menuitemradio", { name: "中文", exact: true }).click();
		await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
		await expect(page.getByText("技能", { exact: true }).first()).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
		await page.getByRole("button", { name: "ArcMind", exact: true }).click();
		await page.getByRole("menuitem", { name: "语言", exact: true }).click();
		await expect(page.getByRole("menuitemradio", { name: "中文", exact: true })).toHaveAttribute("aria-checked", "true");
		await page.screenshot({ path: path.join(qaDir, "language-menu-chinese-1440x900.png") });

		phase = "restarting with persisted Chinese";
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		const restartPort = await reservePort();
		app = launchPackagedApp(executable, restartPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(restartPort));
		await page.setViewportSize({ width: 960, height: 720 });
		await waitForServerReady(page);
		await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
		await page.getByRole("button", { name: "ArcMind", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toBeFocused();
		await page.screenshot({ path: path.join(qaDir, "chinese-shell-960x720.png") });
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged Code project setup creates and opens a project", async () => {
	test.setTimeout(60_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-code-project-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "launch-cwd");
	const userDataDir = path.join(tempRoot, "electron");
	const assetQaDir = path.join(desktopRoot, "test-results", "design-qa", "assets");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir), mkdir(assetQaDir, { recursive: true })]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		await waitForServerReady(page);
		phase = "opening Code project setup";
		const codeProjectName = "Packaged Code project";
		const codeProjectRoot = path.join(tempRoot, "ArcMind Projects");
		const codeProjectDir = path.join(codeProjectRoot, codeProjectName);
		const defaultLocation = await page.evaluate(() =>
			(globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind.getDefaultProjectLocation(),
		);
		expect(path.isAbsolute(defaultLocation)).toBe(true);
		expect(path.basename(defaultLocation)).toBe("ArcMind Projects");
		await page.evaluate((location) => localStorage.setItem("arcmind.codeProjectLocation", location), codeProjectRoot);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Create a new project" })).toBeVisible();
		await page.screenshot({ path: path.join(assetQaDir, "code-project-choice.png") });

		phase = "checking the existing-folder page";
		await page.getByRole("button", { name: "Use an existing folder", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Use an existing folder" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "Create a new project" })).toBeVisible();

		phase = "creating the project";
		expect(existsSync(codeProjectRoot)).toBe(false);
		await page.getByRole("button", { name: "Start from scratch", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Start a new project" })).toBeVisible();
		await expect(page.locator(".code-project-location")).toContainText(codeProjectRoot);
		await expect(page.getByText("Memory is on", { exact: true })).toHaveCount(0);
		await expect(page.getByText("Instructions", { exact: true })).toHaveCount(0);
		expect(existsSync(codeProjectRoot)).toBe(false);
		await page.locator("#code-project-name").fill(codeProjectName);
		await page.getByRole("button", { name: "Create", exact: true }).click();
		await expect(page.locator("#composer-input")).toBeVisible();
		expect(existsSync(codeProjectDir)).toBe(true);
		const canonicalCodeProjectDir = await realpath(codeProjectDir);
		const codeSession = await page.evaluate(async (cwd) => {
			const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
			return (await api.listSessions({ limit: 200 })).sessions.find(
				(session) => session.mode === "code" && session.cwd === cwd,
			);
		}, canonicalCodeProjectDir);
		expect(codeSession).toMatchObject({ mode: "code", cwd: canonicalCodeProjectDir, cwdOrigin: "user-selected" });
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", codeSession!.sessionId);
		await page.getByRole("button", { name: "New task", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Create a new project" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged mode project actions preserve the other mode and shared project data", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-project-actions-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "shared-project");
	const userDataDir = path.join(tempRoot, "electron");
	const sourcePath = path.join(projectDir, "source-sentinel.txt");
	const skillPath = path.join(projectDir, ".arcmind", "skills", "shared-project-skill", "SKILL.md");
	const globalMemoryPath = path.join(agentDir, "memory", "MEMORY.md");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "project-actions");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	await fixtures.ensureModeScopedMemoryLayout(agentDir);

	const chatActivePath = createStoredSession(fixtures, agentDir, projectDir, CHAT_ACTIVE_ID, "chat");
	const chatArchivedPath = createStoredSession(fixtures, agentDir, projectDir, CHAT_ARCHIVED_ID, "chat", true);
	const codePath = createStoredSession(fixtures, agentDir, projectDir, CODE_ID, "code");
	const sessionActionPath = createStoredSession(
		fixtures,
		agentDir,
		projectDir,
		SESSION_ACTION_ID,
		"chat",
		false,
		"Session action target",
	);
	const sessionActionOwnedPaths = await seedOwnedSessionData(
		fixtures,
		agentDir,
		SESSION_ACTION_ID,
		sessionActionPath,
	);
	const sessionActionRecoveryPath = path.join(
		path.dirname(sessionActionPath),
		`.${path.basename(sessionActionPath)}.00000000-0000-4000-8000-000000000001.replace.bak`,
	);
	await writeFixtureFile(sessionActionRecoveryPath, await readFile(sessionActionPath, "utf8"));
	const ownedPaths = [
		...(await seedOwnedSessionData(fixtures, agentDir, CHAT_ACTIVE_ID, chatActivePath)),
		...(await seedOwnedSessionData(fixtures, agentDir, CHAT_ARCHIVED_ID, chatArchivedPath)),
	];
	const chatMemory = fixtures.getAutoMemoryPaths(agentDir, projectDir, "chat").project;
	const codeMemory = fixtures.getAutoMemoryPaths(agentDir, projectDir, "code").project;
	await Promise.all([
		writeFixtureFile(chatMemory.indexPath, "chat-only memory"),
		writeFixtureFile(codeMemory.indexPath, "code-only memory"),
		writeFixtureFile(globalMemoryPath, "shared global memory"),
		writeFixtureFile(sourcePath, "source must survive"),
		writeFixtureFile(
			skillPath,
			"---\nname: shared-project-skill\ndescription: Shared by Chat and Code\n---\n",
		),
	]);
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);
	await fixtures.ScheduleManager.create({ agentDir }).create({
		id: SCHEDULE_ID,
		name: "Fixed project schedule",
		instruction: "Keep this fixed project",
		model: { provider: "test", modelId: "fixed-project-model" },
		schedule: { kind: "daily", time: "09:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "fixed", cwd: projectDir },
	});

	let debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	let app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	let scheduleRemoved = false;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		await waitForServerReady(page);
		await groupSessionsBy(page, "Project");
		const projectName = path.basename(projectDir);
		let group = projectGroup(page, projectName);
		await expect(group).toBeVisible();
		phase = "renaming and deleting one idle session";
		let sessionActionRow = group.locator(
			'.session-row:has(.session-button[aria-label="Session action target"])',
		);
		const sessionActionButton = sessionActionRow.locator(".session-actions > button");
		const sessionButton = sessionActionRow.locator(".session-button");
		await expect(sessionActionButton).toHaveCSS("opacity", "0");
		await sessionActionRow.hover();
		await expect(sessionActionButton).toHaveCSS("opacity", "1");
		await sessionActionButton.hover();
		await expect(sessionButton).toHaveCSS("background-color", "rgb(64, 64, 64)");
		await expect(sessionActionButton).toHaveCSS("background-color", "rgb(104, 104, 104)");
		await page.locator(".session-sidebar").screenshot({ path: path.join(qaDir, "session-row-hover-inactive.png") });
		await sessionActionRow.getByRole("button", { name: "Session action target", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", SESSION_ACTION_ID);
		await sessionActionButton.hover();
		await expect(sessionButton).toHaveCSS("background-color", "rgb(88, 88, 88)");
		await expect(sessionActionButton).toHaveCSS("background-color", "rgb(104, 104, 104)");
		await page.locator(".session-sidebar").screenshot({ path: path.join(qaDir, "session-row-hover-current.png") });
		await sessionActionRow.getByRole("button", { name: "Actions for Session action target" }).click();
		const sessionActionMenu = page.getByRole("menu", { name: "Session action target session actions" });
		await expect(sessionActionMenu.getByRole("menuitem")).toHaveText(["Rename", "Delete"]);
		await expect(sessionActionRow.locator(".session-action-menu")).toHaveCount(0);
		const sessionMenuBox = await sessionActionMenu.boundingBox();
		const viewportHeight = await page.evaluate(() => window.innerHeight);
		expect(sessionMenuBox).not.toBeNull();
		expect(sessionMenuBox!.y).toBeGreaterThanOrEqual(8);
		expect(sessionMenuBox!.y + sessionMenuBox!.height).toBeLessThanOrEqual(viewportHeight - 8);
		await sessionActionMenu.getByRole("menuitem", { name: "Rename" }).click();
		const renameSessionDialog = page.getByRole("dialog", { name: "Rename session" });
		await renameSessionDialog.locator("#session-rename-input").fill("Renamed session target");
		await renameSessionDialog.getByRole("button", { name: "Rename", exact: true }).click();
		await expect.poll(async () => readFile(sessionActionPath, "utf8")).toContain("Renamed session target");
		sessionActionRow = group.locator(
			'.session-row:has(.session-button[aria-label="Renamed session target"])',
		);
		await sessionActionRow.hover();
		await sessionActionRow.getByRole("button", { name: "Actions for Renamed session target" }).click();
		await page.getByRole("menu", { name: "Renamed session target session actions" }).getByRole("menuitem", { name: "Delete" }).click();
		const deleteSessionDialog = page.getByRole("dialog", { name: "Delete session?" });
		await expect(deleteSessionDialog).toContainText("Project memory, Skills, schedules, other sessions, and source files are unchanged");
		await deleteSessionDialog.getByRole("button", { name: "Move to Trash" }).click();
		await expect(page.getByText("What can I take off your plate?", { exact: true })).toBeVisible();
		for (const removedPath of [sessionActionPath, sessionActionRecoveryPath, ...sessionActionOwnedPaths]) {
			expect(existsSync(removedPath), removedPath).toBe(false);
		}
		group = projectGroup(page, projectName);
		phase = "changing persisted session permissions";
		await group.locator(".session-button").first().click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CHAT_ACTIVE_ID);
		await page.getByRole("button", { name: "Select permissions, current Ask" }).click();
		await page.getByRole("menuitemradio", { name: /Full access/u }).click();
		await expect(page.getByRole("button", { name: "Select permissions, current Full" })).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect.poll(async () => readFile(chatActivePath, "utf8")).toContain('"permissionMode":"full"');
		await page.getByRole("button", { name: "Select permissions, current Full" }).click();
		await page.locator(".permission-selector-popover").evaluate(
			(element) => Promise.all(element.getAnimations().map((animation) => animation.finished)),
		);
		await page.screenshot({ path: path.join(qaDir, "permission-menu-normal.png") });
		await page.getByRole("menuitemradio", { name: /Ask before changes/u }).click();
		await expect(page.getByRole("button", { name: "Select permissions, current Ask" })).toBeVisible();
		await expect.poll(async () => readFile(chatActivePath, "utf8")).toContain('"permissionMode":"ask"');

		const actionButtons = group.locator(".project-action-buttons");
		await expect(actionButtons).toHaveCSS("opacity", "0");
		await showProjectActions(group);
		await group.locator(".project-heading").click();
		await expect(group.locator(".project-heading")).toHaveAttribute("aria-expanded", "false");
		await expect(group.locator(".project-drawer")).toHaveAttribute("inert", "");
		await expect(group.locator(".project-sessions")).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, -9\)/u);
		await showProjectActions(group);
		await group.getByRole("button", { name: "Project actions" }).click();
		await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
		await page.keyboard.press("Escape");
		await group.locator(".project-heading").click();
		await expect(group.locator(".project-heading")).toHaveAttribute("aria-expanded", "true");
		await expect(group.locator(".project-sessions")).toHaveCSS("transform", "none");

		phase = "renaming and pinning Chat";
		await showProjectActions(group);
		await group.getByRole("button", { name: "Project actions" }).click();
		const projectActionMenu = page.getByRole("menu", { name: `${projectName} project actions` });
		await expect(projectActionMenu.getByRole("menuitem")).toHaveText(["Rename", "Pin", "Delete"]);
		await expect(group.locator(".project-action-menu")).toHaveCount(0);
		const projectMenuBox = await projectActionMenu.boundingBox();
		expect(projectMenuBox).not.toBeNull();
		expect(projectMenuBox!.y).toBeGreaterThanOrEqual(8);
		expect(projectMenuBox!.y + projectMenuBox!.height).toBeLessThanOrEqual(viewportHeight - 8);
		await page.screenshot({ path: path.join(qaDir, "project-menu-normal.png") });
		await projectActionMenu.getByRole("menuitem", { name: "Rename" }).click();
		await expect(page.getByRole("dialog", { name: "Rename project" })).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "rename-dialog-normal.png") });
		await page.locator("#project-rename-input").fill("Pinned Chat Project");
		await page.getByRole("dialog", { name: "Rename project" }).getByRole("button", { name: "Rename" }).click();
		await page.getByRole("menuitem", { name: "Pin" }).click();
		group = projectGroup(page, "Pinned Chat Project");
		await expect(group).toBeVisible();

		phase = "checking mode-scoped preferences";
		await page.evaluate((sessionId) => localStorage.setItem("arcmind.activeSessionId.code", sessionId), CODE_ID);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);
		await page.getByRole("button", { name: "Group sessions", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "Group by Date", exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await groupSessionsBy(page, "Project");
		const codeGroup = projectGroup(page, projectName);
		await expect(codeGroup).toBeVisible();
		await expect(codeGroup.locator(".project-heading span")).toHaveText(projectName);
		await showProjectActions(codeGroup);
		await codeGroup.getByRole("button", { name: "Project actions" }).click();
		await expect(page.getByRole("menuitem", { name: "Pin" })).toBeVisible();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Chat", exact: true }).click();

		phase = "creating an empty Chat session";
		group = projectGroup(page, "Pinned Chat Project");
		await showProjectActions(group);
		await group.getByRole("button", { name: "New task in Pinned Chat Project" }).click();
		const workspaceHeader = page.locator(".workspace-header");
		await expect.poll(
			() => workspaceHeader.getAttribute("data-active-session-id"),
		).not.toBe(CHAT_ACTIVE_ID);
		const createdSessionId = await workspaceHeader.getAttribute("data-active-session-id");
		expect(createdSessionId).not.toBeNull();
		expect([CHAT_ACTIVE_ID, CHAT_ARCHIVED_ID, CODE_ID]).not.toContain(createdSessionId);
		await expect(page.locator(".transcript-turn")).toHaveCount(0);

		phase = "checking the schedule blocker";
		group = projectGroup(page, "Pinned Chat Project");
		const projectActions = group.getByRole("button", { name: "Project actions" });
		await showProjectActions(group);
		await expect(projectActions).toBeEnabled();
		await projectActions.click({ timeout: 10_000 });
		phase = "opening the blocked delete dialog";
		const deleteMenuItem = page.getByRole("menuitem", { name: "Delete" });
		await expect(deleteMenuItem).toBeVisible();
		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		const utilityPid = appServerPid(rootPid);
		if (!utilityPid) throw new Error("Could not find the packaged App Server");
		process.kill(utilityPid, "SIGSTOP");
		try {
			await deleteMenuItem.click({ timeout: 10_000 });
			await expect(page.getByText("Checking project data…", { exact: true })).toBeVisible();
			await page.screenshot({ path: path.join(qaDir, "delete-loading-normal.png") });
		} finally {
			process.kill(utilityPid, "SIGCONT");
		}
		const deleteDialog = page.getByRole("dialog", { name: "Delete Chat project?" });
		await expect(deleteDialog.getByText("3 Chat sessions", { exact: false })).toBeVisible();
		await expect(deleteDialog.getByText("1 fixed-workspace schedules block deletion", { exact: false })).toBeVisible();
		await expect(deleteDialog.getByRole("button", { name: "Move to Trash" })).toBeDisabled();
		await page.screenshot({ path: path.join(qaDir, "delete-blocker-normal.png") });

		phase = "removing the test schedule and loading a fresh preview";
		await deleteDialog.getByRole("button", { name: "Cancel" }).click();
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		await fixtures.ScheduleManager.create({ agentDir }).delete(SCHEDULE_ID, { deleteSessions: false });
		scheduleRemoved = true;
		debuggingPort = await reservePort();
		app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(debuggingPort));
		await waitForServerReady(page);
		await expect(projectGroup(page, "Pinned Chat Project")).toBeVisible();
		await page.setViewportSize({ width: 900, height: 720 });
		group = projectGroup(page, "Pinned Chat Project");
		await showProjectActions(group);
		await group.getByRole("button", { name: "Project actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const readyDeleteDialog = page.getByRole("dialog", { name: "Delete Chat project?" });
		await expect(readyDeleteDialog.getByRole("button", { name: "Move to Trash" })).toBeEnabled();
		await page.screenshot({ path: path.join(qaDir, "delete-ready-narrow.png") });
		await page.setViewportSize({ width: 450, height: 360 });
		await expect(readyDeleteDialog).toBeInViewport();
		await readyDeleteDialog.getByRole("button", { name: "Move to Trash" }).scrollIntoViewIfNeeded();
		await expect(readyDeleteDialog.getByRole("button", { name: "Move to Trash" })).toBeInViewport();
		await page.screenshot({ path: path.join(qaDir, "delete-ready-zoom-200.png") });
		await page.setViewportSize({ width: 900, height: 720 });

		phase = "deleting Chat through the visible dialog";
		await readyDeleteDialog.getByRole("button", { name: "Move to Trash" }).click();
		await page.screenshot({ path: path.join(qaDir, "delete-deleting-narrow.png") });
		await expect(projectGroup(page, "Pinned Chat Project")).toHaveCount(0);
		await page.screenshot({ path: path.join(qaDir, "delete-success-narrow.png") });

		phase = "verifying exact disk preservation";
		for (const removedPath of [chatActivePath, chatArchivedPath, chatMemory.directory, ...ownedPaths]) {
			expect(existsSync(removedPath), removedPath).toBe(false);
		}
		for (const preservedPath of [codePath, codeMemory.indexPath, globalMemoryPath, sourcePath, skillPath]) {
			expect(existsSync(preservedPath), preservedPath).toBe(true);
		}
		expect(await readFile(codeMemory.indexPath, "utf8")).toBe("code-only memory");
		expect(await readFile(globalMemoryPath, "utf8")).toBe("shared global memory");
		expect(await readFile(sourcePath, "utf8")).toBe("source must survive");
		expect(new fixtures.ProjectTrustStore(agentDir).get(projectDir)).toBe(true);

		phase = "reopening Code and shared Skills";
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await projectGroup(page, projectName).locator(".session-button").click();
		await expect(page.locator(`[data-active-session-id="${CODE_ID}"]`)).toBeVisible();
		await page.getByRole("button", { name: "Skills", exact: true }).click();
		await page.getByRole("button", { name: "Project", exact: true }).click();
		await page.locator(".skills-directory-list").getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("button", { name: projectName, exact: true }).click();
		await expect(page.getByText("shared-project-skill", { exact: true })).toBeVisible();
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		if (!scheduleRemoved) await fixtures.ScheduleManager.create({ agentDir }).delete(SCHEDULE_ID, { deleteSessions: false }).catch(() => undefined);
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("packaged project delete fails closed for a held session lease and retries", async () => {
	test.setTimeout(60_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-project-lease-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "lease-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "project-actions");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir), mkdir(qaDir, { recursive: true })]);
	const held = fixtures.SessionManager.create(projectDir, fixtures.getDefaultSessionDir(projectDir, agentDir), {
		id: CHAT_ACTIVE_ID,
		mode: "chat",
	});
	const sessionPath = held.getSessionFile();
	if (!sessionPath) throw new Error("Held session fixture was not persisted");
	const ownedPaths = await seedOwnedSessionData(fixtures, agentDir, CHAT_ACTIVE_ID, sessionPath);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	let leaseReleased = false;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		await waitForServerReady(page);
		await groupSessionsBy(page, "Project");
		const group = projectGroup(page, path.basename(projectDir));
		await expect(group).toBeVisible();
		await showProjectActions(group);
		await group.getByRole("button", { name: "Project actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const dialog = page.getByRole("dialog", { name: "Delete Chat project?" });
		await expect(dialog.getByRole("button", { name: "Move to Trash" })).toBeEnabled();

		phase = "verifying the held-lease failure";
		await dialog.getByRole("button", { name: "Move to Trash" }).click();
		await expect(dialog.getByText("still in use", { exact: false })).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "delete-error-held-lease.png") });
		for (const preservedPath of [sessionPath, ...ownedPaths]) expect(existsSync(preservedPath), preservedPath).toBe(true);

		phase = "releasing the lease and retrying";
		held.close();
		leaseReleased = true;
		await dialog.getByRole("button", { name: "Retry" }).click();
		await expect(dialog.getByRole("button", { name: "Move to Trash" })).toBeEnabled();
		await dialog.getByRole("button", { name: "Move to Trash" }).click();
		await expect(projectGroup(page, path.basename(projectDir))).toHaveCount(0);
		for (const removedPath of [sessionPath, ...ownedPaths]) expect(existsSync(removedPath), removedPath).toBe(false);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		if (!leaseReleased) held.close();
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});
