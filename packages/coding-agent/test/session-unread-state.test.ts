import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDefaultSessionDir,
	getSessionUnreadStatePath,
	moveSessionFileWithLease,
	SessionManager,
} from "../src/core/session-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session unread state", () => {
	it("defaults to read and survives rename, reopen, and move", () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-unread-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), {
			id: "11111111-1111-4111-8111-111111111111",
			mode: "chat",
		});
		expect(manager.getSessionUnread()).toBe(false);
		manager.setSessionUnread(true);
		manager.appendSessionInfo("Renamed while unread");
		const source = manager.getSessionFile()!;
		manager.close();

		const reopened = SessionManager.open(source);
		expect(reopened.getSessionUnread()).toBe(true);
		expect(reopened.getSessionName()).toBe("Renamed while unread");
		reopened.close();

		const destination = join(dirname(source), "moved-session.jsonl");
		moveSessionFileWithLease(source, destination);
		expect(existsSync(getSessionUnreadStatePath(source))).toBe(false);
		expect(existsSync(getSessionUnreadStatePath(destination))).toBe(true);

		const moved = SessionManager.open(destination);
		expect(moved.getSessionUnread()).toBe(true);
		moved.setSessionUnread(false);
		expect(moved.getSessionUnread()).toBe(false);
		moved.close();
		expect(existsSync(getSessionUnreadStatePath(destination))).toBe(false);
	});
});
