import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { createMcpTestServer } from "../../coding-agent/test/helpers/mcp-test-server.ts";
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

async function appServerLogTail(userDataDir: string): Promise<string> {
	const log = await readFile(path.join(userDataDir, "logs", "app-server.log"), "utf8").catch(() => "");
	return log ? `\napp-server.log tail:\n${log.slice(-4_000)}` : "";
}

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

const CHAT_ACTIVE_ID = "10000000-0000-4000-8000-000000000001";
const CHAT_ARCHIVED_ID = "10000000-0000-4000-8000-000000000002";
const CODE_ID = "10000000-0000-4000-8000-000000000003";
const SCHEDULE_ID = "10000000-0000-4000-8000-000000000004";
const SESSION_ACTION_ID = "10000000-0000-4000-8000-000000000005";
const COMPLETED_TASK_ID = "10000000-0000-4000-8000-000000000006";
const TEMP_REMOVE_OPTIONS = { force: true, maxRetries: 10, recursive: true, retryDelay: 200 } as const;

function cssGridTrackCount(template: string): number {
	const repeat = /^repeat\((\d+)/u.exec(template.trim());
	if (repeat) return Number(repeat[1]);
	return template.split(/\s+(?![^(]*\))/u).filter(Boolean).length;
}

function authHasMcpServer(auth: Record<string, unknown>, name: string): boolean {
	const encoded = encodeURIComponent(name);
	return Object.keys(auth).some(
		(key) =>
			key.endsWith(`:${name}`) ||
			key.endsWith(`:${encoded}`) ||
			key.includes(`:${name}:`) ||
			key.includes(`:${encoded}:`),
	);
}

interface FixtureSessionManager {
	appendAgentControl(payload: object): string;
	appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	appendMessage(message: object, toolOutput?: unknown): string;
	appendSessionInfo(name: string): string;
	appendThinkingLevelChange(thinkingLevel: string): string;
	close(): void;
	getSessionFile(): string | undefined;
}

interface FixtureMemoryStore {
	resolveProject(identity: { canonicalCwd: string; projectKey: string; legacyKey: string }): unknown;
	insertFact(fact: {
		id: string;
		scope: "global" | "project";
		cwdKey: string | null;
		mode: null;
		topicFile: string;
		text: string;
		status: "active";
		createdAt: string;
		sourceTurn: null;
		embedding: null;
		embeddingModel: null;
	}): boolean;
	close(): void;
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
	) => { readonly project: { readonly directory: string; readonly indexPath: string } };
	readonly getMemorySqlitePath: (agentDir: string) => string;
	readonly memoryProjectIdentity: (cwd: string) => { canonicalCwd: string; projectKey: string; legacyKey: string };
	readonly openMemoryStore: (path: string) => FixtureMemoryStore;
	readonly writeMemoryProjection: (
		agentDir: string,
		projectKey: string,
		store: FixtureMemoryStore,
	) => Promise<void>;
	readonly getDefaultSessionDir: (cwd: string, agentDir: string) => string;
	readonly getSessionAttachmentDir: (agentDir: string, sessionId: string) => string;
	readonly getSessionImageDir: (sessionFile: string) => string;
	readonly getSessionAgentDir: (agentDir: string, sessionId: string) => string;
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
				permissionPreset?: "ask" | "auto" | "full";
				agent?: {
					agentId: string;
					name: string;
					agentType: "default" | "explorer" | "worker" | "reviewer";
					parentSessionId: string;
					rootSessionId: string;
					agentPath: readonly string[];
					cwd: string;
					tools: readonly string[];
					writePolicy: "inherit" | "deny";
					permissionPreset: "ask" | "auto" | "full";
					model: { provider: string; modelId: string };
					thinkingLevel: string;
					initialTask: string;
					forkTurns: number;
					timeoutSeconds: number;
					mayDelegate: boolean;
				};
			},
		): FixtureSessionManager;
	};
}

