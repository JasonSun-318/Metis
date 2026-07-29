import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
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

interface FixtureSessionManager {
	close(): void;
	getSessionFile(): string | undefined;
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
			delete(taskId: string): Promise<unknown>;
		};
	};
	readonly SessionManager: {
		create(
			cwd: string,
			sessionDir: string,
			options: { id: string; mode: "chat" | "code" },
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
): string {
	const manager = fixtures.SessionManager.create(projectDir, fixtures.getDefaultSessionDir(projectDir, agentDir), {
		id: sessionId,
		mode,
	});
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

function launchPackagedApp(
	executable: string,
	debuggingPort: number,
	userDataDir: string,
	projectDir: string,
	agentDir: string,
	homeDir: string,
	diagnostics: string[],
) {
	const app = spawn(executable, [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`], {
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
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-packaged-smoke-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const extensionDir = path.join(projectDir, ".arcmind", "extensions");
	const projectSkillDir = path.join(projectDir, ".arcmind", "skills", "packaged-project-skill");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(extensionDir, { recursive: true }),
		mkdir(projectSkillDir, { recursive: true }),
		mkdir(userDataDir),
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
		await expect(page.locator(".skills-empty-state img")).toBeVisible();
		await expect(page.getByText("No user skills", { exact: true })).toBeVisible();
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

		phase = "reloading and restarting";
		await page.reload({ waitUntil: "domcontentloaded" });
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
		instruction: "Keep this fixed project",
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
		await waitForServerReady(page);
		const projectName = path.basename(projectDir);
		let group = projectGroup(page, projectName);
		await expect(group).toBeVisible();

		phase = "renaming and pinning Chat";
		await group.getByRole("button", { name: "Project actions" }).click();
		await expect(group.getByRole("menuitem")).toHaveText(["Rename", "Pin", "Delete"]);
		await page.screenshot({ path: path.join(qaDir, "project-menu-normal.png") });
		await group.getByRole("menuitem", { name: "Rename" }).click();
		await expect(page.getByRole("dialog", { name: "Rename project" })).toBeVisible();
		await page.screenshot({ path: path.join(qaDir, "rename-dialog-normal.png") });
		await page.locator("#project-rename-input").fill("Pinned Chat Project");
		await page.getByRole("dialog", { name: "Rename project" }).getByRole("button", { name: "Rename" }).click();
		await page.getByRole("menuitem", { name: "Pin" }).click();
		group = projectGroup(page, "Pinned Chat Project");
		await expect(group).toBeVisible();

		phase = "checking mode-scoped preferences";
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const codeGroup = projectGroup(page, projectName);
		await expect(codeGroup).toBeVisible();
		await expect(codeGroup.locator(".project-heading span")).toHaveText(projectName);
		await codeGroup.getByRole("button", { name: "Project actions" }).click();
		await expect(codeGroup.getByRole("menuitem", { name: "Pin" })).toBeVisible();
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Chat", exact: true }).click();

		phase = "creating an empty Chat session";
		group = projectGroup(page, "Pinned Chat Project");
		await group.getByRole("button", { name: "New task in Pinned Chat Project" }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", /.+/u);
		const createdSessionId = await page.locator(".workspace-header").getAttribute("data-active-session-id");
		expect(createdSessionId).not.toBeNull();
		expect([CHAT_ACTIVE_ID, CHAT_ARCHIVED_ID, CODE_ID]).not.toContain(createdSessionId);
		await expect(page.locator(".transcript-turn")).toHaveCount(0);

		phase = "checking the schedule blocker";
		group = projectGroup(page, "Pinned Chat Project");
		const projectActions = group.getByRole("button", { name: "Project actions" });
		await expect(projectActions).toBeEnabled();
		await projectActions.click({ timeout: 10_000 });
		phase = "opening the blocked delete dialog";
		const deleteMenuItem = group.getByRole("menuitem", { name: "Delete" });
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
		await fixtures.ScheduleManager.create({ agentDir }).delete(SCHEDULE_ID);
		scheduleRemoved = true;
		debuggingPort = await reservePort();
		app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(debuggingPort));
		await waitForServerReady(page);
		await expect(projectGroup(page, "Pinned Chat Project")).toBeVisible();
		await page.setViewportSize({ width: 900, height: 720 });
		group = projectGroup(page, "Pinned Chat Project");
		await group.getByRole("button", { name: "Project actions" }).click();
		await group.getByRole("menuitem", { name: "Delete" }).click();
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
		if (!scheduleRemoved) await fixtures.ScheduleManager.create({ agentDir }).delete(SCHEDULE_ID).catch(() => undefined);
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
		const group = projectGroup(page, path.basename(projectDir));
		await expect(group).toBeVisible();
		await group.getByRole("button", { name: "Project actions" }).click();
		await group.getByRole("menuitem", { name: "Delete" }).click();
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
