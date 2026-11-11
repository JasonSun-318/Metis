import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { canonicalizePathForCreation } from "../../src/utils/paths.ts";

describe("SessionManager workspace directories", () => {
	let root: string;
	let project: string;
	let external: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-workspace-directories-"));
		project = join(root, "project");
		external = join(root, "external");
		mkdirSync(project);
		mkdirSync(external);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("canonicalizes, deduplicates, lists, and removes one added directory without changing cwd", () => {
		const manager = SessionManager.inMemory(project);
		const messageId = manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const alias = join(root, "external-alias");
		if (process.platform !== "win32") symlinkSync(external, alias, "dir");
		const input = process.platform === "win32" ? external : alias;
		const canonicalExternal = canonicalizePathForCreation(external);

		expect(manager.addWorkspaceDirectory(input)).toEqual({ path: canonicalExternal, changed: true });
		expect(manager.addWorkspaceDirectory(external)).toEqual({ path: canonicalExternal, changed: false });
		expect(manager.getCwd()).toBe(project);
		expect(manager.getWorkspaceRoots()).toEqual([canonicalizePathForCreation(project), canonicalExternal]);
		const roots = manager.getWorkspaceRoots() as string[];
		roots.pop();
		expect(manager.getWorkspaceRoots()).toEqual([canonicalizePathForCreation(project), canonicalExternal]);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([messageId]);
		expect(manager.getDurableJournalSnapshot().map((entry) => entry.type)).toContain("session_directory_added");
		expect(manager.removeWorkspaceDirectory(external)).toEqual({ path: canonicalExternal, changed: true });
		expect(manager.getAdditionalDirectories()).toEqual([]);
		manager.close();
	});

	it("persists controls across resume and keeps an unavailable path removable", () => {
		const manager = SessionManager.create(project, join(root, "sessions"));
		const sessionFile = manager.getSessionFile()!;
		const canonicalExternal = manager.addWorkspaceDirectory(external).path;
		manager.close();
		rmSync(external, { recursive: true });

		const resumed = SessionManager.open(sessionFile, join(root, "sessions"));
		expect(resumed.getAdditionalDirectories()).toEqual([canonicalExternal]);
		expect(resumed.removeWorkspaceDirectory(canonicalExternal)).toEqual({
			path: canonicalExternal,
			changed: true,
		});
		resumed.close();
	});

	it("rejects invalid input, files, and primary cwd removal", () => {
		const file = join(root, "file.txt");
		const manager = SessionManager.inMemory(project);
		writeFileSync(file, "x");

		expect(() => manager.addWorkspaceDirectory("")).toThrow("Directory path must not be empty");
		expect(() => manager.addWorkspaceDirectory(file)).toThrow("not a directory");
		expect(() => manager.addWorkspaceDirectory(join(root, "missing"))).toThrow("does not exist");
		expect(() => manager.removeWorkspaceDirectory(project)).toThrow("Primary working directory cannot be removed");
		manager.close();
	});

	it("clears roots for new, clone, fork, and imported sessions but preserves an in-file tree branch", () => {
		const sessions = join(root, "sessions");
		mkdirSync(sessions);
		const source = SessionManager.create(project, sessions);
		const leaf = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		source.addWorkspaceDirectory(external);
		const sourcePath = source.getSessionFile()!;

		source.branch(leaf);
		expect(source.getAdditionalDirectories()).toEqual([canonicalizePathForCreation(external)]);
		const clone = source.createBranchedSessionManager(leaf);
		expect(clone.getAdditionalDirectories()).toEqual([]);
		clone.close();
		source.close();

		const fork = SessionManager.forkFrom(sourcePath, project, sessions);
		expect(fork.getAdditionalDirectories()).toEqual([]);
		fork.close();

		const imported = SessionManager.importFrom(sourcePath, join(sessions, "imported.jsonl"));
		expect(imported.getAdditionalDirectories()).toEqual([]);
		imported.close();

		const reopened = SessionManager.open(sourcePath, sessions);
		reopened.newSession({ mode: "code" });
		expect(reopened.getAdditionalDirectories()).toEqual([]);
		reopened.close();
	});
});
