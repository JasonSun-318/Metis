import type { SpawnSyncReturns } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setKeybindings } from "@arcmind/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { persistToolOutputText } from "../src/core/large-tool-output.ts";
import { getSessionAttachmentDir, importSessionAttachments } from "../src/core/session-attachments.ts";
import {
	getSessionDisplayMetadataPath,
	getSessionImageDir,
	getSessionSubagentDir,
	getSessionToolOutputDir,
	type SessionInfo,
	SessionManager,
} from "../src/core/session-manager.ts";
import { deleteSessionFile, SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg } from "./utilities.ts";

const childProcessMocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(...args: unknown[]) => SpawnSyncReturns<string>>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: childProcessMocks.spawnSync,
}));

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function withoutTrash<T>(callback: () => Promise<T>): Promise<T> {
	const previous = childProcessMocks.spawnSync.getMockImplementation();
	const error = Object.assign(new Error("spawn trash ENOENT"), { code: "ENOENT" });
	childProcessMocks.spawnSync.mockReturnValue({
		pid: 0,
		output: [null, "", ""],
		stdout: "",
		stderr: "",
		status: null,
		signal: null,
		error,
	});
	try {
		return await callback();
	} finally {
		if (previous) childProcessMocks.spawnSync.mockImplementation(previous);
		else childProcessMocks.spawnSync.mockReset();
	}
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		mode: overrides.mode ?? "code",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
		childProcessMocks.spawnSync.mockReset();
		childProcessMocks.spawnSync.mockImplementation((_command, rawArgs) => {
			const args = rawArgs as readonly string[];
			try {
				for (const path of args) {
					if (path !== "--") rmSync(path, { recursive: true, force: true });
				}
				return { pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null };
			} catch (error) {
				return {
					pid: 1,
					output: [null, "", String(error)],
					stdout: "",
					stderr: String(error),
					status: 1,
					signal: null,
				};
			}
		});
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("deletes the session image directory with the session file", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-images-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		const data = Buffer.from("image").toString("base64");
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const imageDir = getSessionImageDir(sessionFile);
		session.close();

		const result = await deleteSessionFile(sessionFile);
		expect(result).toEqual({ ok: true, method: "trash" });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(imageDir)).toBe(false);
	});

	it("deletes the session tool output directory with the session file", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-tool-output-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputDir = getSessionToolOutputDir(sessionFile);
		const outputPath = await persistToolOutputText("large result", toolOutputDir);
		session.close();

		const resumed = SessionManager.open(sessionFile, baseDir, baseDir);
		expect(readFileSync(outputPath, "utf8")).toBe("large result");
		resumed.close();

		const result = await deleteSessionFile(sessionFile);
		expect(result).toEqual({ ok: true, method: "trash" });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(outputPath)).toBe(false);
		expect(existsSync(toolOutputDir)).toBe(false);
	});

	it("deletes attachments from the runtime agent directory", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-attachments-"));
		tempDirs.push(baseDir);
		const agentDir = join(baseDir, "custom-agent");
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const sessionId = session.getSessionId();
		const source = join(baseDir, "report.pdf");
		writeFileSync(source, "pdf");
		importSessionAttachments({
			agentDir,
			sessionId,
			cwd: baseDir,
			attachments: [{ path: source }],
		});
		const attachmentDir = getSessionAttachmentDir(agentDir, sessionId);
		session.close();

		const result = await deleteSessionFile(sessionFile, agentDir);
		expect(result).toEqual({ ok: true, method: "trash" });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(attachmentDir)).toBe(false);
	});

	it("deletes only owned Subagent, document-work, and journal recovery artifacts", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-owned-"));
		tempDirs.push(baseDir);
		const agentDir = join(baseDir, "agent");
		mkdirSync(agentDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const sessionId = session.getSessionId();
		const subagentDir = getSessionSubagentDir(agentDir, sessionId);
		const workRoot = join(agentDir, "tmp", "document-work");
		const workDir = join(workRoot, `${sessionId}-ABC123`);
		const unrelatedWorkDir = join(workRoot, "unrelated-session-ABC123");
		const recoveryArtifact = join(
			dirname(sessionFile),
			`.${basename(sessionFile)}.00000000-0000-4000-8000-000000000001.replace.bak`,
		);
		const memorySentinel = join(agentDir, "memory", "keep.txt");
		mkdirSync(subagentDir, { recursive: true });
		mkdirSync(workDir, { recursive: true });
		mkdirSync(unrelatedWorkDir, { recursive: true });
		mkdirSync(dirname(memorySentinel), { recursive: true });
		writeFileSync(join(subagentDir, "child.jsonl"), "child");
		writeFileSync(join(workDir, "document.txt"), "work");
		writeFileSync(join(unrelatedWorkDir, "keep.txt"), "keep");
		writeFileSync(recoveryArtifact, readFileSync(sessionFile));
		writeFileSync(memorySentinel, "keep");
		session.close();

		const result = await deleteSessionFile(sessionFile, agentDir);

		expect(result).toEqual({ ok: true, method: "trash" });
		for (const removed of [sessionFile, subagentDir, workDir, recoveryArtifact]) {
			expect(existsSync(removed), removed).toBe(false);
		}
		expect(readFileSync(join(unrelatedWorkDir, "keep.txt"), "utf8")).toBe("keep");
		expect(readFileSync(memorySentinel, "utf8")).toBe("keep");
	});

	it("deletes active-path assets when the journal is archived", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-archived-"));
		tempDirs.push(baseDir);
		const agentDir = join(baseDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		const activeDir = join(sessionsRoot, "project");
		const archivedDir = join(sessionsRoot, ".archive", "project");
		mkdirSync(activeDir, { recursive: true });
		mkdirSync(archivedDir, { recursive: true });
		const session = SessionManager.create(baseDir, activeDir);
		session.appendSessionInfo("Archived name");
		session.appendMessage({
			role: "user",
			content: [{ type: "image", data: Buffer.from("image").toString("base64"), mimeType: "image/png" }],
			timestamp: 1,
		});
		const activePath = session.getSessionFile()!;
		const activeMetadata = getSessionDisplayMetadataPath(activePath);
		const activeImageDir = getSessionImageDir(activePath);
		const activeToolDir = getSessionToolOutputDir(activePath);
		await persistToolOutputText("large result", activeToolDir);
		session.close();
		const archivedPath = join(archivedDir, basename(activePath));
		renameSync(activePath, archivedPath);

		const options = { agentDir, sessionsRoot };
		const result = await SessionManager.deleteSession(archivedPath, options);

		expect(result.ok).toBe(true);
		expect(existsSync(archivedPath)).toBe(false);
		expect(existsSync(activeImageDir)).toBe(false);
		expect(existsSync(activeToolDir)).toBe(false);
		expect(existsSync(activeMetadata)).toBe(false);
	});

	it("keeps the journal retryable when Trash is unavailable", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-no-trash-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		const sessionFile = session.getSessionFile()!;
		session.close();

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));

		expect(result).toMatchObject({ ok: false, method: "trash" });
		expect(existsSync(sessionFile)).toBe(true);
	});

	it("succeeds when the session tool output directory is missing", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-no-tool-output-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputDir = getSessionToolOutputDir(sessionFile);
		session.close();

		const result = await deleteSessionFile(sessionFile);
		expect(result).toEqual({ ok: true, method: "trash" });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(toolOutputDir)).toBe(false);
	});

	it("keeps the session retryable when an owned target cannot be trashed", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-tool-output-failure-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputRoot = join(baseDir, "tool-results");
		writeFileSync(toolOutputRoot, "not a directory");
		session.close();

		const result = await deleteSessionFile(sessionFile);
		expect(result).toMatchObject({ ok: false, method: "trash" });
		expect(existsSync(sessionFile)).toBe(true);
		expect(existsSync(toolOutputRoot)).toBe(true);
	});

	it("removes a tool output directory symlink without deleting its target", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-tool-output-link-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputDir = getSessionToolOutputDir(sessionFile);
		const externalDir = join(baseDir, "external");
		mkdirSync(join(baseDir, "tool-results"), { recursive: true });
		mkdirSync(externalDir);
		const sentinel = join(externalDir, "keep.txt");
		writeFileSync(sentinel, "keep");
		symlinkSync(externalDir, toolOutputDir, "dir");
		session.close();

		const result = await deleteSessionFile(sessionFile);
		expect(result).toEqual({ ok: true, method: "trash" });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(toolOutputDir)).toBe(false);
		expect(existsSync(sentinel)).toBe(true);
	});

	it("refuses to delete a session while another live writer owns it", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-live-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		const sessionFile = session.getSessionFile()!;

		const result = await deleteSessionFile(sessionFile);

		expect(result).toMatchObject({ ok: false, method: "unlink" });
		expect(result.error).toContain("already in use");
		expect(existsSync(sessionFile)).toBe(true);
		session.close();
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("sorts threaded sessions by latest activity in their subtree", async () => {
		const parentOne = makeSession({
			id: "parent-one",
			name: "Parent one",
			modified: new Date("2026-01-02T00:00:00.000Z"),
		});
		const parentTwo = makeSession({
			id: "parent-two",
			name: "Parent two",
			modified: new Date("2026-01-01T00:00:00.000Z"),
		});
		const childTwo = makeSession({
			id: "child-two",
			name: "Child two",
			parentSessionPath: parentTwo.path,
			modified: new Date("2026-01-03T00:00:00.000Z"),
		});

		const selector = new SessionSelectorComponent(
			async () => [parentOne, parentTwo, childTwo],
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		const parentTwoIndex = output.indexOf("Parent two");
		const childTwoIndex = output.indexOf("└─ Child two");
		const parentOneIndex = output.indexOf("Parent one");

		expect(parentTwoIndex).toBeGreaterThanOrEqual(0);
		expect(childTwoIndex).toBeGreaterThan(parentTwoIndex);
		expect(parentOneIndex).toBeGreaterThan(childTwoIndex);
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			paths.parentAliasA,
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
