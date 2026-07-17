import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@arcmind/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	getSessionImageDir,
	getSessionToolOutputDir,
	type SessionInfo,
	SessionManager,
} from "../src/core/session-manager.ts";
import { deleteSessionFile, SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg } from "./utilities.ts";

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
	const previousPath = process.env.PATH;
	process.env.PATH = "";
	try {
		return await callback();
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
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

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));
		expect(result).toEqual({ ok: true, method: "unlink", warning: undefined });
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
		mkdirSync(toolOutputDir, { recursive: true });
		writeFileSync(join(toolOutputDir, "result.txt"), "large result");
		session.close();

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));
		expect(result).toEqual({ ok: true, method: "unlink", warning: undefined });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(toolOutputDir)).toBe(false);
	});

	it("succeeds when the session tool output directory is missing", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-no-tool-output-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputDir = getSessionToolOutputDir(sessionFile);
		session.close();

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));
		expect(result).toEqual({ ok: true, method: "unlink", warning: undefined });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(toolOutputDir)).toBe(false);
	});

	it("warns when the session tool output directory cannot be removed", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "arcmind-session-delete-tool-output-failure-"));
		tempDirs.push(baseDir);
		const session = SessionManager.create(baseDir, baseDir);
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile()!;
		const toolOutputRoot = join(baseDir, "tool-results");
		writeFileSync(toolOutputRoot, "not a directory");
		session.close();

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));
		expect(result).toMatchObject({ ok: true, method: "unlink" });
		expect(result.warning).toContain("tool output");
		expect(existsSync(sessionFile)).toBe(false);
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

		const result = await withoutTrash(() => deleteSessionFile(sessionFile));
		expect(result).toEqual({ ok: true, method: "unlink", warning: undefined });
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