async function loadCodingFixtures(): Promise<CodingFixtures> {
	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	const [memory, memoryProject, memoryProjection, memoryStore, attachments, sessions, schedules, trust] = await Promise.all([
		importEsm(pathToFileURL(path.join(coreRoot, "auto-memory.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "memory", "memory-project.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "memory", "memory-projection.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "memory", "memory-store.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "session-attachments.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "schedules", "manager.js")).href),
		importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href),
	]);
	return {
		createSessionWorkDir: attachments.createSessionWorkDir,
		ensureModeScopedMemoryLayout: memory.ensureModeScopedMemoryLayout,
		getAutoMemoryPaths: memory.getAutoMemoryPaths,
		getMemorySqlitePath: memory.getMemorySqlitePath,
		memoryProjectIdentity: memoryProject.memoryProjectIdentity,
		openMemoryStore: memoryStore.openMemoryStore,
		writeMemoryProjection: memoryProjection.writeProjection,
		getDefaultSessionDir: sessions.getDefaultSessionDir,
		getSessionAttachmentDir: attachments.getSessionAttachmentDir,
		getSessionImageDir: sessions.getSessionImageDir,
		getSessionAgentDir: sessions.getSessionAgentDir,
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
	const previousAgentDir = process.env.METIS_CODING_AGENT_DIR;
	process.env.METIS_CODING_AGENT_DIR = agentDir;
	const imageDir = fixtures.getSessionImageDir(sessionFile);
	const toolOutputDir = fixtures.getSessionToolOutputDir(sessionFile);
	if (previousAgentDir === undefined) delete process.env.METIS_CODING_AGENT_DIR;
	else process.env.METIS_CODING_AGENT_DIR = previousAgentDir;
	return Promise.all([
		writeFixtureFile(path.join(imageDir, "image.png"), "chat image"),
		writeFixtureFile(path.join(toolOutputDir, "tool.txt"), "chat tool output"),
		writeFixtureFile(path.join(fixtures.getSessionAttachmentDir(agentDir, sessionId), "attachment.txt"), "chat attachment"),
		writeFixtureFile(path.join(fixtures.getSessionAgentDir(agentDir, sessionId), "owned-marker.txt"), "agent data"),
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

async function resolvedColor(page: Page, property: string): Promise<string> {
	return page.evaluate((name) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, property);
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
			METIS_CODING_AGENT_DIR: agentDir,
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

test("packaged task list uses the Metis composer UI in Chat and Code", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-task-list-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "transcript");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir), mkdir(qaDir, { recursive: true })]);

	const taskItems = [
		{ task: "Inspect implementation", completed: false },
		{ task: "Confirm protocol projection", completed: true },
		{ task: "Verify session isolation", completed: false },
		{ task: "Polish Metis styling", completed: false },
		{ task: "Run packaged checks", completed: false },
		{ task: "Complete visual review", completed: false },
	];
	const createTaskSession = (
		sessionId: string,
		mode: "chat" | "code",
		name: string,
		tasks = taskItems,
		compacted = false,
		withTranscriptFixture = false,
	) => {
		const manager = fixtures.SessionManager.create(
			projectDir,
			fixtures.getDefaultSessionDir(projectDir, agentDir),
			{ id: sessionId, mode },
		);
		manager.appendSessionInfo(name);
		if (withTranscriptFixture) manager.appendMessage({
			...assistantMessage(Date.now() - 3, 0),
			content: [{ type: "toolCall", id: `set-tasks-${mode}`, name: "set_tasks", arguments: { tasks } }],
			stopReason: "toolUse",
		});
		const taskEntryId = manager.appendMessage({
			role: "toolResult",
			toolCallId: `set-tasks-${mode}`,
			toolName: "set_tasks",
			content: [{
				type: "text",
				text: ["<task_list>", ...tasks.map(({ task, completed }) => `- [${completed ? "x" : " "}] ${task}`), "</task_list>"].join("\n"),
			}],
			details: { tasks },
			isError: false,
			timestamp: Date.now(),
		});
		if (compacted) manager.appendCompaction("private packaged summary", taskEntryId, 64_000, undefined, false);
		if (withTranscriptFixture && mode === "chat") {
			manager.appendMessage({
				...assistantMessage(Date.now() + 1, 0),
				content: [{
					type: "toolCall",
					id: "ask-user-chat",
					name: "ask_user",
					arguments: {
						questions: [{
							question: "How should Metis answer?",
							multiple: false,
							options: [{ label: "Concise", description: "Keep it short" }, { label: "Detailed", description: "Explain fully" }],
						}],
					},
				}],
				stopReason: "toolUse",
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "ask-user-chat",
				toolName: "ask_user",
				content: [{
					type: "text",
					text: `User answers:\n${JSON.stringify([{ question: "How should Metis answer?", selected: ["Concise"] }], null, 2)}`,
				}],
				isError: false,
				timestamp: Date.now() + 2,
			});
		}
		if (withTranscriptFixture) manager.appendMessage({
			...assistantMessage(Date.now() + 3, 0),
			content: [{ type: "text", text: "Metis keeps readable content rhythm while the selected font size changes." }],
		});
		manager.close();
	};
	createTaskSession(CHAT_ACTIVE_ID, "chat", "Task list Chat fixture", taskItems, true, true);
	createTaskSession(CODE_ID, "code", "Task list Code fixture", taskItems, false, true);
	createTaskSession(
		COMPLETED_TASK_ID,
		"chat",
		"Completed task list fixture",
		taskItems.map((task) => ({ ...task, completed: true })),
	);
	await writeFixtureFile(
		path.join(projectDir, ".metis", "skills", "e2e-skill", "SKILL.md"),
		"---\nname: e2e-skill\ndescription: Packaged slash command fixture\n---\n\nUse this fixture for packaged testing.\n",
	);
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		await page.setViewportSize({ width: 1280, height: 840 });
		await waitForServerReady(page);

		phase = "checking expanded Chat task list";
		await page.getByRole("button", { name: "Chat", exact: true }).click();
		await page.getByRole("button", { name: "Task list Chat fixture", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CHAT_ACTIVE_ID);
		const chatToolChain = page.locator(".execution-chain").last();
		await expect(chatToolChain).not.toHaveAttribute("open", "");
		await chatToolChain.locator(":scope > summary").click();
		await expect(chatToolChain).toContainText("How should Metis answer?");
		await expect(chatToolChain).toContainText("Concise");
		await expect(chatToolChain).not.toContainText('"questions"');
		await expect(chatToolChain).not.toContainText('"multiple"');
		await expect(chatToolChain).not.toContainText('"selected"');
		for (const size of [13, 15, 20]) {
			await page.evaluate((fontSize) => {
				document.documentElement.style.setProperty("--content-font-size", `${fontSize}px`);
			}, size);
			await expect(page.locator(".turn-answer").first()).toHaveCSS("font-size", `${size}px`);
			expect(await page.locator(".transcript-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
			await page.screenshot({
				animations: "disabled",
				path: path.join(qaDir, `chat-dark-${size}px-1280x840.png`),
			});
		}
		await page.evaluate(() => document.documentElement.style.removeProperty("--content-font-size"));

		phase = "checking packaged slash commands and Skill chip";
		const composerInput = page.getByRole("textbox", { name: "Message Metis", exact: true });
		await composerInput.fill("/");
		const slashMenu = page.getByRole("listbox", { name: "Slash commands", exact: true });
		await expect(slashMenu).toBeVisible();
		await expect(slashMenu.getByText("skill:e2e-skill", { exact: true })).toBeVisible();
		const slashLabels = await slashMenu.locator("[role=option] strong").allTextContents();
		expect(slashLabels.slice(0, 7)).toEqual([
			"/compact",
			"/goal",
			"/plan",
			"/model",
			"/thinking",
			"/status",
			"/mcp",
		]);
		expect(slashLabels).toContain("/mcp");
		expect(slashLabels).toContain("skill:e2e-skill");
		await expect(slashMenu).not.toContainText("/usage");
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("slash-command-menu.png"),
		});
		await composerInput.fill("/com");
		await expect(slashMenu.getByRole("option")).toHaveCount(1);
		await expect(slashMenu.locator("strong")).toHaveText("/compact");

		await composerInput.fill("/status");
		await slashMenu.getByRole("option").click();
		const statusPanel = page.getByRole("dialog", { name: "Context Usage", exact: true });
		await expect(statusPanel).toBeVisible();
		await expect(statusPanel).toContainText("Context usage unavailable");
		await expect(statusPanel).not.toContainText(CHAT_ACTIVE_ID);
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("slash-status-panel.png"),
		});
		await page.keyboard.press("Escape");
		await expect(statusPanel).toHaveCount(0);
		await expect(page.locator(".transcript-compaction-row")).toHaveText("Compacted");
		await expect(page.locator(".transcript")).not.toContainText("private packaged summary");
		await page.locator(".transcript").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("compacted-divider.png"),
		});

		await composerInput.fill("/skill:e2e");
		await slashMenu.getByRole("option").click();
		await expect(page.getByRole("button", { name: "Remove skill e2e-skill", exact: true })).toBeVisible();
		await composerInput.pressSequentially("Use the packaged fixture");
		await expect(page.locator(".composer-skill-token")).toHaveCSS("color", "rgb(165, 214, 255)");
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("slash-skill-token.png"),
		});
		await composerInput.fill("");
		await composerInput.press("Backspace");
		await expect(page.getByRole("button", { name: "Remove skill e2e-skill", exact: true })).toHaveCount(0);

		phase = "checking expanded Chat task list";
		let panel = page.getByRole("region", { name: "Tasks", exact: true });
		await expect(panel).toBeVisible();
		await expect(panel.locator(".task-list-row")).toHaveCount(6);
		await expect(panel.locator(".task-list-items")).toHaveCSS("max-height", "150px");
		await expect(panel.locator(".task-list-items")).toHaveCSS("overflow-y", "auto");
		await expect(panel.locator(".task-list-spinner")).toHaveCount(5);
		await expect(panel.locator(".task-list-row.is-completed")).toHaveCount(1);
		await expect(panel.locator(".task-list-row.is-completed .task-list-text")).toHaveCSS(
			"text-decoration-line",
			"line-through",
		);
		await expect(panel).toHaveCSS("border-bottom-left-radius", "0px");
		await expect(panel).toHaveCSS("border-bottom-right-radius", "0px");
		await expect(panel).toHaveCSS("border-bottom-width", "0px");
		const slot = page.locator(".composer-dock > .task-list-slot");
		const composer = page.locator(".composer-dock > .composer-chat");
		await expect(page.locator(".composer-dock > .task-list-slot + .composer-chat")).toHaveCount(1);
		await expect(slot).toHaveCSS("opacity", "1");
		const [slotBox, composerBox] = await Promise.all([slot.boundingBox(), composer.boundingBox()]);
		expect(slotBox).not.toBeNull();
		expect(composerBox).not.toBeNull();
		expect(slotBox!.x - composerBox!.x).toBeCloseTo(16, 0);
		expect(composerBox!.width - slotBox!.width).toBeCloseTo(32, 0);
		expect(composerBox!.y - slotBox!.y - slotBox!.height).toBeCloseTo(0, 0);
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("task-list-expanded-chat.png"),
		});
		const transcriptScroll = page.locator(".transcript-scroll");
		const expandedTranscriptHeight = await transcriptScroll.evaluate((element) => element.clientHeight);
		await page.evaluate(() => {
			const state = window as typeof window & { __taskListLongTasks?: number[]; __taskListLongTaskObserver?: PerformanceObserver };
			state.__taskListLongTasks = [];
			if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
				state.__taskListLongTaskObserver = new PerformanceObserver((list) => {
					state.__taskListLongTasks?.push(...list.getEntries().map((entry) => entry.duration));
				});
				state.__taskListLongTaskObserver.observe({ entryTypes: ["longtask"] });
			}
		});

		phase = "checking collapsed task list";
		await panel.getByRole("button", { name: "Collapse task list" }).click();
		await expect(panel).toHaveClass(/\bis-collapsed\b/u);
		await page.waitForTimeout(240);
		await expect(panel.locator(".task-list-items .task-list-row")).toHaveCount(6);
		await expect(panel.locator(".task-list-drawer")).toHaveAttribute("inert", "");
		await expect(panel.locator(".task-list-summary .task-list-text")).toHaveText("Inspect implementation");
		const summary = panel.getByRole("button", { name: /Working.*Inspect implementation.*Expand task list/u });
		await expect(summary).toHaveAttribute("aria-expanded", "false");
		await expect(summary).toHaveAttribute("aria-live", "polite");
		await expect(summary).not.toHaveAttribute("aria-label");
		const collapsedTranscriptHeight = await transcriptScroll.evaluate((element) => element.clientHeight);
		expect(collapsedTranscriptHeight).toBeGreaterThan(expandedTranscriptHeight);
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("task-list-collapsed-chat.png"),
		});
		await summary.click();
		await expect(panel).not.toHaveClass(/\bis-collapsed\b/u);
		await page.waitForTimeout(240);
		const expandedAgainTranscriptHeight = await transcriptScroll.evaluate((element) => element.clientHeight);
		expect(expandedAgainTranscriptHeight).toBeCloseTo(expandedTranscriptHeight, 0);
		const bottomGap = await transcriptScroll.evaluate((element) =>
			Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight),
		);
		expect(bottomGap).toBeLessThanOrEqual(48);
		const longestTaskListFrame = await page.evaluate(() => {
			const state = window as typeof window & {
				__taskListLongTaskObserver?: PerformanceObserver;
				__taskListLongTasks?: number[];
			};
			state.__taskListLongTaskObserver?.disconnect();
			return Math.max(0, ...(state.__taskListLongTasks ?? []));
		});
		expect(longestTaskListFrame).toBeLessThan(100);

		phase = "checking Code task list";
		await page.getByRole("button", { name: "Code", exact: true }).click();
		const codeSession = page.getByRole("button", { name: "Task list Code fixture", exact: true });
		await expect(codeSession).toBeVisible();
		await codeSession.click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);
		const codeExecution = page.locator(".code-execution").first();
		await expect(codeExecution).not.toHaveAttribute("open", "");
		await codeExecution.locator(":scope > summary").click();
		const codeTask = codeExecution.locator(".code-command").first();
		await expect(codeTask).not.toHaveAttribute("open", "");
		await codeTask.locator(":scope > summary").click();
		await expect(codeTask).toContainText("○ Inspect implementation");
		await expect(codeTask).not.toContainText('"tasks"');
		await page.evaluate(() => document.documentElement.style.setProperty("--content-font-size", "20px"));
		await expect(page.locator(".code-turn-answer").first()).toHaveCSS("font-size", "20px");
		expect(await page.locator(".transcript-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "code-dark-20px-1280x840.png") });
		await page.evaluate(() => document.documentElement.style.removeProperty("--content-font-size"));
		panel = page.getByRole("region", { name: "Tasks", exact: true });
		await expect(panel.locator(".task-list-row")).toHaveCount(6);
		await expect(page.locator(".composer-dock > .task-list-slot + .composer-code")).toHaveCount(1);
		await page.locator(".composer-dock").screenshot({
			animations: "disabled",
			path: testInfo.outputPath("task-list-expanded-code.png"),
		});

		phase = "checking persisted completed task list stays closed";
		await page.getByRole("button", { name: "Chat", exact: true }).click();
		await page.getByRole("button", { name: "Completed task list fixture", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", COMPLETED_TASK_ID);
		await expect(page.getByRole("region", { name: "Tasks", exact: true })).toHaveCount(0);

		phase = "checking packaged New Task side rays";
		await page.getByRole("button", { name: "New task", exact: true }).click();
		await expect(page.getByRole("button", { name: "Show tools sidebar", exact: true })).toHaveCount(0);
		await expect(page.locator(".tool-sidebar:not([hidden])")).toHaveCount(0);
		await expect(page.locator(".new-task-side-rays canvas")).toBeVisible();
		await page.locator(".new-task-home").screenshot({ path: testInfo.outputPath("new-task-side-rays.png") });
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged queued messages edit, guide, drain in order, and pause across App Server recovery", async ({}, testInfo) => {
	test.setTimeout(180_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-queued-turn-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	const sessionId = "71000000-0000-4000-8000-000000000001";
	const manager = fixtures.SessionManager.create(
		projectDir,
		fixtures.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "chat", permissionPreset: "full" },
	);
	manager.appendSessionInfo("Queued message session");
	manager.close();
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const knownMarkers = [
		"guide-first",
		"guide-edited",
		"fifo-first",
		"fifo-second",
		"fifo-third",
		"restart-first",
		"restart-queued",
	] as const;
	const heldMarkers = new Set(["guide-first", "fifo-first", "restart-first"]);
	const requestMarkers: string[] = [];
	const heldResponses = new Map<string, () => void>();
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
		const transcript = JSON.stringify(payload.messages ?? []);
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (transcript.includes("conversation title generator")) {
			response.end(`data: ${JSON.stringify({
				id: "queued-title",
				object: "chat.completion.chunk",
				created: 1,
				model: "queued-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "Queued message session" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		const lastUser = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user");
		const lastUserText = JSON.stringify(lastUser?.content ?? "");
		const marker = knownMarkers.find((candidate) => lastUserText.includes(candidate));
		if (!marker) {
			response.end();
			return;
		}
		requestMarkers.push(marker);
		const complete = () => response.end(`data: ${JSON.stringify({
			id: `queued-${marker}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "queued-model",
			choices: [{ index: 0, delta: { role: "assistant", content: `done:${marker}` }, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`);
		if (!heldMarkers.has(marker)) {
			complete();
			return;
		}
		const release = () => {
			heldResponses.delete(marker);
			if (!response.destroyed) complete();
		};
		heldResponses.set(marker, release);
		response.once("close", () => {
			if (heldResponses.get(marker) === release) heldResponses.delete(marker);
		});
	});
	const providerPort = await listen(fakeProvider);
	await Promise.all([
		writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			queued: {
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				apiKey: "queued-key",
				api: "openai-completions",
				models: [{ id: "queued-model", name: "Queued Model", contextWindow: 32_000, maxTokens: 1_024 }],
			},
		} })),
		writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "queued",
			defaultModel: "queued-model",
			retry: { enabled: false },
		})),
	]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	const waitForMarker = async (marker: string) => {
		await expect.poll(() => requestMarkers.filter((current) => current === marker).length).toBe(1);
	};
	const release = (marker: string) => {
		const complete = heldResponses.get(marker);
		if (!complete) throw new Error(`Provider response is not held: ${marker}`);
		complete();
	};
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(12_000);
		await page.setViewportSize({ width: 1100, height: 760 });
		await waitForServerReady(page);
		await page.locator('.session-button[aria-label="Queued message session"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });
		const input = page.locator("#composer-input");
		const queuedRows = page.getByRole("group", { name: /Queued message \d+/u });
		const submit = async (text: string, action: "Send message" | "Queue message") => {
			await expect(input).toHaveAttribute("contenteditable", "true");
			await input.fill(text);
			await page!.getByRole("button", { name: action, exact: true }).click();
		};

		phase = "editing and guiding the active turn";
		await submit("guide-first", "Send message");
		await waitForMarker("guide-first");
		await submit("guide-original", "Queue message");
		await expect(queuedRows).toHaveCount(1);
		const guideRow = page.getByRole("group", { name: "Queued message 1", exact: true });
		await expect(guideRow).toContainText("guide-original");
		await guideRow.getByRole("button", { name: "Edit queued message", exact: true }).click();
		await expect(queuedRows).toHaveCount(0);
		await expect(input).toHaveText("guide-original");
		await input.fill("guide-edited");
		await page.getByRole("button", { name: "Queue message", exact: true }).click();
		await expect(queuedRows).toHaveCount(1);
		await expect(guideRow).toContainText("guide-edited");
		await expect(page.locator(".composer")).toHaveCSS("border-top-left-radius", "21px");
		await expect(page.locator(".composer")).toHaveCSS("border-top-right-radius", "21px");
		await page.locator(".composer-dock").screenshot({ animations: "disabled", path: testInfo.outputPath("queued-edited.png") });
		await guideRow.getByRole("button", { name: "Guide with queued message", exact: true }).click();
		await expect(guideRow).toContainText("Sending…");
		await page.locator(".composer-dock").screenshot({ animations: "disabled", path: testInfo.outputPath("queued-guiding.png") });
		release("guide-first");
		await waitForMarker("guide-edited");
		await expect(page.getByText("done:guide-edited", { exact: true })).toBeVisible();
		await expect(queuedRows).toHaveCount(0);

		phase = "draining queued messages in FIFO order";
		await submit("fifo-first", "Send message");
		await waitForMarker("fifo-first");
		await submit("fifo-second", "Queue message");
		await submit("fifo-third", "Queue message");
		await expect(queuedRows).toHaveCount(2);
		await expect(queuedRows.nth(0)).toContainText("fifo-second");
		await expect(queuedRows.nth(1)).toContainText("fifo-third");
		release("fifo-first");
		await expect.poll(() => requestMarkers.filter((marker) => marker.startsWith("fifo-"))).toEqual([
			"fifo-first",
			"fifo-second",
			"fifo-third",
		]);
		await expect(page.getByText("done:fifo-third", { exact: true })).toBeVisible();
		await expect(queuedRows).toHaveCount(0);

		phase = "recovering an interrupted queue as paused";
		await submit("restart-first", "Send message");
		await waitForMarker("restart-first");
		await submit("restart-queued", "Queue message");
		await expect(queuedRows).toHaveCount(1);
		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app did not expose a process id");
		const firstUtilityPid = appServerPid(rootPid);
		if (!firstUtilityPid) throw new Error("Could not find the packaged App Server");
		process.kill(firstUtilityPid, "SIGKILL");
		await expect.poll(() => {
			const current = appServerPid(rootPid);
			return current !== undefined && current !== firstUtilityPid;
		}).toBe(true);
		await waitForServerReady(page);
		const pausedRow = page.getByRole("group", { name: "Queued message 1", exact: true });
		await expect(pausedRow).toContainText("Paused", { timeout: 20_000 });
		await expect(pausedRow).toContainText("restart-queued");
		expect(requestMarkers.filter((marker) => marker.startsWith("restart-"))).toEqual(["restart-first"]);
		await page.locator(".composer-dock").screenshot({ animations: "disabled", path: testInfo.outputPath("queued-paused-after-restart.png") });
		await pausedRow.getByRole("button", { name: "Send queued message", exact: true }).click();
		await waitForMarker("restart-queued");
		await expect(page.getByText("done:restart-queued", { exact: true })).toBeVisible();
		await expect(queuedRows).toHaveCount(0);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase} requests=${requestMarkers.join(",")}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged permission sandbox keeps Auto bounded and project rules revocable", async () => {
	test.setTimeout(180_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-permission-sandbox-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const outsideDir = path.join(tempRoot, "outside");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(outsideDir), mkdir(userDataDir)]);
	const sessionId = "70000000-0000-4000-8000-000000000001";
	const manager = fixtures.SessionManager.create(
		projectDir,
		fixtures.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "chat", permissionPreset: "auto" },
	);
	manager.appendSessionInfo("Permission sandbox session");
	manager.close();
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const outsideFile = path.join(outsideDir, "blocked.txt");
	const fullFile = path.join(outsideDir, "full.txt");
	const cases = new Map([
		["case-auto-pwd", "pwd"],
		["case-auto-outside", `printf escaped > ${JSON.stringify(outsideFile)}`],
		["case-exact-one", "rm -rf ./build"],
		["case-exact-two", "rm -rf ./build"],
		["case-exact-three", "rm -rf ./build"],
		["case-exact-four", "rm -rf ./build"],
		["case-changed", "rm -rf ./src"],
		["case-ask-pwd", "pwd"],
		["case-host-reject", "git push https://github.com/example/repo.git"],
		["case-full-host", `printf full > ${JSON.stringify(fullFile)}`],
	]);
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
		const transcript = JSON.stringify(payload.messages ?? []);
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (transcript.includes("You are an isolated permission reviewer.")) {
			response.end(`data: ${JSON.stringify({
				id: "permission-review",
				object: "chat.completion.chunk",
				created: 1,
				model: "permission-model",
				choices: [{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [{
							index: 0,
							id: "permission-review-call",
							type: "function",
							function: {
								name: "submit_permission_review",
								arguments: JSON.stringify({ decision: "deny" }),
							},
						}],
					},
					finish_reason: "tool_calls",
				}],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		if (transcript.includes("conversation title generator")) {
			response.end(`data: ${JSON.stringify({
				id: "permission-title",
				object: "chat.completion.chunk",
				created: 1,
				model: "permission-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "Permission test" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		const lastUser = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user");
		const lastUserText = JSON.stringify(lastUser?.content ?? "");
		const marker = [...cases.keys()].find((candidate) => lastUserText.includes(candidate));
		const callId = marker ? `call-${marker}` : undefined;
		if (marker && callId && !transcript.includes(callId)) {
			response.end(`data: ${JSON.stringify({
				id: `permission-${marker}`,
				object: "chat.completion.chunk",
				created: 1,
				model: "permission-model",
				choices: [{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [{
							index: 0,
							id: callId,
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command: cases.get(marker) }) },
						}],
					},
					finish_reason: "tool_calls",
				}],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		response.end(`data: ${JSON.stringify({
			id: `permission-done-${marker ?? "plain"}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "permission-model",
			choices: [{ index: 0, delta: { role: "assistant", content: `done:${marker ?? "plain"}` }, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`);
	});
	const providerPort = await listen(fakeProvider);
	await Promise.all([
		writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			permission: {
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				apiKey: "permission-key",
				api: "openai-completions",
				models: [{ id: "permission-model", name: "Permission Model", contextWindow: 32_000, maxTokens: 1_024 }],
			},
		} })),
		writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "permission",
			defaultModel: "permission-model",
			retry: { enabled: false },
		})),
	]);

	let app: ReturnType<typeof launchPackagedApp> | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "launching";
	const diagnostics: string[] = [];
	const launch = async () => {
		const debuggingPort = await reservePort();
		app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(12_000);
		await waitForServerReady(page);
		await page.locator('.session-button[aria-label="Permission sandbox session"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });
	};
	const submit = async (marker: string) => {
		await page!.locator("#composer-input").fill(marker);
		await page!.getByRole("button", { name: "Send message", exact: true }).click();
	};
	const waitDone = async (marker: string) => {
		await expect(page!.getByText(`done:${marker}`, { exact: true })).toBeVisible({ timeout: 20_000 });
	};
	const setMode = async (current: "Ask" | "Auto" | "Full", option: string, next: "Ask" | "Auto" | "Full") => {
		await page!.getByRole("button", { name: `Select permissions, current ${current}`, exact: true }).click();
		await page!.getByRole("menuitemradio", { name: new RegExp(option, "u") }).click();
		await expect(page!.getByRole("button", { name: `Select permissions, current ${next}`, exact: true })).toBeVisible();
	};
	try {
		await launch();
		phase = "checking Auto default and ordinary sandbox Bash";
		await expect(page!.getByRole("button", { name: "Select permissions, current Auto", exact: true })).toBeVisible();
		await submit("case-auto-pwd");
		await waitDone("case-auto-pwd");
		await expect(page!.locator(".permission-approval-panel")).toHaveCount(0);

		phase = "blocking Auto outside write without host fallback";
		await submit("case-auto-outside");
		const outsideApproval = page!.locator(".permission-approval-panel");
		const outsideOutcome = await Promise.race([
			page!.getByText("done:case-auto-outside", { exact: true }).waitFor({ timeout: 20_000 }).then(() => "done" as const),
			outsideApproval.waitFor({ timeout: 20_000 }).then(() => "panel" as const),
		]);
		if (outsideOutcome === "panel") {
			await expect(outsideApproval).toContainText("workspace sandbox");
			await outsideApproval.getByRole("button", { name: /Reject/u }).click();
		}
		await waitDone("case-auto-outside");
		expect(existsSync(outsideFile)).toBe(false);
		await expect(page!.locator(".permission-approval-panel")).toHaveCount(0);

		phase = "remembering one exact destructive sandbox command";
		await setMode("Auto", "Ask", "Ask");
		await mkdir(path.join(projectDir, "build"));
		await writeFile(path.join(projectDir, "build", "artifact.txt"), "artifact");
		await submit("case-exact-one");
		const approval = page!.locator(".permission-approval-panel");
		await expect(approval).toContainText("workspace sandbox");
		await approval.getByRole("button", { name: "Always allow this exact action", exact: true }).click();
		await waitDone("case-exact-one");
		expect(existsSync(path.join(projectDir, "build"))).toBe(false);

		await mkdir(path.join(projectDir, "build"));
		await submit("case-exact-two");
		await waitDone("case-exact-two");
		await expect(approval).toHaveCount(0);
		expect(existsSync(path.join(projectDir, "build"))).toBe(false);

		phase = "requiring a new decision for changed command text";
		await mkdir(path.join(projectDir, "src"));
		await submit("case-changed");
		await expect(approval).toBeVisible();
		await approval.getByRole("button", { name: /Reject/u }).click();
		await waitDone("case-changed");
		expect(existsSync(path.join(projectDir, "src"))).toBe(true);

		phase = "restarting and reusing the persisted exact project rule";
		await browser?.close();
		browser = undefined;
		await stopProcess(app!);
		app = undefined;
		await launch();
		await mkdir(path.join(projectDir, "build"));
		await submit("case-exact-three");
		await waitDone("case-exact-three");
		await expect(page!.locator(".permission-approval-panel")).toHaveCount(0);

		phase = "revoking the exact project rule";
		await page!.evaluate(async (activeSessionId) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			const rules = await api.listPermissionRules({ sessionId: activeSessionId });
			const rule = rules.rules.find((candidate) => candidate.toolName === "bash");
			if (!rule) throw new Error("Expected a persisted bash permission rule");
			await api.deletePermissionRule({
				sessionId: activeSessionId,
				ruleId: rule.id,
				requestId: crypto.randomUUID(),
			});
		}, sessionId);
		await mkdir(path.join(projectDir, "build"));
		await submit("case-exact-four");
		await expect(page!.locator(".permission-approval-panel")).toBeVisible();
		await page!.locator(".permission-approval-panel").getByRole("button", { name: "Allow once", exact: true }).click();
		await waitDone("case-exact-four");

		phase = "checking Ask sandbox and Full host disclosure";
		await submit("case-ask-pwd");
		await expect(page!.locator(".permission-approval-panel")).toContainText("workspace sandbox");
		await page!.locator(".permission-approval-panel").getByRole("button", { name: "Allow once", exact: true }).click();
		await waitDone("case-ask-pwd");
		await setMode("Ask", "Full", "Full");
		await submit("case-host-reject");
		await waitDone("case-host-reject");
		await expect(page!.locator(".permission-approval-panel")).toHaveCount(0);

		phase = "checking Full ordinary host execution";
		await submit("case-full-host");
		await waitDone("case-full-host");
		expect(await readFile(fullFile, "utf8")).toBe("full");
		await expect(page!.locator(".permission-approval-panel")).toHaveCount(0);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`);
	} finally {
		await browser?.close().catch(() => undefined);
		if (app) await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Plugin Center, worker, WASM, trusted extension, and utility lifecycle stay functional", async () => {
	test.setTimeout(300_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-packaged-smoke-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const extensionDir = path.join(projectDir, ".metis", "extensions");
	const userSkillDir = path.join(agentDir, "skills", "writing-plans");
	const projectSkillDir = path.join(projectDir, ".metis", "skills", "packaged-project-skill");
	const importSourceDir = path.join(tempRoot, "skill-import-source");
	const importArchive = path.join(tempRoot, "packaged-skills.skill");
	const userDataDir = path.join(tempRoot, "electron");
	const scheduleQaDir = path.join(desktopRoot, "test-results", "design-qa", "scheduled-tasks");
	const permissionQaDir = path.join(desktopRoot, "test-results", "design-qa", "permission-approval");
	const askUserQaDir = path.join(desktopRoot, "test-results", "design-qa", "ask-user");
	const assetQaDir = path.join(desktopRoot, "test-results", "design-qa", "assets");
	const pluginQaDir = path.join(desktopRoot, "test-results", "design-qa", "plugins");
	const groupingQaDir = path.join(desktopRoot, "test-results", "design-qa", "session-grouping");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(extensionDir, { recursive: true }),
		mkdir(userSkillDir, { recursive: true }),
		mkdir(projectSkillDir, { recursive: true }),
		mkdir(userDataDir),
		mkdir(scheduleQaDir, { recursive: true }),
		mkdir(permissionQaDir, { recursive: true }),
		mkdir(askUserQaDir, { recursive: true }),
		mkdir(assetQaDir, { recursive: true }),
		mkdir(pluginQaDir, { recursive: true }),
		mkdir(groupingQaDir, { recursive: true }),
	]);
	let providerRequests = 0;
	let titleRequests = 0;
	let approvalToolIssued = false;
	const providerToolNames: string[][] = [];
	const providerTranscripts: string[] = [];
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as {
			messages?: unknown[];
			tools?: Array<{ function?: { name?: string }; name?: string }>;
		};
		const providerTranscript = JSON.stringify(payload.messages ?? []);
		const toolNames = (payload.tools ?? [])
			.map((tool) => tool.function?.name ?? tool.name)
			.filter((name): name is string => Boolean(name));
		if (providerTranscript.includes("conversation title generator")) {
			titleRequests += 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-packaged-title",
					object: "chat.completion.chunk",
					created: 1,
					model: "packaged-smoke-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "Packaged smoke title" }, finish_reason: "stop" }],
				})}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		if (toolNames.includes("commit_facts")) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const toolAlreadyCalled = providerTranscript.includes("call-packaged-memory");
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-packaged-memory",
					object: "chat.completion.chunk",
					created: 1,
					model: "packaged-smoke-model",
					choices: [{
						index: 0,
						delta: toolAlreadyCalled
							? { role: "assistant", content: "" }
							: {
								role: "assistant",
								tool_calls: [{
									index: 0,
									id: "call-packaged-memory",
									type: "function",
									function: { name: "commit_facts", arguments: '{"facts":[]}' },
								}],
							},
						finish_reason: toolAlreadyCalled ? "stop" : "tool_calls",
					}],
				})}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		providerTranscripts.push(providerTranscript);
		providerToolNames.push(toolNames);
		providerRequests += 1;
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (providerTranscript.includes("request packaged questions") && !providerTranscript.includes("call-packaged-questions")) {
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-packaged-questions",
					object: "chat.completion.chunk",
					created: 1,
					model: "packaged-smoke-model",
					choices: [{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [{
								index: 0,
								id: "call-packaged-questions",
								type: "function",
								function: {
									name: "ask_user",
									arguments: JSON.stringify({
										questions: [
											{
												question: "How should Metis answer?",
												multiple: true,
												options: [
													{ label: "Fast and concise" },
													{ label: "Detailed explanation" },
													{ label: "Adapt to context" },
													{ label: "Summary first" },
												],
											},
											{
												question: "Which communication style should Metis use?",
												multiple: true,
												options: [
													{ label: "Professional" },
													{ label: "Friendly" },
													{ label: "Contextual" },
													{ label: "Warm" },
												],
											},
										],
									}),
								},
							}],
						},
						finish_reason: "tool_calls",
					}],
				})}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		if (providerTranscript.includes("request packaged single question") && !providerTranscript.includes("call-packaged-single-question")) {
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-packaged-single-question",
					object: "chat.completion.chunk",
					created: 1,
					model: "packaged-smoke-model",
					choices: [{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [{
								index: 0,
								id: "call-packaged-single-question",
								type: "function",
								function: {
									name: "ask_user",
									arguments: JSON.stringify({
										questions: [{
											question: "Where should Metis store the task data?",
											multiple: false,
											options: [
												{ label: "Local database" },
												{ label: "Cloud sync" },
												{ label: "Shared file" },
												{ label: "Ask each time" },
											],
										}],
									}),
								},
							}],
						},
						finish_reason: "tool_calls",
					}],
				})}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
		if (providerTranscript.includes("request packaged approval") && !approvalToolIssued) {
			approvalToolIssued = true;
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-packaged-approval",
					object: "chat.completion.chunk",
					created: 1,
					model: "packaged-smoke-model",
					choices: [{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [{
								index: 0,
								id: "call-packaged-approval",
								type: "function",
								function: { name: "bash", arguments: '{"command":"pwd"}' },
							}],
						},
						finish_reason: "tool_calls",
					}],
				})}\n\ndata: [DONE]\n\n`,
			);
			return;
		}
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
		path.join(packagedAsar(), ".webpack", "app-server", "node_modules", "@metis", "coding-agent", "dist", "index.js"),
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
				mcpServers: {
					browser: { enabled: false, url: "https://browser.example.test/mcp" },
					filesystem: { command: process.execPath, enabled: false },
					github: { enabled: false, url: "https://github.example.test/mcp" },
				},
				retry: { enabled: false },
				webSearch: { enabled: true, provider: "brave" },
			}),
		),
		writeFile(
			path.join(extensionDir, "packaged-image.ts"),
			`export default function (metis) {
	metis.on("session_start", async (_event, ctx) => {
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
			path.join(userSkillDir, "SKILL.md"),
			"---\nname: writing-plans\ndescription: Build a clear implementation plan\n---\n\n# Instructions\n\n## Workflow\n\n1. Clarify the goal.\n2. Write the plan.\n",
		),
		writeFile(
			path.join(projectSkillDir, "SKILL.md"),
			"---\nname: packaged-project-skill\ndescription: Visible in the packaged Project catalog\n---\n\n# Instructions\n\nUse project context.\n",
		),
	]);
	await Promise.all([
		writeFixtureFile(
			path.join(importSourceDir, "packaged-alpha", "SKILL.md"),
			"---\nname: packaged-alpha\ndescription: Imported packaged alpha Skill\n---\n\n# Instructions\n\nUse alpha.\n",
		),
		writeFixtureFile(path.join(importSourceDir, "packaged-alpha", "references", "example.md"), "alpha example"),
		writeFixtureFile(
			path.join(importSourceDir, "packaged-beta", "SKILL.md"),
			"---\nname: packaged-beta\ndescription: Imported packaged beta Skill\n---\n\n# Instructions\n\nUse beta.\n",
		),
	]);
	const zipped = spawnSync("zip", ["-q", "-r", importArchive, "."], { cwd: importSourceDir, encoding: "utf8" });
	if (zipped.status !== 0) throw new Error(zipped.stderr || "Could not create packaged Skill fixture");

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	let finalUtilityPid: number | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.on("console", (entry) => { if (entry.type() === "error") consoleErrors.push(entry.text()); });
		page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message));
		phase = "verifying draft creation timing";
		await waitForServerReady(page);
		await page.setViewportSize({ width: 1556, height: 1011 });
		phase = "verifying packaged Plugin Center Skill lifecycle";
		await page.getByRole("button", { name: "Customize", exact: true }).click();
		await expect(page.locator(".plugins-section-switch").getByRole("tab")).toHaveCount(4);
		await expect(page.locator(".plugins-section-switch").getByRole("tab", { name: "Skills", exact: true })).toBeVisible();
		await expect(page.locator(".plugins-section-switch").getByRole("tab", { name: "MCP", exact: true })).toBeVisible();
		await expect(page.locator(".plugins-section-switch").getByRole("tab", { name: "Hooks", exact: true })).toBeVisible();
		await expect(page.locator(".plugins-section-switch").getByRole("tab", { name: "Plugins", exact: true })).toBeVisible();
		await expect(page.getByRole("option", { name: "writing-plans", exact: true })).toBeVisible();

		phase = "verifying packaged Skill creation methods and assisted Chat";
		await page.getByRole("button", { name: "New Skill", exact: true }).click();
		await page.getByRole("menu", { name: "New Skill", exact: true }).getByRole("menuitem", { name: "Project", exact: true }).click();
		let createSkillDialog = page.getByRole("dialog", { name: "Create Project Skill" });
		const projectSelector = createSkillDialog.getByRole("button", { name: "Create in", exact: true });
		expect(await projectSelector.evaluate((element) => element.tagName)).toBe("BUTTON");
		await projectSelector.click();
		await expect(createSkillDialog.getByRole("listbox", { name: "Create in", exact: true })).toBeVisible();
		await page.screenshot({ path: path.join(pluginQaDir, "actual-project-skill-menu.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(createSkillDialog.getByRole("button", { name: "Create with Metis", exact: true })).toBeDisabled();
		await page.screenshot({ path: path.join(pluginQaDir, "actual-project-skill-target.png"), animations: "disabled" });
		await createSkillDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.getByRole("button", { name: "New Skill", exact: true }).click();
		await page.getByRole("menu", { name: "New Skill", exact: true }).getByRole("menuitem", { name: "User", exact: true }).click();
		createSkillDialog = page.getByRole("dialog", { name: "Create User Skill" });
		await expect(createSkillDialog.locator(".skill-create-methods > button")).toHaveCount(4);
		await expect(createSkillDialog.locator(".skill-create-methods > button strong")).toHaveText([
			"Create with Metis",
			"Upload Skill",
			"Import from GitHub",
			"Custom",
		]);
		await createSkillDialog.getByRole("button", { name: "Import from GitHub", exact: true }).click();
		const githubInput = createSkillDialog.getByLabel("GitHub link", { exact: true });
		await githubInput.fill("https://github.com/acme/skills");
		const githubCancel = createSkillDialog.getByRole("button", { name: "Cancel", exact: true });
		const githubInspect = createSkillDialog.getByRole("button", { name: "Inspect", exact: true });
		const [cancelBox, inspectBox] = await Promise.all([githubCancel.boundingBox(), githubInspect.boundingBox()]);
		expect(cancelBox).not.toBeNull();
		expect(inspectBox).not.toBeNull();
		expect(Math.abs(cancelBox!.y - inspectBox!.y)).toBeLessThanOrEqual(1);
		await page.screenshot({ path: path.join(pluginQaDir, "actual-github-skill-import.png"), animations: "disabled" });
		await createSkillDialog.getByRole("button", { name: "Back", exact: true }).click();
		await createSkillDialog.getByRole("button", { name: "Create with Metis", exact: true }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true }).first()).toBeVisible();
		const assistedPrompt = "I want to create a user-level Skill. Use the create-skill Skill and ask me for the information you need before creating it.";
		await expect.poll(() => providerTranscripts.some((transcript) => transcript.includes(assistedPrompt))).toBe(true);
		await expect.poll(() => titleRequests).toBe(1);
		const assistedSessions = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		);
		expect(assistedSessions.sessions).toHaveLength(1);
		expect(assistedSessions.sessions[0]).toMatchObject({ mode: "chat", cwdOrigin: "managed" });
		await page.evaluate(async (sessionId) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.deleteSession({
				sessionId,
				requestId: crypto.randomUUID(),
			});
		}, assistedSessions.sessions[0]!.sessionId);
		await expect.poll(async () => (await page!.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		)).sessions.length).toBe(0);
		await page.getByRole("button", { name: "Customize", exact: true }).click();

		phase = "creating a custom Skill from semantic fields";
		await page.getByRole("button", { name: "New Skill", exact: true }).click();
		await page.getByRole("menu", { name: "New Skill", exact: true }).getByRole("menuitem", { name: "User", exact: true }).click();
		createSkillDialog = page.getByRole("dialog", { name: "Create User Skill" });
		await createSkillDialog.getByRole("button", { name: "Custom", exact: true }).click();
		const customSkillDialog = page.getByRole("dialog", { name: "Write skill instructions" });
		await customSkillDialog.getByLabel("Skill name", { exact: true }).fill("packaged-custom");
		await customSkillDialog.getByLabel("Description", { exact: true }).fill("A custom packaged Skill");
		await customSkillDialog.getByLabel("Instructions", { exact: true }).fill("Write the requested packaged summary.");
		await page.screenshot({ path: path.join(pluginQaDir, "actual-custom-skill.png"), animations: "disabled" });
		await customSkillDialog.getByRole("button", { name: "Create", exact: true }).click();
		await expect(customSkillDialog).toHaveCount(0);
		expect(await readFile(path.join(agentDir, "skills", "packaged-custom", "SKILL.md"), "utf8")).toBe(
			'---\nname: packaged-custom\ndescription: "A custom packaged Skill"\n---\n\nWrite the requested packaged summary.\n',
		);
		await page.getByRole("button", { name: "Back to Skills", exact: true }).click();

		phase = "importing one selected Skill from a packaged multi-Skill archive";
		const inspectedImport = await page.evaluate((archivePath) =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.inspectSkillImport({
				cwd: null,
				source: "user",
				input: { kind: "archive", path: archivePath },
			}), importArchive);
		expect(inspectedImport.candidates.map((candidate) => candidate.name)).toEqual(["packaged-alpha", "packaged-beta"]);
		const alphaCandidate = inspectedImport.candidates.find((candidate) => candidate.name === "packaged-alpha")!;
		await page.evaluate(async ({ archivePath, candidateId, revision }) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.importSkills({
				requestId: crypto.randomUUID(),
				cwd: null,
				source: "user",
				input: { kind: "archive", path: archivePath },
				sourceRevision: revision,
				candidateIds: [candidateId],
			});
		}, { archivePath: importArchive, candidateId: alphaCandidate.id, revision: inspectedImport.revision });
		expect(await readFile(path.join(agentDir, "skills", "packaged-alpha", "references", "example.md"), "utf8")).toBe("alpha example");
		expect(existsSync(path.join(agentDir, "skills", "packaged-beta"))).toBe(false);
		await expect(page.evaluate(async ({ archivePath, candidateId, revision }) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.importSkills({
				requestId: crypto.randomUUID(),
				cwd: null,
				source: "user",
				input: { kind: "archive", path: archivePath },
				sourceRevision: revision,
				candidateIds: [candidateId],
			});
		}, { archivePath: importArchive, candidateId: alphaCandidate.id, revision: inspectedImport.revision })).rejects.toThrow();
		await page.getByRole("button", { name: "Reload Skills", exact: true }).click();
		await expect(page.getByRole("option", { name: "packaged-alpha", exact: true })).toBeVisible();
		await page.screenshot({ path: path.join(pluginQaDir, "actual-skill-list.png"), animations: "disabled" });
		await page.getByRole("option", { name: "docx", exact: true }).click();
		const packagedSkillDocument = page.locator('[data-plugin-detail="skill"] .plugins-detail-document');
		await expect(packagedSkillDocument).toContainText("Quick Start");
		const packagedSkillCodeBlock = packagedSkillDocument.locator("pre").first();
		await expect(packagedSkillCodeBlock).toBeVisible();
		expect(await packagedSkillCodeBlock.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
		expect(await packagedSkillDocument.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		await expect(page.getByRole("button", { name: "Open containing folder", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Back to Skills", exact: true }).click();
		await page.getByRole("button", { name: "Skill sources", exact: true }).click();
		await page.getByRole("option", { name: "User", exact: true }).click();
		await expect(page.getByRole("option", { name: "writing-plans", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Skill sources", exact: true }).click();
		await page.getByRole("option", { name: "All sources", exact: true }).click();
		await page.getByLabel("Search Skills").fill("writing");
		await page.getByRole("option", { name: "writing-plans", exact: true }).click();
		await expect(page.locator(".plugins-catalog-page")).toHaveCount(0);
		await expect(page.locator('[data-plugin-detail="skill"]')).toContainText("Workflow");
		await page.setViewportSize({ width: 1487, height: 1058 });
		await page.screenshot({ path: path.join(pluginQaDir, "actual-skill-detail.png"), animations: "disabled" });
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		const editSkillDialog = page.getByRole("dialog", { name: "Edit Skill" });
		const editedSkillContent = "---\nname: writing-plans\ndescription: Build a clear implementation plan\n---\n\n# Instructions\n\n## Workflow\n\n1. Clarify the goal.\n2. Write the plan.\n3. Verify the result.\n";
		await editSkillDialog.getByLabel("SKILL.md").fill(editedSkillContent);
		await editSkillDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editSkillDialog).toHaveCount(0);
		expect(await readFile(path.join(userSkillDir, "SKILL.md"), "utf8")).toBe(editedSkillContent);
		phase = "opening and recoverably deleting a packaged Skill";
		await page.getByRole("button", { name: "Open containing folder", exact: true }).click();
		await page.getByRole("button", { name: "Delete", exact: true }).click();
		const removeSkillDialog = page.getByRole("dialog", { name: "Move Skill to Trash?" });
		await removeSkillDialog.getByRole("button", { name: "Move to Trash", exact: true }).click();
		await expect(removeSkillDialog).toHaveCount(0);
		expect(existsSync(userSkillDir)).toBe(false);
		expect((await readdir(path.join(agentDir, "skills", ".trash"))).some((entry) => entry.endsWith("-writing-plans"))).toBe(true);

		phase = "adding and editing a packaged MCP definition";
		await page.locator(".plugins-section-switch").getByRole("tab", { name: "MCP", exact: true }).click();
		await page.getByRole("button", { name: "New MCP", exact: true }).click();
		await page.getByRole("menu", { name: "New MCP", exact: true }).getByRole("menuitem", { name: "User", exact: true }).click();
		await page.getByRole("dialog", { name: "Create User MCP" }).getByRole("button", { name: "Custom MCP", exact: true }).click();
		const addMcpDialog = page.getByRole("dialog", { name: "MCP configuration" });
		await addMcpDialog.getByLabel("Server name", { exact: true }).fill("packaged-http");
		await addMcpDialog.getByLabel("Server URL").fill("https://mcp.example.test/rpc");
		await addMcpDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(addMcpDialog).toHaveCount(0);
		await page.getByRole("button", { name: "Back to MCP", exact: true }).click();
		await page.setViewportSize({ width: 1272, height: 766 });
		await page.screenshot({ path: path.join(pluginQaDir, "actual-mcp-list.png"), animations: "disabled" });
		await page.getByLabel("Search MCP servers").fill("packaged");
		await expect(page.getByRole("option", { name: "packaged-http", exact: true })).toBeVisible();
		await page.getByRole("option", { name: "packaged-http", exact: true }).click();
		await page.setViewportSize({ width: 900, height: 720 });
		expect(await page.locator('[data-plugin-detail="mcp"] .plugins-detail-grid').evaluate((element) =>
			getComputedStyle(element).gridTemplateColumns.split(" ").length,
		)).toBe(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(900);
		await page.setViewportSize({ width: 1440, height: 1024 });
		await page.getByRole("button", { name: "Edit MCP server", exact: true }).click();
		const editMcpDialog = page.getByRole("dialog", { name: "Edit MCP server" });
		await editMcpDialog.getByLabel("Tool timeout (seconds)").fill("42");
		await editMcpDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(editMcpDialog).toHaveCount(0);
		await page.getByRole("button", { name: "Back to MCP", exact: true }).click();
		await expect(page.getByLabel("Search MCP servers")).toHaveValue("packaged");
		await page.getByRole("button", { name: "New task", exact: true }).click();

		phase = "verifying draft creation timing";
		const bridge = await page.evaluate(() => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return {
				hasAttachmentPicker: typeof api.selectAttachmentFiles === "function",
				hasSkillImport: typeof api.inspectSkillImport === "function" && typeof api.importSkills === "function",
				hasSkillList: typeof api.listSkills === "function",
				hasMcpImport: typeof api.inspectMcpImport === "function" && typeof api.importMcpServers === "function",
				hasMcpList: typeof api.listMcpServers === "function",
				hasMcpCatalogDetail: typeof api.getMcpCatalogItem === "function",
			};
		});
		expect(bridge).toEqual({ hasAttachmentPicker: true, hasSkillImport: true, hasSkillList: true, hasMcpImport: true, hasMcpList: true, hasMcpCatalogDetail: true });
		const sessionsBeforeDraft = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		);
		expect(sessionsBeforeDraft.sessions).toHaveLength(0);
		await page.getByRole("button", { name: "New task" }).click();
		const sessionsAfterNewTask = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterNewTask.sessions).toHaveLength(0);
		await page.locator("#composer-input").fill("managed packaged smoke");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true }).first()).toBeVisible();
		expect(providerToolNames[0]).toEqual(expect.arrayContaining(["ask_user", "web_fetch", "web_search"]));
		await expect.poll(() => titleRequests).toBe(2);
		await expect.poll(async () => {
			const sessions = await page!.evaluate(() =>
				(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
			);
			return sessions.sessions[0]?.name;
		}).toBe("Packaged smoke title");
		const sessionsAfterFirstSend = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		);
		expect(sessionsAfterFirstSend.sessions).toHaveLength(1);
		expect(sessionsAfterFirstSend.sessions[0]).toMatchObject({
			mode: "chat",
			cwdOrigin: "managed",
			name: "Packaged smoke title",
		});
		await expect(page.locator(".session-sidebar").getByRole("button", { name: "Packaged smoke title", exact: true })).toBeVisible();
		await page.screenshot({ path: path.join(groupingQaDir, "generated-title-and-message.png") });
		await page.getByRole("main").getByRole("button", { name: "Packaged smoke title", exact: true }).click();
		const titleInput = page.getByRole("textbox", { name: "Session name", exact: true });
		await titleInput.fill("Pinned packaged title");
		await titleInput.press("Enter");
		await expect(page.getByRole("main").getByRole("button", { name: "Pinned packaged title", exact: true })).toBeVisible();
		const titleActions = page.getByRole("main").getByRole("button", {
			name: "Actions for Pinned packaged title",
			exact: true,
		});
		await titleActions.click();
		let titleMenu = page.getByRole("menu", { name: "Pinned packaged title session actions", exact: true });
		await expect(titleMenu.getByRole("menuitem")).toHaveText(["Pin", "Copy title", "Delete"]);
		await page.screenshot({ path: path.join(groupingQaDir, "header-actions.png") });
		await titleMenu.getByRole("menuitem", { name: "Pin", exact: true }).click();
		const pinnedSection = page.locator(".session-section").filter({
			has: page.getByRole("button", { name: "Pinned", exact: true }),
		});
		await expect(pinnedSection.getByRole("button", { name: "Pinned packaged title", exact: true })).toBeVisible();
		await expect(page.locator(".session-sidebar").getByRole("button", { name: "Pinned packaged title", exact: true })).toHaveCount(1);
		await page.locator(".session-sidebar").screenshot({ path: path.join(groupingQaDir, "pinned-session.png") });
		expect(await page.evaluate(() => localStorage.getItem("metis.sessionPins.v1"))).toBe(
			JSON.stringify({ version: 1, sessionIds: [sessionsAfterFirstSend.sessions[0]!.sessionId] }),
		);
		await titleActions.click();
		titleMenu = page.getByRole("menu", { name: "Pinned packaged title session actions", exact: true });
		await titleMenu.getByRole("menuitem", { name: "Copy title", exact: true }).click();
		await expect(titleMenu).not.toBeVisible();
		await titleActions.click();
		titleMenu = page.getByRole("menu", { name: "Pinned packaged title session actions", exact: true });
		await titleMenu.getByRole("menuitem", { name: "Delete", exact: true }).click();
		const deleteTitleDialog = page.getByRole("dialog", { name: "Delete session?", exact: true });
		await expect(deleteTitleDialog).toBeVisible();
		await deleteTitleDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		titleMenu = page.getByRole("menu", { name: "Pinned packaged title session actions", exact: true });
		await titleMenu.getByRole("menuitem", { name: "Unpin", exact: true }).click();
		await expect(pinnedSection).toHaveCount(0);
		await expect(page.locator(".session-sidebar").getByRole("button", { name: "Pinned packaged title", exact: true })).toHaveCount(1);
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
		await page.getByRole("button", { name: "Trust", exact: true }).click();

		phase = "running the packaged extension image pipeline";
		await expect(page.getByRole("heading", { name: "Packaged image pipeline" })).toBeVisible();
		await expect(page.getByText("Worker and WASM returned 1x1", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Confirm" }).click();
		await page.locator(`[data-active-session-id="${trustedSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });

		phase = "verifying packaged Project Skill catalog";
		await page.getByRole("button", { name: "Customize", exact: true }).click();
		await expect(page.locator('.plugins-list-row[aria-label="packaged-project-skill"]')).toBeVisible();

		phase = "verifying packaged live MCP actions and secret redaction";
		await page.locator(".plugins-section-switch").getByRole("tab", { name: "MCP", exact: true }).click();
		await page.getByRole("option", { name: "packaged-http", exact: true }).click();
		await page.getByRole("button", { name: "Authentication", exact: true }).click();
		const userCredentialDialog = page.getByRole("dialog", { name: "Set authentication" });
		await userCredentialDialog.getByLabel("Bearer token (optional)").fill("METIS_E2E_USER_MCP_SECRET");
		await userCredentialDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(userCredentialDialog).toHaveCount(0);
		await page.getByRole("button", { name: "Back to MCP", exact: true }).click();
		await page.getByRole("button", { name: "New MCP", exact: true }).click();
		await page.getByRole("menu", { name: "New MCP", exact: true }).getByRole("menuitem", { name: "Project", exact: true }).click();
		const projectMcpDialog = page.getByRole("dialog", { name: "Create Project MCP" });
		await projectMcpDialog.getByRole("button", { name: "Import JSON", exact: true }).click();
		await projectMcpDialog.getByLabel("MCP JSON or JSONC", { exact: true }).fill(`{
			// Intentionally shadows the User definition.
			"mcpServers": {
				"packaged-http": {
					"type": "streamable-http",
					"url": "https://mcp.example.test/project",
					"enabled": false,
					"headers": { "Authorization": "Bearer METIS_E2E_PROJECT_MCP_SECRET" },
				},
			},
		}`);
		await projectMcpDialog.getByRole("button", { name: "Inspect", exact: true }).click();
		await expect(projectMcpDialog.locator(".mcp-import-candidate")).toHaveCount(1);
		await projectMcpDialog.getByRole("button", { name: "Import selected", exact: true }).click();
		await expect(projectMcpDialog).toHaveCount(0);
		await expect(page.getByRole("option", { name: "packaged-http", exact: true })).toHaveCount(2);
		expect(await page.locator("body").innerText()).not.toContain("METIS_E2E_USER_MCP_SECRET");
		expect(await page.locator("body").innerText()).not.toContain("METIS_E2E_PROJECT_MCP_SECRET");
		const globalSettingsText = await readFile(path.join(agentDir, "settings.json"), "utf8");
		const projectSettingsText = await readFile(path.join(projectDir, ".metis", "settings.json"), "utf8");
		expect(globalSettingsText).not.toContain("METIS_E2E_USER_MCP_SECRET");
		expect(projectSettingsText).not.toContain("METIS_E2E_PROJECT_MCP_SECRET");
		const authPath = path.join(agentDir, "auth.json");
		const authText = await readFile(authPath, "utf8");
		const auth = JSON.parse(authText) as Record<string, unknown>;
		const packagedCredentialKeys = Object.keys(auth).filter((key) => authHasMcpServer({ [key]: true }, "packaged-http"));
		expect(packagedCredentialKeys).toHaveLength(2);
		expect(authText).toContain("METIS_E2E_USER_MCP_SECRET");
		expect(authText).toContain("METIS_E2E_PROJECT_MCP_SECRET");
		if (process.platform !== "win32") expect((await stat(authPath)).mode & 0o077).toBe(0);
		await page.getByRole("button", { name: "MCP scopes", exact: true }).click();
		await page.getByRole("option", { name: "Project", exact: true }).click();
		await page.getByRole("option", { name: "packaged-http", exact: true }).click();
		await page.setViewportSize({ width: 1487, height: 1058 });
		await page.screenshot({ path: path.join(pluginQaDir, "actual-mcp-detail.png"), animations: "disabled" });
		await page.setViewportSize({ width: 1440, height: 1024 });
		const mcpAuthButton = page.getByRole("button", { name: "Authentication", exact: true });
		const mcpDeleteButton = page.getByRole("button", { name: "Delete", exact: true });
		await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Restart", exact: true }).click();
		await expect(mcpAuthButton).toBeEnabled();
		await mcpAuthButton.click();
		const credentialDialog = page.getByRole("dialog", { name: "Set authentication" });
		await credentialDialog.getByLabel("Bearer token (optional)").fill("METIS_E2E_PROJECT_REPLACEMENT");
		await credentialDialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(credentialDialog).toHaveCount(0);
		expect(await page.locator("body").innerText()).not.toContain("METIS_E2E_PROJECT_REPLACEMENT");
		await page.getByRole("button", { name: "Clear authentication", exact: true }).click();
		await expect(mcpDeleteButton).toBeEnabled();
		await expect(page.getByRole("button", { name: "Clear authentication", exact: true })).toHaveCount(0);
		await mcpDeleteButton.click();
		let removeMcpDialog = page.getByRole("dialog", { name: "Remove MCP server?" });
		await removeMcpDialog.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(removeMcpDialog).toHaveCount(0);
		await page.getByRole("button", { name: "MCP scopes", exact: true }).click();
		await page.getByRole("option", { name: "User", exact: true }).click();
		await page.getByRole("option", { name: "packaged-http", exact: true }).click();
		await expect(page.getByRole("button", { name: "Clear authentication", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Clear authentication", exact: true }).click();
		await expect(mcpDeleteButton).toBeEnabled();
		await mcpDeleteButton.click();
		removeMcpDialog = page.getByRole("dialog", { name: "Remove MCP server?" });
		await removeMcpDialog.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(removeMcpDialog).toHaveCount(0);
		await expect(page.getByRole("option", { name: "packaged-http", exact: true })).toHaveCount(0);
		const globalSettings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
		expect(globalSettings.mcpServers?.["packaged-http"]).toBeUndefined();
		const projectSettings = JSON.parse(await readFile(path.join(projectDir, ".metis", "settings.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
		expect(projectSettings.mcpServers?.["packaged-http"]).toBeUndefined();
		await page.locator(".project-group").filter({ hasText: path.basename(projectDir) }).locator(".session-button").click();
		await page.locator(`[data-active-session-id="${trustedSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });

		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		await expect.poll(() => appServerPid(rootPid)).not.toBeUndefined();

		phase = "running a fake provider turn";
		await page.locator("#composer-input").fill("packaged smoke turn");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(page.getByText("packaged-turn-ok", { exact: true })).toBeVisible();
		expect(providerRequests).toBe(3);

		phase = "answering packaged structured questions";
		await page.setViewportSize({ width: 1097, height: 588 });
		const transcriptScroll = page.locator(".transcript-scroll");
		const transcriptHeightBeforeQuestions = await transcriptScroll.evaluate((element) => element.clientHeight);
		await page.locator("#composer-input").fill("request packaged questions");
		await page.getByRole("button", { name: "Send" }).click();
		const questionPanel = page.locator(".ask-user-panel");
		await expect(questionPanel).toBeVisible();
		await expect(page.locator(".modal-backdrop")).toHaveCount(0);
		await expect(questionPanel).toContainText("How should Metis answer?");
		await expect(questionPanel).toContainText("Something else");
		await expect(questionPanel.locator(".ask-user-custom")).toHaveCount(0);
		const questionSlot = page.locator(".composer-dock > .ask-user-slot");
		const questionComposer = page.locator(".composer-dock > .composer-chat");
		await expect(page.locator(".composer-dock > .ask-user-slot + .composer-chat")).toHaveCount(1);
		await questionSlot.evaluate(async (element) => {
			await Promise.all(element.getAnimations().map((animation) => animation.finished));
		});
		const [questionSlotBox, questionComposerBox] = await Promise.all([
			questionSlot.boundingBox(),
			questionComposer.boundingBox(),
		]);
		expect(questionSlotBox).not.toBeNull();
		expect(questionComposerBox).not.toBeNull();
		expect(questionSlotBox!.x - questionComposerBox!.x).toBeCloseTo(16, 0);
		expect(questionComposerBox!.width - questionSlotBox!.width).toBeCloseTo(32, 0);
		expect(questionComposerBox!.y - questionSlotBox!.y - questionSlotBox!.height).toBeCloseTo(0, 0);
		expect(await transcriptScroll.evaluate((element) => element.clientHeight)).toBeLessThan(transcriptHeightBeforeQuestions);
		await questionPanel.getByRole("checkbox", { name: "Fast and concise", exact: true }).click();
		await questionPanel.getByRole("checkbox", { name: "Adapt to context", exact: true }).click();
		await questionPanel.getByRole("checkbox", { name: "Detailed explanation", exact: true }).focus();
		await expect(questionPanel.getByRole("checkbox", { checked: true })).toHaveCount(2);
		await page.screenshot({
			animations: "disabled",
			path: path.join(askUserQaDir, "inline-question-multi-first.png"),
		});
		await questionPanel.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(questionPanel).toContainText("Which communication style should Metis use?");
		await questionPanel.getByRole("checkbox", { name: "Friendly", exact: true }).click();
		await questionPanel.getByRole("checkbox", { name: "Contextual", exact: true }).click();
		await questionPanel.getByRole("checkbox", { name: "Friendly", exact: true }).focus();
		await expect(questionPanel.getByRole("checkbox", { checked: true })).toHaveCount(2);
		await page.screenshot({ animations: "disabled", path: path.join(askUserQaDir, "inline-question-multi-last.png") });
		phase = "opening the packaged multi-select custom answer";
		await questionPanel.getByRole("button", { name: "Something else", exact: true }).click({ timeout: 5_000 });
		phase = "filling the packaged multi-select custom answer";
		await expect(questionPanel.getByLabel("Something else")).toBeVisible({ timeout: 5_000 });
		await questionPanel.getByLabel("Something else").fill("Linux later", { timeout: 5_000 });
		phase = "submitting packaged structured questions";
		await page.screenshot({ animations: "disabled", path: path.join(askUserQaDir, "inline-question-multi-custom.png") });
		await questionPanel.getByRole("button", { name: "Confirm and continue", exact: true }).click();
		await expect(questionPanel).toHaveCount(0);
		await expect.poll(() => providerRequests).toBe(5);
		await expect.poll(() => transcriptScroll.evaluate((element) => element.clientHeight)).toBe(transcriptHeightBeforeQuestions);

		phase = "answering a packaged single-select question";
		await page.locator("#composer-input").fill("request packaged single question");
		await page.getByRole("button", { name: "Send" }).click();
		await expect(questionPanel).toContainText("Where should Metis store the task data?");
		await page.screenshot({ animations: "disabled", path: path.join(askUserQaDir, "inline-question-single.png") });
		await questionPanel.getByRole("radio", { name: "Cloud sync", exact: true }).click();
		await questionPanel.getByRole("button", { name: "Confirm and continue", exact: true }).click();
		await expect(questionPanel).toHaveCount(0);
		await expect.poll(() => providerRequests).toBe(7);

		phase = "approving a modal packaged permission request";
		await page.getByRole("button", { name: "Select permissions, current Auto", exact: true }).click();
		await page.getByRole("menuitemradio", { name: /Ask/u }).click();
		await expect(page.getByRole("button", { name: "Select permissions, current Ask", exact: true })).toBeVisible();
		const transcriptHeightBeforeApproval = await transcriptScroll.evaluate((element) => element.clientHeight);
		await page.locator("#composer-input").fill("request packaged approval");
		await page.getByRole("button", { name: "Send" }).click();
		const approvalPanel = page.locator(".permission-approval-panel");
		await expect(approvalPanel).toBeVisible();
		await expect(page.locator(".modal-backdrop")).toHaveCount(0);
		await expect(approvalPanel).toHaveAttribute("role", "dialog");
		await expect(approvalPanel).toContainText("Metis wants to use bash");
		await expect(approvalPanel.locator("dt", { hasText: "Command" })).toBeVisible();
		await expect(approvalPanel.locator("dd code", { hasText: "pwd" })).toBeVisible();
		await expect(approvalPanel.locator("dt", { hasText: "Working directory" })).toBeVisible();
		await expect(approvalPanel).not.toContainText("Arguments:");
		await expect(approvalPanel.locator(".permission-approval-complete-details")).toHaveCount(0);
		await expect(approvalPanel).toContainText("workspace sandbox");
		await expect(approvalPanel.locator('[aria-expanded]')).toHaveCount(0);
		expect(await transcriptScroll.evaluate((element) => element.clientHeight)).toBeLessThan(transcriptHeightBeforeApproval);
		const denyButton = approvalPanel.getByRole("button", { name: /Reject/u });
		const allowButton = approvalPanel.getByRole("button", { name: "Allow once", exact: true });
		const [denyBox, allowBox] = await Promise.all([denyButton.boundingBox(), allowButton.boundingBox()]);
		expect((allowBox?.x ?? 0)).toBeGreaterThan(denyBox?.x ?? 0);
		await page.screenshot({ path: path.join(permissionQaDir, "modal-approval.png") });
		await allowButton.click();
		await expect(approvalPanel).toHaveCount(0);
		await expect(page.locator(".modal-backdrop")).toHaveCount(0);
		await expect.poll(() => providerRequests).toBe(9);
		await expect.poll(() => transcriptScroll.evaluate((element) => element.clientHeight)).toBe(transcriptHeightBeforeApproval);

		phase = "creating and running a packaged scheduled task";
		await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Create your first scheduled task" })).toBeVisible();
		await page.setViewportSize({ width: 1272, height: 766 });
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-empty.png") });
		await page.setViewportSize({ width: 1440, height: 1024 });
		await page.getByLabel("Sort scheduled tasks").click();
		await expect(page.getByRole("listbox", { name: "Sort scheduled tasks" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-sort-menu.png") });
		await page.getByRole("option", { name: "Next run", exact: true }).click();
		const headerNewTaskTrigger = page.locator(".scheduled-tasks-header").getByRole("button", { name: "Create scheduled task", exact: true });
		await headerNewTaskTrigger.click();
		await expect(page.getByRole("listbox", { name: "Create scheduled task" })).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-new-task-menu-top.png") });
		await headerNewTaskTrigger.click();
		await headerNewTaskTrigger.click();
		const newTaskMenu = page.getByRole("listbox", { name: "Create scheduled task" });
		await expect(newTaskMenu).toBeVisible();
		await expect.poll(async () => (await newTaskMenu.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(204);
		const [newTaskTriggerBox, newTaskMenuBox] = await Promise.all([headerNewTaskTrigger.boundingBox(), newTaskMenu.boundingBox()]);
		expect(newTaskMenuBox?.width).toBeGreaterThanOrEqual(204);
		expect(Math.abs((newTaskMenuBox?.x ?? 0) + (newTaskMenuBox?.width ?? 0) - ((newTaskTriggerBox?.x ?? 0) + (newTaskTriggerBox?.width ?? 0)))).toBeLessThanOrEqual(1);
		await page.screenshot({ path: path.join(scheduleQaDir, "overview-new-task-menu.png") });
		await page.getByRole("option", { name: "Create with Metis", exact: true }).click();
		const workspaceDialog = page.getByRole("dialog", { name: "Where should this task work?" });
		await expect(workspaceDialog).toBeVisible();
		await page.screenshot({ path: path.join(scheduleQaDir, "create-with-metis-workspace.png") });
		await workspaceDialog.getByRole("button", { name: /Use default workspace/u }).click();
		await expect.poll(() => providerRequests).toBe(10);
		await expect(page.getByRole("heading", { name: "Set up a scheduled task", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await headerNewTaskTrigger.click();
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
		expect(providerRequests).toBe(11);
		expect(providerToolNames.at(-1)?.sort()).toEqual(
			["bash", "edit", "find", "grep", "ls", "read", "web_fetch", "web_search", "write"].sort(),
		);
		await expect(runNowButton).toBeEnabled();
		await page.mouse.move(0, 0);
		expect(await runNowButton.evaluate((element) => {
			const style = getComputedStyle(element);
			return { backgroundColor: style.backgroundColor, opacity: style.opacity };
		})).toEqual({ backgroundColor: await resolvedColor(page, "--button-primary-bg"), opacity: "1" });
		await page.screenshot({ path: path.join(scheduleQaDir, "task-detail.png") });
		await page.locator(".scheduled-task-history").getByRole("button").click();
		await expect(page.locator(".transcript-scroll").getByText("Summarize the current project status.", { exact: true })).toBeVisible();

		phase = "retaining and deleting a packaged scheduled session from the sidebar";
		await page.locator(".session-sidebar").getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await expect(page.locator("main").getByRole("heading", { name: "Scheduled tasks", exact: true })).toBeVisible();
		await page.locator(".scheduled-task-quick-list").getByRole("button", { name: "Morning brief", exact: true }).click();
		await expect(page.locator("main").getByRole("heading", { name: "Morning brief", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Delete task" }).click();
		const deleteTaskDialog = page.getByRole("dialog", { name: "Delete “Morning brief”?" });
		const deleteSessions = deleteTaskDialog.getByRole("checkbox", {
			name: /Also delete all session files generated by this task/u,
		});
		await expect(deleteSessions).not.toBeChecked();
		await deleteTaskDialog.getByRole("button", { name: "Delete", exact: true }).click();
		const retainedSessionRow = page.locator('.scheduled-task-quick-list .session-row[data-scheduled="true"]');
		await expect(retainedSessionRow.locator(".session-scheduled-badge")).toHaveCount(0);
		const retainedSessionDot = retainedSessionRow.locator(".session-button-title i");
		await expect(retainedSessionDot).toHaveCSS("width", "6px");
		await expect(retainedSessionDot).toHaveCSS("height", "6px");
		await expect(retainedSessionDot).toHaveCSS("border-radius", "50%");
		await expect(page.locator(".scheduled-task-quick-list").getByRole("heading", { name: "Scheduled tasks" })).toBeVisible();
		expect(await page.locator(".project-list").locator(
			":scope > .session-grouping-label, :scope > .loose-tasks > h2, :scope > .scheduled-task-quick-list > h2",
		).allTextContents()).toEqual(["Projects", "Tasks", "Scheduled tasks"]);
		await page.locator(".session-sidebar").screenshot({ path: path.join(scheduleQaDir, "retained-session-sidebar.png") });
		const retainedSessionName = await retainedSessionRow.locator(".session-button").getAttribute("aria-label");
		expect(retainedSessionName).toBeTruthy();
		await retainedSessionRow.hover();
		await page.locator(".session-sidebar").screenshot({ path: path.join(scheduleQaDir, "retained-session-sidebar-actions.png") });
		await retainedSessionRow.getByRole("button", { name: `Actions for ${retainedSessionName}`, exact: true }).click();
		await expect(page.locator(".session-action-menu").getByRole("menuitem")).toHaveText(["Pin", "Delete"]);
		await page.locator(".session-action-menu").getByRole("menuitem", { name: "Delete" }).click();
		await page.getByRole("dialog", { name: "Delete session?" }).getByRole("button", { name: "Move to Trash" }).click();
		await expect(retainedSessionRow).toHaveCount(0);
		await expect(page.locator(".scheduled-task-quick-list")).toHaveCount(0);
		const remainingSessions = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.listSessions({ limit: 200 }),
		);
		expect(remainingSessions.sessions).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Morning brief", scheduled: expect.any(Object) })]),
		);
		await page.locator(".session-sidebar").getByRole("button", { name: "Scheduled tasks", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Scheduled tasks", exact: true })).toBeVisible();
		await expect(page.locator(".scheduled-task-quick-list").getByText("Morning brief", { exact: true })).toHaveCount(0);

		phase = "reloading and restarting";
		await page.reload({ waitUntil: "domcontentloaded" });
		await projectGroup(page, path.basename(projectDir))
			.getByRole("button", { name: "Packaged smoke title", exact: true })
			.click();
		await expect(page.getByText("packaged-turn-ok", { exact: true }).first()).toBeVisible();
		const firstUtilityPid = appServerPid(rootPid);
		if (!firstUtilityPid) throw new Error("Could not find the packaged App Server");
		process.kill(firstUtilityPid, "SIGKILL");
		await expect.poll(() => appServerPid(rootPid)).not.toBe(firstUtilityPid);
		await waitForServerReady(page);
		finalUtilityPid = appServerPid(rootPid);
		if (!finalUtilityPid) throw new Error("Packaged App Server did not restart");

		phase = "quitting without an orphan";
		expect(consoleErrors).toEqual([]);
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		await expect.poll(() => processIsAlive(finalUtilityPid!)).toBe(false);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase} requests=${providerRequests}\nrenderer body:\n${bodyText ?? "unavailable"}\nrenderer errors:\n${consoleErrors.join("\n").slice(-8_000)}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged personal profile renders cached Token and Skill activity", async () => {
	test.setTimeout(60_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-profile-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "profile-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "profile");
	const settingsQaDir = path.join(desktopRoot, "test-results", "design-qa", "settings");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
		mkdir(settingsQaDir, { recursive: true }),
	]);
	const now = Date.now() - 60 * 60_000;
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
		manager.appendCustomEntry("metis.skill_usage.v1", { name: skillNames[index % skillNames.length], trigger: "read" });
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
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeFocused();
		await page.screenshot({ path: path.join(qaDir, "account-menu.png") });
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Profile", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Metis User", exact: true })).toBeVisible();
		await page.locator('.profile-avatar-actions input[type="file"]').setInputFiles({
			name: "avatar.png",
			mimeType: "image/png",
			buffer: Buffer.from(TINY_PNG, "base64"),
		});
		await expect(page.locator(".profile-avatar img")).toBeVisible();
		await expect(page.locator(".account-mark img")).toBeVisible();
		const storedAvatar = await page.evaluate(() =>
			(JSON.parse(localStorage.getItem("metis.profile.identity.v1") ?? "null") as { avatarDataUrl?: string } | null)
				?.avatarDataUrl,
		);
		expect(storedAvatar).toMatch(/^data:image\/webp;base64,/u);
		expect(storedAvatar!.length).toBeLessThan(50_000);
		const settingsBox = await page.locator(".settings-dialog").boundingBox();
		expect(Math.round(settingsBox?.width ?? 0)).toBe(1_440);
		expect(Math.round(settingsBox?.height ?? 0)).toBe(900);
		await expect(page.getByText("Most used Skills", { exact: true })).toBeVisible();
		await expect(page.locator(".profile-heatmap-week")).toHaveCount(53);
		await expect(page.getByText("pdf", { exact: true })).toBeVisible();

		phase = "checking profile data and cache";
		const measurements = await page.evaluate(async () => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
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
		await expect(page.locator('.profile-heatmap-cell[aria-label*="15.3K Tokens"]')).toHaveCount(1);
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
		const tooltipCell = page.locator(".profile-heatmap-cell").nth(185);
		// CDP can keep a just-launched packaged window visually rendered without
		// making it the native input target. Re-activate it before asserting a
		// pointer-only pseudo-class so the hover event reaches Chromium.
		await page.bringToFront();
		await tooltipCell.hover();
		await expect.poll(() => tooltipCell.evaluate((cell) => {
			const box = cell.getBoundingClientRect();
			const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
			return {
				hovered: cell.matches(":hover"),
				hit: hit ? `${hit.tagName}.${hit.className}` : null,
				hoverChain: Array.from(document.querySelectorAll(":hover"))
					.map((element) => `${element.tagName}.${element.className}`)
					.slice(-6),
				box: [box.left, box.top, box.width, box.height],
			};
		})).toMatchObject({ hovered: true });
		await expect.poll(() => tooltipCell.evaluate((cell) => getComputedStyle(cell, "::after").opacity)).toBe("1");
		expect.soft(await tooltipCell.evaluate((cell) => Number.parseInt(getComputedStyle(cell).zIndex, 10))).toBeGreaterThan(0);
		expect.soft(await tooltipCell.evaluate((cell) => Number.parseInt(getComputedStyle(cell.parentElement!).zIndex, 10))).toBeGreaterThan(0);
		const profileOverflow = await page.locator(".settings-page-scroll").evaluate((element) => element.scrollHeight - element.clientHeight);
		expect(profileOverflow).toBeLessThanOrEqual(1);
		await page.screenshot({ path: path.join(qaDir, "profile-1440x900.png") });
		await page.screenshot({ path: path.join(qaDir, "profile-tooltip-1440x900.png") });

		phase = "checking Usage settings";
		await page.getByRole("button", { name: "Usage", exact: true }).click();
		await expect(page.getByRole("button", { name: "Usage", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(".usage-bar")).toHaveCount(30);
		const usage = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getUsage({ rangeDays: 30 }),
		);
		expect(usage).toMatchObject({
			rangeDays: 30,
			totalTokens: 102_000,
			chatTokens: 35_700,
			codeTokens: 66_300,
			chatSessionCount: 3,
			codeSessionCount: 12,
			topModels: [{ provider: "openai", modelId: "profile-fixture", totalTokens: 102_000 }],
		});
		await page.locator(".usage-bar").last().hover();
		await page.setViewportSize({ width: 1440, height: 820 });
		await expect(page.locator(".usage-toolbar")).toHaveCSS("margin-bottom", "8px");
		await expect(page.locator(".usage-details-grid")).toHaveCSS("gap", "14px");
		const chartOverflow = await page.locator(".settings-page-scroll-profile").evaluate(
			(element) => element.scrollHeight - element.clientHeight,
		);
		expect(chartOverflow).toBeGreaterThan(0);
		expect(chartOverflow).toBeLessThanOrEqual(240);
		await page.screenshot({ path: path.join(settingsQaDir, "usage-1440x820.png") });
		const tableView = page.getByRole("button", { name: "Table view", exact: true });
		const chartView = page.getByRole("button", { name: "Chart view", exact: true });
		const chartCardHeight = await page.locator(".usage-chart-card").evaluate((element) => element.getBoundingClientRect().height);
		await tableView.click();
		await expect(tableView).toHaveAttribute("aria-pressed", "true");
		expect(await page.locator(".usage-table-wrap tbody tr")).toHaveCount(30);
		const tableCardHeight = await page.locator(".usage-chart-card").evaluate((element) => element.getBoundingClientRect().height);
		expect(Math.abs(chartCardHeight - tableCardHeight)).toBeLessThanOrEqual(1);
		const tableOverflow = await page.locator(".settings-page-scroll-profile").evaluate(
			(element) => element.scrollHeight - element.clientHeight,
		);
		expect(tableOverflow).toBeGreaterThan(0);
		expect(tableOverflow).toBeLessThanOrEqual(240);
		expect(await page.locator(".usage-view-toggle").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
		await page.screenshot({ path: path.join(settingsQaDir, "usage-table-30d-1440x820.png") });
		await chartView.click();
		await expect(chartView).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "7d", exact: true }).click();
		await expect(page.locator(".usage-bar")).toHaveCount(7);
		await tableView.click();
		await expect(tableView).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(".usage-table-wrap tbody tr")).toHaveCount(7);
		const compactTableOverflow = await page.locator(".settings-page-scroll-profile").evaluate(
			(element) => element.scrollHeight - element.clientHeight,
		);
		expect(compactTableOverflow).toBeGreaterThan(0);
		expect(compactTableOverflow).toBeLessThanOrEqual(240);
		await page.screenshot({ path: path.join(settingsQaDir, "usage-table-1440x820.png") });
		await chartView.click();
		await expect(chartView).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator(".usage-bar")).toHaveCount(7);

		phase = "checking Model settings";
		await page.getByRole("button", { name: "Model", exact: true }).click();
		await expect(page.locator(".settings-main-header").getByRole("heading", { name: "Model", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Browse providers", exact: true }).click();
		const providerGrid = page.locator(".model-provider-grid");
		await expect(providerGrid.locator(".model-provider-card")).not.toHaveCount(0);
		await page.screenshot({ path: path.join(settingsQaDir, "model-grid-1440x820.png") });
		const openAiProvider = providerGrid.locator(".model-provider-card").filter({
			has: page.getByText("OpenAI", { exact: true }),
		});
		await openAiProvider.click();
		await expect(page.locator(".model-provider-dialog")).toBeVisible();
		const builtinEditor = page.locator(".model-provider-editor");
		await expect(builtinEditor.getByLabel("API key", { exact: true })).toBeVisible();
		await expect(builtinEditor.getByLabel("Base URL", { exact: true })).toHaveCount(0);
		await builtinEditor.getByLabel("API key", { exact: true }).fill("openai-settings-secret");
		await builtinEditor.getByRole("button", { name: "Save API key", exact: true }).click();
		await expect(page.getByText("Provider saved", { exact: true })).toBeVisible();
		await expect(builtinEditor.getByText("••••••••••••", { exact: true })).toBeVisible();
		await builtinEditor.getByRole("button", { name: "Use this model", exact: true }).click();
		await expect(page.getByText("Defaults saved", { exact: true })).toBeVisible();
		const modelLayout = await page.locator(".settings-page-scroll").evaluate((scroll) => {
			const page = scroll.querySelector<HTMLElement>(".model-settings-page")!;
			const grid = page.querySelector<HTMLElement>(".model-provider-grid")!;
			return {
				outerOverflow: scroll.scrollHeight - scroll.clientHeight,
				columns: getComputedStyle(grid).gridTemplateColumns,
			};
		});
		expect(modelLayout.outerOverflow).toBeGreaterThan(0);
		await expect(page.locator(".settings-page-scroll-model")).toHaveCSS("overflow-y", "auto");
		expect(cssGridTrackCount(modelLayout.columns)).toBe(2);
		expect((await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getModelSettings(),
		)).defaultModel?.provider).toBe("openai");
		await page.screenshot({ path: path.join(settingsQaDir, "model-builtin-1440x820.png") });
		await builtinEditor.getByRole("button", { name: "Clear credentials", exact: true }).click();
		await expect(page.getByText("Credentials cleared", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Close provider settings", exact: true }).click();
		await expect(openAiProvider.getByText("Set up", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Add provider", exact: true }).click();
		const customProviderDialog = page.getByRole("dialog", { name: "Custom provider", exact: true });
		await expect(customProviderDialog.getByLabel("Provider name", { exact: true })).toBeVisible();
		await expect(customProviderDialog.getByLabel("Base URL", { exact: true })).toBeVisible();
		await expect(customProviderDialog.getByLabel("Model ID", { exact: true })).toBeVisible();
		await customProviderDialog.getByRole("button", { name: "Close provider settings", exact: true }).click();

		phase = "checking compact layout";
		await page.getByRole("button", { name: "Profile", exact: true }).click();
		await page.setViewportSize({ width: 960, height: 720 });
		await expect(page.getByRole("heading", { name: "Metis User", exact: true })).toBeVisible();
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
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged MCP creation matrix connects URL, custom, and JSON transports", async () => {
	test.setTimeout(120_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-mcp-matrix-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	const stdioFixture = path.resolve(desktopRoot, "../coding-agent/test/fixtures/mcp-stdio-server.mjs");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ mcpServers: {} }));
	createStoredSession(fixtures, agentDir, projectDir, CHAT_ACTIVE_ID, "chat", false, "MCP matrix fixture");
	new fixtures.ProjectTrustStore(agentDir).set(projectDir, true);

	const [urlServer, customServer, jsonServer] = await Promise.all([
		createMcpTestServer({
			requiredBearerToken: "url-bearer",
			requiredHeaders: { "x-url-extra": "url-extra", "x-url-secret": "url-header" },
		}),
		createMcpTestServer({
			requiredBearerToken: "custom-bearer",
			requiredHeaders: { "x-custom-secret": "custom-header" },
		}),
		createMcpTestServer({
			requiredBearerToken: "json-bearer",
			requiredHeaders: { "x-json-secret": "json-header" },
		}),
	]);
	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	const secrets = [
		"url-bearer",
		"url-header",
		"url-extra",
		"custom-bearer",
		"custom-header",
		"stdio-user-secret",
		"json-bearer",
		"json-header",
		"json-stdio-secret",
	];
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		await waitForServerReady(page);
		phase = "opening the MCP matrix fixture";
		await page.getByRole("button", { name: "MCP matrix fixture", exact: true }).click();
		await page.locator(`[data-active-session-id="${CHAT_ACTIVE_ID}"]`).waitFor({ state: "visible", timeout: 15_000 });
		await page.getByRole("button", { name: "Customize", exact: true }).click();
		await page.locator(".plugins-section-switch").getByRole("tab", { name: "MCP", exact: true }).click();

		const openCreation = async (scope: "User" | "Project") => {
			await page!.getByRole("button", { name: "New MCP", exact: true }).click();
			await page!.getByRole("menu", { name: "New MCP", exact: true }).getByRole("menuitem", { name: scope, exact: true }).click();
			return page!.getByRole("dialog", { name: `Create ${scope} MCP` });
		};
		const expectConnected = async (name: string, tool: string, inspectCatalog = false) => {
			const detail = page!.locator('[data-plugin-detail="mcp"]');
			const toolLabel = tool === "search_docs" ? "Search docs" : tool;
			await expect(detail.getByRole("heading", { name, exact: true })).toBeVisible();
			await expect(detail).toContainText("Connected", { timeout: 15_000 });
			await expect(detail.getByText(toolLabel, { exact: true })).toBeVisible();
			if (inspectCatalog) {
				await detail.getByRole("button", { name: toolLabel, exact: true }).click();
				await expect(detail).toContainText("Input schema");
				await expect(detail.locator(".mcp-catalog-item-detail")).toContainText("query");
				await detail.getByRole("button", { name: "review", exact: true }).click();
				await expect(detail).toContainText("target");
				await expect(detail).toContainText("Required");
			}
			await page!.getByRole("button", { name: "Back to MCP", exact: true }).click();
		};

		phase = "creating URL HTTP MCP";
		let dialog = await openCreation("User");
		await dialog.getByRole("button", { name: "Add by URL", exact: true }).click();
		await dialog.getByLabel("Name", { exact: true }).fill("url-http");
		await dialog.getByLabel("Description (optional)").fill("URL smoke server");
		await dialog.getByLabel("Server URL").fill(urlServer.url.toString());
		await dialog.getByLabel("Bearer token (optional)").fill("url-bearer");
		await dialog.getByRole("button", { name: "Add header", exact: true }).click();
		await dialog.getByRole("button", { name: "Add header", exact: true }).click();
		const urlHeaders = dialog.locator(".mcp-quick-header-row");
		for (const [index, header, variable, value] of [
			[0, "X-Url-Secret", "URL_HEADER", "url-header"],
			[1, "X-Url-Extra", "URL_EXTRA", "url-extra"],
		] as const) {
			await urlHeaders.nth(index).getByLabel("Header name").fill(header);
			await urlHeaders.nth(index).getByLabel("Environment name (optional)").fill(variable);
			await urlHeaders.nth(index).getByLabel("Secret value").fill(value);
		}
		await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
		await expect(dialog.locator(".mcp-import-candidate")).toHaveCount(1);
		await dialog.getByRole("button", { name: "Add selected", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expectConnected("url-http", "search_docs", true);

		phase = "creating custom HTTP MCP";
		dialog = await openCreation("User");
		await dialog.getByRole("button", { name: "Custom MCP", exact: true }).click();
		dialog = page.getByRole("dialog", { name: "MCP configuration" });
		await expect(dialog.getByLabel("Startup timeout (seconds)")).toHaveCount(0);
		await expect(dialog.getByLabel("Tool timeout (seconds)")).toHaveCount(0);
		await dialog.getByLabel("Server name", { exact: true }).fill("custom-http");
		await dialog.getByLabel("Description (optional)").fill("Custom HTTP smoke server");
		await dialog.getByLabel("Server URL").fill(customServer.url.toString());
		await dialog.getByRole("button", { name: "Add header", exact: true }).click();
		await dialog.getByRole("button", { name: "Add header", exact: true }).click();
		const customHeaders = dialog.locator(".mcp-quick-header-row");
		for (const [index, header, variable, value] of [
			[0, "Authorization", "CUSTOM_BEARER", "Bearer custom-bearer"],
			[1, "X-Custom-Secret", "CUSTOM_HEADER", "custom-header"],
		] as const) {
			await customHeaders.nth(index).getByLabel("Header name").fill(header);
			await customHeaders.nth(index).getByLabel("Environment name (optional)").fill(variable);
			await customHeaders.nth(index).getByLabel("Secret value").fill(value);
		}
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expectConnected("custom-http", "search_docs");

		phase = "creating custom STDIO MCP";
		dialog = await openCreation("User");
		await dialog.getByRole("button", { name: "Custom MCP", exact: true }).click();
		dialog = page.getByRole("dialog", { name: "MCP configuration" });
		await dialog.getByLabel("Transport").click();
		await page.getByRole("option", { name: "STDIO", exact: true }).click();
		await dialog.getByLabel("Server name", { exact: true }).fill("custom-stdio");
		await dialog.getByLabel("Command").fill(process.execPath);
		await dialog.getByLabel("Arguments, one per line").fill(stdioFixture);
		await dialog.getByLabel("Forwarded variable names, one per line").fill("LOCAL_TOKEN");
		await dialog.getByLabel("Working directory").fill(projectDir);
		await dialog.getByRole("button", { name: "Add secret", exact: true }).click();
		const stdioSecret = dialog.locator(".mcp-secret-row").first();
		await stdioSecret.getByLabel("Variable name").fill("LOCAL_TOKEN");
		await stdioSecret.getByLabel("Secret value").fill("stdio-user-secret");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expectConnected("custom-stdio", "env_status");

		phase = "batch importing JSONC HTTP and STDIO MCPs";
		dialog = await openCreation("Project");
		await dialog.getByRole("button", { name: "Import JSON", exact: true }).click();
		await dialog.getByLabel("MCP JSON or JSONC", { exact: true }).fill(`{
			// A single import must create both supported transports.
			"mcpServers": {
				"json-http": {
					"type": "streamable-http",
					"url": ${JSON.stringify(jsonServer.url.toString())},
					"headers": {
						"Authorization": "Bearer json-bearer",
						"X-Json-Secret": "json-header",
					},
				},
				"json-stdio": {
					"command": ${JSON.stringify(process.execPath)},
					"args": [${JSON.stringify(stdioFixture)}],
					"cwd": ${JSON.stringify(projectDir)},
					"env": { "LOCAL_TOKEN": "json-stdio-secret" },
				},
			},
		}`);
		await dialog.getByRole("button", { name: "Inspect", exact: true }).click();
		await expect(dialog.locator(".mcp-import-candidate")).toHaveCount(2);
		await expect(dialog.locator('.mcp-import-candidate input[type="checkbox"]:checked')).toHaveCount(2);
		await dialog.getByRole("button", { name: "Import selected", exact: true }).click();
		await expect(dialog).toHaveCount(0);

		for (const [name, tool] of [["json-http", "search_docs"], ["json-stdio", "env_status"]] as const) {
			await page.getByLabel("Search MCP servers").fill(name);
			await page.getByRole("option", { name, exact: true }).click();
			await expectConnected(name, tool);
		}

		phase = "checking MCP scope, persistence, and redaction";
		const globalSettingsText = await readFile(path.join(agentDir, "settings.json"), "utf8");
		const projectSettingsText = await readFile(path.join(projectDir, ".metis", "settings.json"), "utf8");
		const globalSettings = JSON.parse(globalSettingsText) as { mcpServers?: Record<string, unknown> };
		const projectSettings = JSON.parse(projectSettingsText) as { mcpServers?: Record<string, unknown> };
		expect(Object.keys(globalSettings.mcpServers ?? {}).sort()).toEqual(["custom-http", "custom-stdio", "url-http"]);
		expect(Object.keys(projectSettings.mcpServers ?? {}).sort()).toEqual(["json-http", "json-stdio"]);
		expect(globalSettings.mcpServers?.["url-http"]).toMatchObject({ description: "URL smoke server" });
		for (const server of Object.values({ ...(globalSettings.mcpServers ?? {}), ...(projectSettings.mcpServers ?? {}) })) {
			expect(server).not.toHaveProperty("enabledTools");
			expect(server).not.toHaveProperty("disabledTools");
		}
		const bodyText = await page.locator("body").innerText();
		for (const secret of secrets) {
			expect(globalSettingsText).not.toContain(secret);
			expect(projectSettingsText).not.toContain(secret);
			expect(bodyText).not.toContain(secret);
			expect(diagnostics.join("\n")).not.toContain(secret);
		}
		const authPath = path.join(agentDir, "auth.json");
		const authText = await readFile(authPath, "utf8");
		const auth = JSON.parse(authText) as Record<string, unknown>;
		expect(Object.keys(auth)).toHaveLength(5);
		for (const name of ["url-http", "custom-http", "custom-stdio", "json-http", "json-stdio"]) {
			expect(authHasMcpServer(auth, name), `missing MCP credential for ${name} in ${Object.keys(auth).join(", ")}`).toBe(
				true,
			);
		}
		for (const secret of secrets) expect(authText).toContain(secret);
		if (process.platform !== "win32") expect((await stat(authPath)).mode & 0o077).toBe(0);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await Promise.all([urlServer.close(), customServer.close(), jsonServer.close()]);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Code agent sidebar lists durable work and opens its transcript", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-agent-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "agent-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "agents");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	createStoredSession(fixtures, agentDir, projectDir, CODE_ID, "code", false, "Agent fixture");
	const childId = "30000000-0000-4000-8000-000000000001";
	const taskId = "30000000-0000-4000-8000-000000000002";
	const archivedId = "30000000-0000-4000-8000-000000000003";
	const oldTaskId = "30000000-0000-4000-8000-000000000005";
	const nestedId = "30000000-0000-4000-8000-000000000006";
	const nestedTaskId = "30000000-0000-4000-8000-000000000007";
	const agentHeader = {
		agentId: childId,
		name: "Packaged project inspector",
		agentType: "worker" as const,
		parentSessionId: CODE_ID,
		rootSessionId: CODE_ID,
		agentPath: [childId],
		cwd: projectDir,
		tools: ["read"],
		writePolicy: "inherit" as const,
		permissionPreset: "ask" as const,
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		initialTask: "Inspect packaged project",
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: true,
	};
	const child = fixtures.SessionManager.create(
		projectDir,
		fixtures.getSessionAgentDir(agentDir, CODE_ID),
		{
			id: childId,
			mode: "code",
			permissionPreset: "ask",
			agent: agentHeader,
		},
	);
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId: oldTaskId,
		text: "Inspect initial packaged state",
		taskSummary: "Inspect initial packaged state",
		status: "queued",
	});
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId: oldTaskId,
		text: "Inspect initial packaged state",
		taskSummary: "Inspect initial packaged state",
		status: "running",
	});
	child.appendMessage({ role: "user", content: "Inspect initial packaged state", timestamp: Date.now() - 1_000 });
	child.appendMessage({
		...assistantMessage(Date.now() - 999, 8),
		content: [{ type: "text", text: "Initial packaged handoff" }],
	});
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId: oldTaskId,
		text: "Inspect initial packaged state",
		taskSummary: "Inspect initial packaged state",
		status: "done",
		reason: "completed",
		finalMessage: "Initial packaged handoff",
	});
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId,
		text: "Inspect packaged project",
		taskSummary: "Inspect packaged project",
		status: "queued",
	});
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId,
		text: "Inspect packaged project",
		taskSummary: "Inspect packaged project",
		status: "running",
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
	child.appendAgentControl({
		type: "agent_task",
		agentId: childId,
		taskId,
		text: "Inspect packaged project",
		taskSummary: "Inspect packaged project",
		status: "done",
		reason: "completed",
		finalMessage: "Packaged child completed",
		usage: {
			model: { provider: "fixture", modelId: "fixture-model" },
			input: 10,
			output: 25,
			cacheRead: 0,
			cacheWrite: 0,
			elapsedMs: 2_000,
			toolCalls: 1,
			cost: 0,
		},
	});
	child.close();

	const nested = fixtures.SessionManager.create(
		projectDir,
		fixtures.getSessionAgentDir(agentDir, CODE_ID),
		{
			id: nestedId,
			mode: "code",
			permissionPreset: "ask",
			agent: {
				agentId: nestedId,
				name: "Nested verifier",
				agentType: "reviewer" as const,
				parentSessionId: childId,
				rootSessionId: CODE_ID,
				agentPath: [childId, nestedId],
				cwd: projectDir,
				tools: ["read"],
				writePolicy: "deny" as const,
				permissionPreset: "ask" as const,
				model: { provider: "fixture", modelId: "fixture-model" },
				thinkingLevel: "off",
				initialTask: "Verify nested packaged state",
				forkTurns: 0,
				timeoutSeconds: 60,
				mayDelegate: false,
			},
		},
	);
	nested.appendAgentControl({
		type: "agent_task",
		agentId: nestedId,
		taskId: nestedTaskId,
		text: "Verify nested packaged state",
		taskSummary: "Verify nested packaged state",
		status: "running",
	});
	nested.appendMessage({
		...assistantMessage(Date.now(), 5),
		content: [{ type: "text", text: "Nested packaged verification complete" }],
	});
	nested.appendAgentControl({
		type: "agent_task",
		agentId: nestedId,
		taskId: nestedTaskId,
		text: "Verify nested packaged state",
		taskSummary: "Verify nested packaged state",
		status: "done",
		reason: "completed",
		finalMessage: "Nested packaged verification complete",
	});
	nested.close();

	const archived = fixtures.SessionManager.create(
		projectDir,
		fixtures.getSessionAgentDir(agentDir, CODE_ID),
		{
			id: archivedId,
			mode: "code",
			permissionPreset: "ask",
			agent: {
				agentId: archivedId,
				name: "Archived result reviewer",
				agentType: "reviewer" as const,
				parentSessionId: CODE_ID,
				rootSessionId: CODE_ID,
				agentPath: [archivedId],
				cwd: projectDir,
				tools: ["read"],
				writePolicy: "deny" as const,
				permissionPreset: "ask" as const,
				model: { provider: "fixture", modelId: "fixture-model" },
				thinkingLevel: "off",
				initialTask: "Review archived result",
				forkTurns: 0,
				timeoutSeconds: 60,
				mayDelegate: false,
			},
		},
	);
	const archivedTaskId = "30000000-0000-4000-8000-000000000004";
	archived.appendAgentControl({
		type: "agent_task",
		agentId: archivedId,
		taskId: archivedTaskId,
		text: "Review archived result",
		taskSummary: "Review archived result",
		status: "running",
	});
	archived.appendMessage({
		...assistantMessage(Date.now(), 0),
		content: [{ type: "text", text: "## Archived result\n\nFound **no remaining issues**." }],
	});
	archived.appendAgentControl({
		type: "agent_task",
		agentId: archivedId,
		taskId: archivedTaskId,
		text: "Review archived result",
		taskSummary: "Review archived result",
		status: "done",
		reason: "completed",
		finalMessage: "## Archived result\n\nFound **no remaining issues**.",
	});
	archived.appendAgentControl({ type: "agent_archived", agentId: archivedId, archived: true });
	archived.close();

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
		await page.getByRole("button", { name: "Agent fixture", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CODE_ID);
		expect(await page.evaluate(() => typeof (window as Window & { metis?: { interruptAgent?: unknown } }).metis?.interruptAgent)).toBe("function");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged child completed");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged tool output");

		phase = "opening the Agents tool";
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.locator(".subagent-panel-heading").getByText("Agents", { exact: true })).toBeVisible();
		await expect(page.getByText("Inspect packaged project", { exact: true })).toBeVisible();
		const agentTree = page.getByRole("tree", { name: "Agent tree", exact: true });
		await expect(agentTree.getByRole("treeitem")).toHaveCount(2);
		await expect(agentTree.getByRole("treeitem").nth(0)).toHaveAttribute("aria-level", "1");
		await expect(agentTree.getByRole("treeitem").nth(0)).toHaveAttribute("aria-expanded", "true");
		await expect(agentTree.getByRole("treeitem").nth(1)).toHaveAttribute("aria-level", "2");
		await expect(page.getByText("35 tokens", { exact: true })).toBeVisible();
		await expect(page.getByText("1 tool use", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Collapse Packaged project inspector", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Nested verifier", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Expand Packaged project inspector", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Nested verifier", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Show archived", exact: true }).click();
		await page.getByRole("button", { name: "View summary for Archived result reviewer", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Archived result", exact: true })).toBeVisible();
		await expect(page.getByText("no remaining issues", { exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "Agent transcript", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Unarchive agent", exact: true }).click();
		await expect(page.getByRole("button", { name: "Archive agent", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Archive agent", exact: true }).click();
		await expect(page.getByRole("button", { name: "Unarchive agent", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to agents", exact: true }).click();
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
		await page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true }).click();
		const transcript = page.getByRole("region", { name: "Agent transcript", exact: true });
		await expect(transcript).toBeVisible();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		const taskSelector = page.locator(".subagent-task-selector .menu-select-trigger");
		const taskMenu = page.locator(".menu-select-popover");
		const chooseAgentTask = async (summary: string) => {
			await taskSelector.click();
			await taskMenu.getByRole("option", { name: summary }).click();
		};
		await chooseAgentTask("Inspect initial packaged state");
		await expect(page.getByText("Initial packaged handoff", { exact: true })).toBeVisible();
		await chooseAgentTask("Inspect packaged project");
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		expect(await transcript.locator("[data-transcript-item]").count()).toBeLessThanOrEqual(24);
		expect(await transcript.locator(".code-execution > summary").count()).toBeGreaterThanOrEqual(2);
		await transcript.locator(".code-execution > summary").last().click();
		await transcript.locator(".code-execution").last().locator(".code-command > summary").last().click();
		await expect(transcript.getByText("Packaged tool output", { exact: true })).toBeVisible();
		expect(await transcript.locator(".code-command-output").evaluate((element) => getComputedStyle(element).overflow)).toBe("auto");
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "detail-392x986.png") });
		await page.setViewportSize({ width: 1280, height: 938 });
		await resizeToolsSidebar(page, 856);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
		await page.locator(".tool-sidebar").screenshot({ path: path.join(qaDir, "detail-856x924.png") });
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged child completed");
		await expect(page.locator(".conversation-column")).not.toContainText("Packaged tool output");

		phase = "reopening the Agents tab";
		await page.getByRole("button", { name: "Close Agents", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true }).click();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		const reopenedTranscript = page.getByRole("region", { name: "Agent transcript", exact: true });
		await reopenedTranscript.locator(".code-execution > summary").last().click();
		await reopenedTranscript.locator(".code-execution").last().locator(".code-command > summary").last().click();
		await expect(page.getByText("Packaged tool output", { exact: true })).toBeVisible();

		phase = "deleting a nested agent";
		await page.getByRole("button", { name: "Back to agents", exact: true }).click();
		await page.getByRole("button", { name: "View transcript for Nested verifier", exact: true }).click();
		page.once("dialog", (dialog) => dialog.accept());
		await page.getByRole("button", { name: "Delete", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Nested verifier", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true }).click();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();

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
		await page.getByRole("button", { name: "Agent fixture", exact: true }).click();
		await expect(page.locator(`[data-active-session-id="${CODE_ID}"]`)).toBeVisible();
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await page.locator(".tool-sidebar-menu").getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true }).click();
		await expect(page.getByText("Packaged child completed", { exact: true })).toBeVisible();
		const restoredTranscript = page.getByRole("region", { name: "Agent transcript", exact: true });
		await restoredTranscript.locator(".code-execution > summary").last().click();
		await restoredTranscript.locator(".code-execution").last().locator(".code-command > summary").last().click();
		await expect(page.getByText("Packaged tool output", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Back to agents", exact: true }).click();
		await expect(page.getByRole("button", { name: "View transcript for Packaged project inspector", exact: true })).toBeFocused();
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged terminal sidebar runs a real PTY and keeps independent tabs", async () => {
	test.setTimeout(60_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-terminal-"));
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
				await (globalThis as unknown as { metis: MetisDesktopApi }).metis.writeTerminal({ terminalId: id, data: "" });
				return true;
			} catch {
				return false;
			}
		}, terminalId)).toBe(true);
		await page.evaluate(async (id) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.writeTerminal({
				terminalId: id,
				data: "printf '\\x4d\\x45\\x54\\x49\\x53\\x5f\\x54\\x45\\x52\\x4d\\x49\\x4e\\x41\\x4c\\x5f\\x45\\x32\\x45\\n'\r",
			});
		}, terminalId);
		await expect(page.locator('.terminal-panel[aria-hidden="false"] .xterm-rows')).toContainText("METIS_TERMINAL_E2E");
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
		expect(addGap).toBeLessThanOrEqual(4);
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
		await page.getByRole("button", { name: "Close Terminal 2", exact: true }).click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await sidebar.screenshot({ path: path.join(qaDir, "single-terminal-resized-panel.png") });
		await page.getByRole("button", { name: "Close Terminal", exact: true }).click();
		await expect(page.locator(".tool-sidebar-menu")).toBeVisible();
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Code files edit the authorized workspace with safe saves and previews", async () => {
	test.setTimeout(75_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-files-"));
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
		writeFixtureFile(path.join(projectDir, "README.md"), "# Metis workspace\n\nA real Markdown preview."),
		writeFixtureFile(path.join(projectDir, "notes.txt"), "plain text preview"),
		writeFixtureFile(path.join(projectDir, "docs", "guide.md"), "# Guide\n\nNested file."),
		writeFixtureFile(path.join(projectDir, ".env"), "METIS_FILE_BROWSER=1"),
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
		// The app-shell grid collapse animates for 200ms; opening the tools sidebar
		// mid-transition would read a mid-flight workspace width for its default size.
		await page.locator(".app-shell").evaluate(async (element) => {
			await Promise.all(element.getAnimations({ subtree: false }).map((animation) => animation.finished));
		});
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
		await expect.poll(() => codeEditorText(editor)).toBe("# Metis workspace\n\nA real Markdown preview.");
		await sidebar.screenshot({ path: path.join(qaDir, "direct-editor-default-width.png") });
		const resizeSidebar = (targetWidth: number) => resizeToolsSidebar(page!, targetWidth);
		await resizeSidebar(520);
		await page.getByRole("button", { name: "Hide tools sidebar", exact: true }).click();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(520);
		await resizeSidebar(392);
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
		await resizeSidebar(856);
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
		await editor.fill("# Saved from Metis\n");
		await expect(page.locator(".tool-tab.is-dirty")).toHaveCount(1);
		await editor.press("Meta+s");
		await expect(page.locator(".file-preview-notice")).toHaveText("File saved");
		await expect.poll(() => readFile(path.join(projectDir, "README.md"), "utf8")).toBe("# Saved from Metis\n");
		await expect(page.locator(".tool-tab.is-dirty")).toHaveCount(0);
		await page.getByRole("button", { name: "Show preview", exact: true }).click();
		await expect(page.locator(".file-markdown h1")).toHaveText("Saved from Metis");
		await page.getByRole("button", { name: "View source", exact: true }).click();
		await expect.poll(() => codeEditorText(editor)).toBe("# Saved from Metis\n");
		await page.getByRole("button", { name: "Copy path", exact: true }).click();
		await expect(page.locator(".file-preview-notice")).toHaveText("Path copied");
		await page.getByRole("button", { name: "Copy contents", exact: true }).click();
		await expect(page.locator(".file-preview-notice")).toHaveText("Contents copied");

		phase = "creating and managing a workspace file";
		const treeScroll = page.locator(".file-tree-scroll");
		const treeScrollBox = await treeScroll.boundingBox();
		if (!treeScrollBox) throw new Error("Missing file tree");
		await treeScroll.click({ button: "right", position: { x: 16, y: Math.max(24, treeScrollBox.height - 18) } });
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "New file", exact: true }).click();
		await page.getByRole("textbox", { name: "Name", exact: true }).fill("scratch.ts");
		await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
		let scratchEditor = page.getByRole("textbox", { name: "Edit scratch.ts", exact: true });
		await expect(scratchEditor).toBeVisible();
		await expect(page.locator(".cm-gutters")).toBeVisible();
		await expect(page.getByRole("tab", { name: "scratch.ts", exact: true }).locator(".file-kind-icon.is-typescript")).toBeVisible();
		await scratchEditor.fill("export const managed = true;\n");
		await expect(scratchEditor.locator("span", { hasText: /^export$/u })).toHaveCSS("color", "rgb(255, 123, 114)");
		await expect(page.locator('.file-tree-row [title="scratch.ts"] .file-kind-icon.is-typescript')).toBeVisible();
		await scratchEditor.press("Meta+f");
		await expect(page.locator(".cm-search")).toBeVisible();
		await sidebar.screenshot({ path: path.join(qaDir, "code-editor-find.png") });
		await scratchEditor.press("Escape");

		await page.locator('.file-tree-row [title="scratch.ts"]').click({ button: "right" });
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "Rename", exact: true }).click();
		await page.getByRole("textbox", { name: "Name", exact: true }).fill("managed.ts");
		await sidebar.screenshot({ path: path.join(qaDir, "rename-file-dialog.png") });
		await page.getByRole("textbox", { name: "Name", exact: true }).press("Enter");
		scratchEditor = page.getByRole("textbox", { name: "Edit managed.ts", exact: true });
		await expect.poll(() => codeEditorText(scratchEditor)).toBe("export const managed = true;\n");
		expect(existsSync(path.join(projectDir, "scratch.ts"))).toBe(false);
		expect(existsSync(path.join(projectDir, "managed.ts"))).toBe(true);

		await scratchEditor.press("Meta+s");
		await expect(page.locator(".file-preview-notice")).toHaveText("File saved");
		await expect.poll(() => readFile(path.join(projectDir, "managed.ts"), "utf8"))
			.toBe("export const managed = true;\n");

		await page.locator('.file-tree-row [title="managed.ts"]').click({ button: "right" });
		await page.getByRole("menu", { name: "File actions", exact: true }).getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
		const mutationDialog = page.getByRole("dialog", { name: "Move managed.ts to Trash?" });
		await expect(mutationDialog).toContainText("The saved version can be recovered from Trash.");
		await sidebar.screenshot({ path: path.join(qaDir, "move-file-to-trash-dialog.png") });
		await mutationDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		expect(existsSync(path.join(projectDir, "managed.ts"))).toBe(true);
		await page.getByRole("button", { name: "Close managed.ts", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Edit managed.ts", exact: true })).toHaveCount(0);

		await resizeSidebar(392);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-392x986.png") });
		await resizeSidebar(280);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-stacked-280x986.png") });
		await resizeSidebar(856);

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
		await expect.poll(() => codeEditorText(editor)).toBe("# Saved from Metis\n");
		await page.getByRole("button", { name: "Close binary.bin", exact: true }).click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await page.setViewportSize({ width: 1220, height: 938 });
		await resizeSidebar(904);
		[previewBox, treeBox] = await Promise.all([
			page.locator(".file-preview").boundingBox(),
			page.locator(".file-tree").boundingBox(),
		]);
		if (!previewBox || !treeBox) throw new Error("Files split layout is missing");
		expect(previewBox.width).toBeGreaterThan(treeBox.width);
		expect(treeBox.width).toBeGreaterThanOrEqual(220);
		await sidebar.screenshot({ path: path.join(qaDir, "markdown-tree-904x924.png") });

		phase = "protecting an external file change";
		await writeFile(path.join(projectDir, "README.md"), "# External change\n");
		await editor.fill("# Stale Metis draft\n");
		await sidebar.screenshot({ path: path.join(qaDir, "dirty-editor-900x924.png") });
		await editor.press("Meta+s");
		await expect(page.getByRole("alert")).toContainText("Workspace file changed on disk");
		await expect.poll(() => readFile(path.join(projectDir, "README.md"), "utf8")).toBe("# External change\n");
		await expect.poll(() => codeEditorText(editor)).toBe("# Stale Metis draft\n");
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
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Code review lazily renders diffs and keeps folder-controlled details responsive", async () => {
	test.setTimeout(120_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-review-"));
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
	git(projectDir, "init", "-b", "master");
	git(projectDir, "config", "user.email", "review@example.com");
	git(projectDir, "config", "user.name", "Metis Review");
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
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\nrenderer errors:\n${consoleErrors.join("\n").slice(-8_000)}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
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
			response.setHeader("Set-Cookie", "metis-browser=ready; Max-Age=3600; Path=/; SameSite=Lax");
			response.end("<!doctype html><title>Metis Browser Fixture</title><main>cookie stored</main>");
			return;
		}
		if (request.url === "/cookie") {
			response.end(`<!doctype html><title>Metis Cookie Check</title><main>${request.headers.cookie ?? "missing"}</main>`);
			return;
		}
		if (request.url === "/searchable") {
			response.end("<!doctype html><title>Search Fixture</title><main>open alpha open beta open gamma</main>");
			return;
		}
		if (request.url === "/stateful") {
			response.setHeader("Set-Cookie", "metis-browser=ready; Max-Age=3600; Path=/; SameSite=Lax");
			response.end("<!doctype html><title>Stateful Fixture</title><script>localStorage.setItem('metis-browser','ready')</script><main>state stored</main>");
			return;
		}
		if (request.url === "/inspect-state") {
			response.end("<!doctype html><title>Inspect State</title><main></main><script>document.querySelector('main').textContent = document.cookie + '|' + (localStorage.getItem('metis-browser') || '')</script>");
			return;
		}
		response.writeHead(404).end();
	});
	const fixturePort = await listen(fixtureServer);
	const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-browser-"));
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

		phase = "covering the native page with a global modal";
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
		await expect(settingsDialog).toBeVisible();
		await settingsDialog.getByRole("button", { name: "Back to app", exact: true }).click();
		await expect(settingsDialog).toBeHidden();
		await expect(embeddedPage.locator("main")).toHaveText("first page");

		await address.fill(`${fixtureOrigin}/set-cookie`);
		await address.press("Enter");
		await expect.poll(() =>
			browser!.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url() === `${fixtureOrigin}/set-cookie`),
		).toBe(true);
		embeddedPage = browser.contexts().flatMap((context) => context.pages())
			.find((candidate) => candidate.url() === `${fixtureOrigin}/set-cookie`);
		if (!embeddedPage) throw new Error("Embedded browser did not navigate to the cookie fixture");
		await expect(embeddedPage.locator("main")).toHaveText("cookie stored");
		await expect(page.getByRole("tab", { name: "Metis Browser Fixture", exact: true })).toBeVisible();
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
		await expect(page.getByRole("tab", { name: "Metis Browser Fixture", exact: true })).toBeVisible();
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
		await expect(cookiePage.locator("main")).toContainText("metis-browser=ready");
		await expect(page.getByRole("tab", { name: "Metis Cookie Check", exact: true })).toBeVisible();
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
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fixtureServer);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged General settings and Personalization persist across restart", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-settings-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "settings-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "settings");
	const viewport = { width: 1280, height: 840 };
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	createStoredSession(fixtures, agentDir, projectDir, CHAT_ACTIVE_ID, "chat", false, "Settings session");

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
	const consoleErrors: string[] = [];
	const captureConsoleErrors = (target: Page) => target.on("console", (message) => {
		// Shared CI runners can refuse WebGL contexts under GPU memory pressure;
		// SideRays degrades to a static background, which is not a defect.
		if (message.type() === "error" && message.text() !== "unable to create webgl context") {
			consoleErrors.push(message.text());
		}
	});
	try {
		({ browser, page } = await connectToApp(firstPort));
		captureConsoleErrors(page);
		page.setDefaultTimeout(10_000);
		await page.setViewportSize(viewport);
		await waitForServerReady(page);
		const settingsSession = page.locator('.session-button[aria-label="Settings session"]');
		await settingsSession.click();
		await expect(settingsSession).toHaveAttribute("aria-current", "page");

		phase = "opening General settings";
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "General", exact: true }).click();
		await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "English", exact: true })).toHaveAttribute("aria-pressed", "true");

		phase = "setting language typography and motion";
		await page.getByRole("button", { name: "中文", exact: true }).click();
		await expect(page.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
		await page.getByRole("button", { name: "Chat 字体", exact: true }).click();
		const fontMenuBox = await page.getByRole("listbox", { name: "Chat 字体", exact: true }).boundingBox();
		expect(fontMenuBox).not.toBeNull();
		expect(fontMenuBox!.x).toBeGreaterThanOrEqual(0);
		expect(fontMenuBox!.x + fontMenuBox!.width).toBeLessThanOrEqual(viewport.width);
		expect(fontMenuBox!.y + fontMenuBox!.height).toBeLessThanOrEqual(viewport.height);
		await page.getByRole("option", { name: "系统无衬线", exact: true }).click();
		await page.getByRole("button", { name: "Code 字体", exact: true }).click();
		await page.getByRole("option", { name: "系统衬线", exact: true }).click();
		const measureFixedSettingsLayout = () => page!.evaluate(() => ({
			settingsWidth: document.querySelector(".settings-dialog")?.getBoundingClientRect().width,
			sidebarWidth: document.querySelector(".settings-sidebar")?.getBoundingClientRect().width,
			controlHeight: document.querySelector('[aria-label="内容字号"]')?.getBoundingClientRect().height,
		}));
		const fixedLayoutBeforeFontSizeChange = await measureFixedSettingsLayout();
		await page.getByRole("button", { name: "内容字号", exact: true }).click();
		await page.getByRole("option", { name: "20 px", exact: true }).click();
		await expect.poll(() => page!.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim(),
		)).toBe("20px");
		expect(await measureFixedSettingsLayout()).toEqual(fixedLayoutBeforeFontSizeChange);
		await page.getByRole("button", { name: "减少动效", exact: true }).click();
		expect(await page.locator("html").getAttribute("data-motion")).toBe("reduced");
		const fonts = await page.evaluate(() => ({
			chat: getComputedStyle(document.documentElement).getPropertyValue("--chat-prose-font"),
			code: getComputedStyle(document.documentElement).getPropertyValue("--code-prose-font"),
		}));
		expect(fonts.chat).toContain("-apple-system");
		expect(fonts.code).toContain("Songti SC");
		expect(
			await page.locator(".settings-page-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth),
		).toBe(true);
		expect(
			await page.locator(".general-setting-row").evaluateAll((rows) =>
				rows.every((row) => {
					const copy = row.querySelector(".general-setting-copy")?.getBoundingClientRect();
					const control = row.querySelector(".general-setting-control")?.getBoundingClientRect();
					return copy !== undefined && control !== undefined && copy.right <= control.left;
				}),
			),
		).toBe(true);
		await expect(page.getByRole("button", { name: "深色", exact: true })).toHaveAttribute("aria-pressed", "true");
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "general-dark-1280x840.png") });

		phase = "configuring and revealing web search credentials";
		const searchSection = page.locator(".web-search-section");
		const searchToggle = searchSection.getByRole("switch", { name: "启用网络搜索", exact: true });
		const searchApiKey = searchSection.getByLabel("API Key", { exact: true });
		await searchSection.locator(".web-search-toggle").click();
		await expect(searchToggle).toBeChecked();
		await searchApiKey.fill("packaged-search-secret");
		await searchSection.getByRole("button", { name: "保存", exact: true }).click();
		await expect(searchSection.getByRole("status")).toContainText("已保存");
		await expect(searchApiKey).toHaveAttribute("type", "password");
		await expect(searchApiKey).toHaveAttribute("placeholder", "••••••••••••••••••••••••••••••••");
		await searchSection.getByRole("button", { name: "显示 API Key", exact: true }).click();
		await expect(searchApiKey).toHaveAttribute("type", "text");
		await expect(searchApiKey).toHaveValue("packaged-search-secret");
		await searchSection.getByRole("button", { name: "隐藏 API Key", exact: true }).click();
		await expect(searchApiKey).toHaveValue("");
		await searchSection.scrollIntoViewIfNeeded();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "web-search-dark-1280x840.png") });

		phase = "saving global instructions without reloading the open session";
		const statusBefore = await page.evaluate(async (sessionId) =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getSessionStatus({ sessionId }), CHAT_ACTIVE_ID);
		await page.getByRole("button", { name: "个性化", exact: true }).click();
		const instructions = page.getByRole("textbox", { name: "全局指令", exact: true });
		await expect(instructions).toBeVisible();
		await instructions.fill("Prefer concise answers.");
		await page.getByRole("button", { name: "保存指令", exact: true }).click();
		await expect(page.getByRole("status")).toContainText("已保存");
		expect(await readFile(path.join(agentDir, "AGENTS.md"), "utf8")).toBe("Prefer concise answers.");
		const statusAfter = await page.evaluate(async (sessionId) =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getSessionStatus({ sessionId }), CHAT_ACTIVE_ID);
		expect(statusAfter).toEqual(statusBefore);
		await instructions.focus();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "personalization-dark-1280x840.png") });

		phase = "checking flat Memory engine choices";
		await page.getByRole("button", { name: "记忆", exact: true }).click();
		await expect(page.getByRole("heading", { name: "记忆", exact: true })).toBeVisible();
		const memoryGrid = page.locator(".memory-engine-grid");
		await expect(memoryGrid).toHaveCSS("gap", "0px");
		await expect(memoryGrid.locator(".memory-engine-card").first()).toHaveCSS("border-radius", "0px");
		await expect(memoryGrid.locator(".memory-engine-card").nth(1)).toHaveCSS("border-left-width", "1px");
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "memory-dark-1280x840.png") });

		phase = "capturing matched light settings";
		await page.getByRole("button", { name: "通用", exact: true }).click();
		await page.getByRole("button", { name: "浅色", exact: true }).click();
		await expect(page.getByRole("button", { name: "浅色", exact: true })).toHaveAttribute("aria-pressed", "true");
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "general-light-1280x840.png") });
		await page.locator(".web-search-section").scrollIntoViewIfNeeded();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "web-search-light-1280x840.png") });
		await page.getByRole("button", { name: "记忆", exact: true }).click();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "memory-light-1280x840.png") });
		await page.getByRole("button", { name: "个性化", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "全局指令", exact: true })).toHaveValue("Prefer concise answers.");
		await page.getByRole("textbox", { name: "全局指令", exact: true }).focus();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "personalization-light-1280x840.png") });
		await page.getByRole("button", { name: "返回应用", exact: true }).click();
		await expect(settingsSession).toHaveAttribute("aria-current", "page");

		phase = "restarting with persisted settings";
		await browser.close();
		browser = undefined;
		await stopProcess(app);
		const restartPort = await reservePort();
		app = launchPackagedApp(executable, restartPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
		({ browser, page } = await connectToApp(restartPort));
		captureConsoleErrors(page);
		page.setDefaultTimeout(10_000);
		await page.setViewportSize(viewport);
		await waitForServerReady(page);
		await expect(page.getByRole("button", { name: "新建任务", exact: true })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");
		expect(await page.locator("html").getAttribute("data-motion")).toBe("reduced");
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await expect(page.getByRole("menuitem", { name: "设置", exact: true })).toBeFocused();
		await expect(page.getByRole("menuitem", { name: "语言", exact: true })).toHaveCount(0);
		await page.getByRole("menuitem", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "通用", exact: true }).click();
		await expect(page.getByRole("button", { name: "中文", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("button", { name: "浅色", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("button", { name: "Chat 字体", exact: true })).toContainText("系统无衬线");
		await expect(page.getByRole("button", { name: "Code 字体", exact: true })).toContainText("系统衬线");
		await expect(page.getByRole("button", { name: "内容字号", exact: true })).toContainText("20 px");
		expect(await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim(),
		)).toBe("20px");
		await expect(page.getByRole("button", { name: "减少动效", exact: true })).toHaveAttribute("aria-pressed", "true");
		const restartedSearchSection = page.locator(".web-search-section");
		await expect(restartedSearchSection.getByRole("switch", { name: "启用网络搜索", exact: true })).toBeChecked();
		await expect(restartedSearchSection.getByLabel("API Key", { exact: true })).toHaveAttribute(
			"placeholder",
			"••••••••••••••••••••••••••••••••",
		);
		const restartedFonts = await page.evaluate(() => ({
			chat: getComputedStyle(document.documentElement).getPropertyValue("--chat-prose-font"),
			code: getComputedStyle(document.documentElement).getPropertyValue("--code-prose-font"),
		}));
		expect(restartedFonts.chat).toContain("-apple-system");
		expect(restartedFonts.code).toContain("Songti SC");
		await page.getByRole("button", { name: "个性化", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "全局指令", exact: true })).toHaveValue("Prefer concise answers.");
		phase = "checking keyboard containment and 200 percent zoom-equivalent reflow";
		await page.setViewportSize({ width: viewport.width / 2, height: viewport.height / 2 });
		const settingsDialog = page.getByRole("dialog", { name: "设置", exact: true });
		const settingsDialogBox = await settingsDialog.boundingBox();
		expect(settingsDialogBox).not.toBeNull();
		expect(settingsDialogBox!.x).toBeGreaterThanOrEqual(0);
		expect(settingsDialogBox!.y).toBeGreaterThanOrEqual(0);
		expect(settingsDialogBox!.x + settingsDialogBox!.width).toBeLessThanOrEqual(viewport.width / 2);
		expect(settingsDialogBox!.y + settingsDialogBox!.height).toBeLessThanOrEqual(viewport.height / 2);
		expect(await settingsDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.closest(".settings-dialog") !== null)).toBe(true);
		await page.screenshot({
			animations: "disabled",
			path: path.join(qaDir, "personalization-light-200pct-reflow-640x420.png"),
		});
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Browser settings manage existing profiles, history, imports, and downloads", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-browser-settings-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "browser-settings-project");
	const userDataDir = path.join(tempRoot, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "browser-settings");
	const importedProfileId = "20000000-0000-4000-8000-000000000099";
	await Promise.all([
		mkdir(agentDir),
		mkdir(path.join(homeDir, "Downloads"), { recursive: true }),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);
	createStoredSession(fixtures, agentDir, projectDir, CHAT_ACTIVE_ID, "chat", false, "Browser settings session");
	const now = Date.now();
	await Promise.all([
		writeFile(path.join(userDataDir, "browser-profiles.json"), JSON.stringify({
			schemaVersion: 1,
			profiles: [{
				profileId: importedProfileId,
				name: "Work",
				sourceId: "chrome",
				sourceProfileId: "Profile 2",
			}],
		})),
		writeFile(path.join(userDataDir, "browser-history.json"), JSON.stringify([
			{ entryId: "30000000-0000-4000-8000-000000000001", url: "https://metis.example/docs", title: "Metis browser docs", faviconUrl: null, visitedAt: now - 30_000 },
			{ entryId: "30000000-0000-4000-8000-000000000002", url: "https://example.com/research", title: "Research notes", faviconUrl: null, visitedAt: now - 3_600_000 },
			{ entryId: "30000000-0000-4000-8000-000000000003", url: "https://example.com/archive", title: "Yesterday archive", faviconUrl: null, visitedAt: now - 86_400_000 },
		])),
		writeFile(path.join(userDataDir, `browser-history-${importedProfileId}.json`), JSON.stringify([
			{ entryId: "30000000-0000-4000-8000-000000000004", url: "https://work.example/dashboard", title: "Work dashboard", faviconUrl: null, visitedAt: now - 60_000 },
		])),
	]);

	const diagnostics: string[] = [];
	const debuggingPort = await reservePort();
	const app = launchPackagedApp(executable, debuggingPort, userDataDir, projectDir, agentDir, homeDir, diagnostics);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	const consoleErrors: string[] = [];
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
		await page.setViewportSize({ width: 1440, height: 900 });
		await waitForServerReady(page);

		phase = "opening Browser settings";
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		await page.getByRole("button", { name: "Browser", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Browser", exact: true })).toBeVisible();
		await expect(page.getByText("Browser data", { exact: true })).toBeVisible();
		await expect(page.getByText("System Downloads folder", { exact: true })).toBeVisible();
		const downloadDirectory = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getBrowserDownloadDirectory(),
		);
		expect(path.basename(downloadDirectory)).toBe("Downloads");
		await expect(page.getByText(downloadDirectory, { exact: true })).toBeVisible();
		await expect(page.getByText("2 profiles · 3 entries in selected profile", { exact: true })).toBeVisible();
		expect(await page.locator(".settings-page-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "overview-dark-1440x900.png") });

		phase = "checking browser import";
		await page.getByRole("button", { name: "Import browser data", exact: true }).click();
		const importDialog = page.getByRole("dialog", { name: "Import from browser", exact: true });
		await expect(importDialog).toBeVisible();
		if (process.platform === "win32") {
			await expect(importDialog.getByText("Google Chrome", { exact: true })).toBeVisible();
			await expect(
				importDialog.getByText(
					"On Windows, Metis currently imports browsing history only. Cookies and sign-in state are not imported.",
					{ exact: true },
				),
			).toBeVisible();
			await expect(importDialog.getByText("Cookies", { exact: true })).toHaveCount(0);
			await importDialog.getByRole("button", { name: "Import", exact: true }).click();
			await expect(importDialog).toHaveCount(0);
			await expect(page.getByText(/\d+ history entries retained/u)).toBeVisible();
		} else {
			await expect(importDialog.getByText("No supported browser profiles found", { exact: true })).toBeVisible();
			await importDialog.getByRole("button", { name: "Close", exact: true }).click();
		}

		phase = "managing profile history";
		await page.getByRole("button", { name: "Manage browsing history", exact: true }).click();
		await expect(page.getByRole("heading", { name: "Browsing history", exact: true })).toBeVisible();
		if (process.platform === "win32") {
			await page.getByRole("button", { name: "Browser profile", exact: true }).click();
			await page.getByRole("option", { name: "Metis — Default profile", exact: true }).click();
		}
		await expect(page.getByText("Metis browser docs", { exact: true })).toBeVisible();
		await expect(page.locator(".browser-settings-history-group")).toHaveCount(2);
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "history-dark-1440x900.png") });
		await page.getByRole("button", { name: "Browser profile", exact: true }).click();
		await page.getByRole("option", { name: "Google Chrome — Work", exact: true }).click();
		await expect(page.getByText("Work dashboard", { exact: true })).toBeVisible();
		const historySearch = page.getByRole("textbox", { name: "Search browsing history", exact: true });
		await historySearch.fill("missing");
		await expect(page.getByText("No matching history", { exact: true })).toBeVisible();
		await historySearch.fill("Work");
		await expect(page.getByText("Work dashboard", { exact: true })).toBeVisible();
		await historySearch.fill("");
		await page.getByRole("button", { name: "Clear browsing history", exact: true }).click();
		const clearDialog = page.getByRole("dialog", { name: "Clear browsing history?", exact: true });
		await expect(clearDialog).toBeVisible();
		await clearDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(page.getByText("Work dashboard", { exact: true })).toBeVisible();

		phase = "checking current-run downloads";
		await page.getByRole("button", { name: "Back to browser settings", exact: true }).click();
		await page.getByRole("button", { name: "Manage downloads", exact: true }).click();
		await expect(page.getByText("No downloads in this run", { exact: true })).toBeVisible();

		phase = "capturing Chinese visual QA states";
		await page.getByRole("button", { name: "Back to browser settings", exact: true }).click();
		await page.getByRole("button", { name: "General", exact: true }).click();
		await page.getByRole("button", { name: "中文", exact: true }).click();
		await page.getByRole("button", { name: "浏览器", exact: true }).click();
		await expect(page.getByRole("heading", { name: "浏览器", exact: true })).toBeVisible();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "overview-dark-zh-1440x900.png") });
		await page.getByRole("button", { name: "管理浏览记录", exact: true }).click();
		await expect(page.getByRole("heading", { name: "浏览记录", exact: true })).toBeVisible();
		await page.screenshot({ animations: "disabled", path: path.join(qaDir, "history-dark-zh-1440x900.png") });
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged Code project setup creates and opens a project", async () => {
	test.setTimeout(60_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-code-project-"));
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
		const codeProjectRoot = path.join(tempRoot, "Metis Projects");
		const codeProjectDir = path.join(codeProjectRoot, codeProjectName);
		const defaultLocation = await page.evaluate(() =>
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.getDefaultProjectLocation(),
		);
		expect(path.isAbsolute(defaultLocation)).toBe(true);
		expect(path.basename(defaultLocation)).toBe("Metis Projects");
		await page.evaluate((location) => localStorage.setItem("metis.codeProjectLocation", location), codeProjectRoot);
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("button", { name: "Create a new project", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Start a new project" })).toBeVisible();
		await page.getByRole("button", { name: "Back", exact: true }).click();
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
		// Project creation binds the folder to the pending draft; the session
		// materializes on first send.
		const canonicalCodeProjectDir = await realpath(codeProjectDir);
		const projectPicker = page.locator(".home-project-picker-code");
		await expect(projectPicker).toHaveAttribute("data-folder-selected", "true");
		await expect(projectPicker.getByRole("button", { name: "Choose folder" })).toHaveAttribute("title", canonicalCodeProjectDir);
		await page.getByRole("button", { name: "New task", exact: true }).click();
		await page.getByRole("button", { name: "Create a new project", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "Start a new project" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog", { name: "Create a new project" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged mode project actions preserve the other mode and shared project data", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-project-actions-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "shared-project");
	const userDataDir = path.join(tempRoot, "electron");
	const sourcePath = path.join(projectDir, "source-sentinel.txt");
	const skillPath = path.join(projectDir, ".metis", "skills", "shared-project-skill", "SKILL.md");
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
	await Promise.all([
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
		await sessionActionButton.focus();
		await expect(sessionActionButton).toHaveCSS("opacity", "1");
		await expect(sessionButton).toHaveCSS("background-color", await resolvedColor(page, "--surface-09"));
		await sessionActionButton.click();
		await expect(sessionActionButton).toHaveCSS("background-color", await resolvedColor(page, "--surface-18"));
		await page.locator(".session-sidebar").screenshot({ path: path.join(qaDir, "session-row-hover-inactive.png") });
		await page.keyboard.press("Escape");
		await sessionActionRow.getByRole("button", { name: "Session action target", exact: true }).click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", SESSION_ACTION_ID);
		await sessionActionButton.focus();
		await expect(sessionButton).toHaveCSS("background-color", await resolvedColor(page, "--panel-selected"));
		await sessionActionButton.click();
		await expect(sessionActionButton).toHaveCSS("background-color", await resolvedColor(page, "--surface-18"));
		await page.locator(".session-sidebar").screenshot({ path: path.join(qaDir, "session-row-hover-current.png") });
		const sessionActionMenu = page.getByRole("menu", { name: "Session action target session actions" });
		await expect(sessionActionMenu.getByRole("menuitem")).toHaveText(["Pin", "Rename", "Delete"]);
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
		await expect(page.locator(".new-task-home-heading h1")).toBeVisible();
		for (const removedPath of [sessionActionPath, sessionActionRecoveryPath, ...sessionActionOwnedPaths]) {
			expect(existsSync(removedPath), removedPath).toBe(false);
		}
		group = projectGroup(page, projectName);
		phase = "changing persisted session permissions";
		await group.locator(".session-button").first().click();
		await expect(page.locator(".workspace-header")).toHaveAttribute("data-active-session-id", CHAT_ACTIVE_ID);
		await page.getByRole("button", { name: "Select permissions, current Auto" }).click();
		await page.getByRole("menuitemradio", { name: /Full/u }).click();
		await expect(page.getByRole("button", { name: "Select permissions, current Full" })).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect.poll(async () => readFile(chatActivePath, "utf8")).toContain('"permissionPreset":"full"');
		await page.getByRole("button", { name: "Select permissions, current Full" }).click();
		await page.locator(".permission-selector-popover").evaluate(
			(element) => Promise.all(element.getAnimations().map((animation) => animation.finished)),
		);
		await page.screenshot({ path: path.join(qaDir, "permission-menu-normal.png") });
		await page.getByRole("menuitemradio", { name: /Ask/u }).click();
		await expect(page.getByRole("button", { name: "Select permissions, current Ask" })).toBeVisible();
		await expect.poll(async () => readFile(chatActivePath, "utf8")).toContain('"permissionPreset":"ask"');

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
		await page.evaluate((sessionId) => localStorage.setItem("metis.activeSessionId.code", sessionId), CODE_ID);
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
		for (const removedPath of [chatActivePath, chatArchivedPath, ...ownedPaths]) {
			expect(existsSync(removedPath), removedPath).toBe(false);
		}
		for (const preservedPath of [codePath, sourcePath, skillPath]) {
			expect(existsSync(preservedPath), preservedPath).toBe(true);
		}
		expect(await readFile(sourcePath, "utf8")).toBe("source must survive");
		expect(new fixtures.ProjectTrustStore(agentDir).get(projectDir)).toBe(true);

		phase = "reopening Code and shared Skills";
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await projectGroup(page, projectName).locator(".session-button").click();
		await expect(page.locator(`[data-active-session-id="${CODE_ID}"]`)).toBeVisible();
		await page.getByRole("button", { name: "Customize", exact: true }).click();
		await page.getByRole("button", { name: "Skill sources", exact: true }).click();
		await page.getByRole("option", { name: "Project", exact: true }).click();
		await expect(page.getByText("shared-project-skill", { exact: true })).toBeVisible();
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		if (!scheduleRemoved) await fixtures.ScheduleManager.create({ agentDir }).delete(SCHEDULE_ID, { deleteSessions: false }).catch(() => undefined);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged project delete preserves exact-cwd shared memory", async () => {
	test.setTimeout(60_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-project-memory-delete-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "shared-project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	const canonicalProjectDir = await realpath(projectDir);
	await fixtures.ensureModeScopedMemoryLayout(agentDir);

	const chatPath = createStoredSession(fixtures, agentDir, canonicalProjectDir, CHAT_ACTIVE_ID, "chat");
	const codePath = createStoredSession(fixtures, agentDir, canonicalProjectDir, CODE_ID, "code");
	const sharedMemory = fixtures.getAutoMemoryPaths(agentDir, canonicalProjectDir).project;
	const globalMemoryPath = path.join(agentDir, "memory", "global", "MEMORY.md");
	const globalMemoryTopicPath = path.join(path.dirname(globalMemoryPath), "global-sentinel.md");
	const projectMemoryTopicPath = path.join(sharedMemory.directory, "project-sentinel.md");
	const memoryIdentity = fixtures.memoryProjectIdentity(canonicalProjectDir);
	const memoryStore = fixtures.openMemoryStore(fixtures.getMemorySqlitePath(agentDir));
	try {
		memoryStore.resolveProject(memoryIdentity);
		const createdAt = "2026-01-01T00:00:00.000Z";
		memoryStore.insertFact({
			id: "global-sentinel",
			scope: "global",
			cwdKey: null,
			mode: null,
			topicFile: "global-sentinel.md",
			text: "shared global memory",
			status: "active",
			createdAt,
			sourceTurn: null,
			embedding: null,
			embeddingModel: null,
		});
		memoryStore.insertFact({
			id: "project-sentinel",
			scope: "project",
			cwdKey: memoryIdentity.projectKey,
			mode: null,
			topicFile: "project-sentinel.md",
			text: "shared project memory",
			status: "active",
			createdAt,
			sourceTurn: null,
			embedding: null,
			embeddingModel: null,
		});
		await fixtures.writeMemoryProjection(agentDir, memoryIdentity.projectKey, memoryStore);
	} finally {
		memoryStore.close();
	}

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedApp(
		executable,
		debuggingPort,
		userDataDir,
		canonicalProjectDir,
		agentDir,
		homeDir,
		diagnostics,
	);
	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		await waitForServerReady(page);
		phase = "deleting Chat through packaged RPC";
		const deletion = await page.evaluate(async (cwd) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			const preview = await api.previewProjectDelete({ mode: "chat", cwd });
			if (!preview.ok) throw new Error(preview.error.message);
			const result = await api.deleteProject({
				requestId: "10000000-0000-4000-8000-000000000007",
				mode: "chat",
				cwd,
				expectedRevision: preview.result.revision,
			});
			if (!result.ok) throw new Error(result.error.message);
			return result.result;
		}, canonicalProjectDir);
		expect(deletion).toMatchObject({ mode: "chat", cwd: canonicalProjectDir, deletedSessionCount: 1 });

		phase = "verifying shared memory preservation";
		expect(existsSync(chatPath), chatPath).toBe(false);
		for (const preservedPath of [
			codePath,
			sharedMemory.indexPath,
			projectMemoryTopicPath,
			globalMemoryPath,
			globalMemoryTopicPath,
		]) {
			expect(existsSync(preservedPath), preservedPath).toBe(true);
		}
		expect(await readFile(projectMemoryTopicPath, "utf8")).toBe("shared project memory\n");
		expect(await readFile(globalMemoryTopicPath, "utf8")).toBe("shared global memory\n");
		expect(await readFile(sharedMemory.indexPath, "utf8")).toContain("[project-sentinel.md](project-sentinel.md)");
		expect(await readFile(globalMemoryPath, "utf8")).toContain("[global-sentinel.md](global-sentinel.md)");
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});

test("packaged project delete fails closed for a held session lease and retries", async () => {
	test.setTimeout(90_000);
	const fixtures = await loadCodingFixtures();
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-project-lease-"));
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
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}${await appServerLogTail(userDataDir)}`,
		);
	} finally {
		if (!leaseReleased) held.close();
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, TEMP_REMOVE_OPTIONS);
	}
});
