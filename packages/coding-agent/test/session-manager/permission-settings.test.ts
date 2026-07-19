import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const timestamp = "2026-07-17T00:00:00.000Z";

function writeRecords(path: string, records: readonly unknown[]): void {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("SessionManager permission settings", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "arcmind-permissions-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("uses mode defaults and persists explicit v6 header settings", () => {
		const chat = SessionManager.inMemory(directory, { mode: "chat" });
		expect(chat.getPermissionSettings()).toEqual({ mode: "ask", reviewerEnabled: true });
		expect(chat.getHeader()).toMatchObject({
			version: 7,
			cwdOrigin: "user-selected",
			permissionMode: "ask",
			reviewerEnabled: true,
		});
		chat.close();

		const code = SessionManager.inMemory(directory);
		expect(code.getPermissionSettings()).toEqual({ mode: "auto", reviewerEnabled: true });
		code.close();
	});

	it("reduces permission controls without advancing or exposing the transcript tree", () => {
		const session = SessionManager.inMemory(directory, { mode: "code" });
		const leafId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const controlId = session.setPermissionSettings({ mode: "full", reviewerEnabled: false });
		const decisionId = session.appendPermissionDecision({
			actionId: "action-1",
			toolName: "bash",
			source: "user",
			decision: "allow",
			reason: "approved once",
		});

		expect(session.getPermissionSettings()).toEqual({ mode: "full", reviewerEnabled: false });
		expect(session.getLeafId()).toBe(leafId);
		expect(session.getEntries().map((entry) => entry.id)).toEqual([leafId]);
		expect(session.getEntry(controlId)).toBeUndefined();
		expect(session.getEntry(decisionId)).toBeUndefined();
		expect(session.getTree()).toHaveLength(1);
		expect(session.getDurableJournalSnapshot().slice(2)).toMatchObject([
			{ type: "session_permissions", id: controlId, parentId: leafId },
			{ type: "session_permission_decision", id: decisionId, parentId: leafId },
		]);
		session.close();
	});

	it("restores the latest settings and audit log from a persisted session", () => {
		const session = SessionManager.create(directory, directory, { mode: "chat" });
		const path = session.getSessionFile()!;
		session.setPermissionSettings({ mode: "auto", reviewerEnabled: false });
		session.appendPermissionDecision({
			actionId: "network-1",
			toolName: "web_search",
			source: "reviewer",
			decision: "ask",
			reason: "external network access",
		});
		session.close();

		const reopened = SessionManager.open(path, directory);
		expect(reopened.getPermissionSettings()).toEqual({ mode: "auto", reviewerEnabled: false });
		expect(reopened.getEntries()).toEqual([]);
		expect(reopened.getDurableJournalSnapshot().map((entry) => entry.type)).toEqual([
			"session",
			"session_permissions",
			"session_permission_decision",
		]);
		reopened.close();
	});

	it("derives safe defaults for legacy Chat and Code headers", () => {
		for (const [id, mode, expected] of [
			["legacy-chat", "chat", "ask"],
			["legacy-code", undefined, "auto"],
		] as const) {
			const path = join(directory, `${id}.jsonl`);
			writeRecords(path, [
				{
					type: "session",
					version: 5,
					id,
					timestamp,
					cwd: directory,
					...(mode ? { mode } : {}),
				},
			]);
			const session = SessionManager.open(path, directory);
			expect(session.getPermissionSettings()).toEqual({ mode: expected, reviewerEnabled: true });
			expect(session.getCwdOrigin()).toBe("user-selected");
			session.close();
		}
	});

	it("rejects malformed or version-mismatched control records", () => {
		const baseHeader = { type: "session", id: "invalid", timestamp, cwd: directory };
		const control = {
			type: "session_permissions",
			id: "control-1",
			parentId: null,
			timestamp,
			permissionMode: "auto",
			reviewerEnabled: true,
		};

		const oldPath = join(directory, "old-control.jsonl");
		writeRecords(oldPath, [{ ...baseHeader, version: 5 }, control]);
		expect(() => SessionManager.open(oldPath, directory)).toThrow("require a v6 session header");

		const malformedPath = join(directory, "malformed-control.jsonl");
		writeRecords(malformedPath, [
			{ ...baseHeader, version: 6 },
			{ ...control, reviewerEnabled: "yes" },
		]);
		expect(() => SessionManager.open(malformedPath, directory)).toThrow("Invalid session control entry");

		const unknownPath = join(directory, "unknown-control.jsonl");
		writeRecords(unknownPath, [
			{ ...baseHeader, version: 6 },
			{ ...control, type: "session_permission_magic" },
		]);
		expect(() => SessionManager.open(unknownPath, directory)).toThrow("Unknown session control entry type");
	});

	it("inherits only effective settings when branching and forking", () => {
		const source = SessionManager.create(directory, directory, { mode: "chat", cwdOrigin: "user-selected" });
		const leafId = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		source.setPermissionSettings({ mode: "full", reviewerEnabled: false });
		const sourcePath = source.getSessionFile()!;

		const branch = source.createBranchedSessionManager(leafId);
		expect(branch.getPermissionSettings()).toEqual({ mode: "full", reviewerEnabled: false });
		expect(branch.getCwdOrigin()).toBe("user-selected");
		expect(branch.getDurableJournalSnapshot().some((entry) => entry.type === "session_permissions")).toBe(false);
		branch.close();
		source.close();

		const fork = SessionManager.forkFrom(sourcePath, directory, directory);
		expect(fork.getPermissionSettings()).toEqual({ mode: "full", reviewerEnabled: false });
		expect(fork.getCwdOrigin()).toBe("user-selected");
		expect(fork.getDurableJournalSnapshot().some((entry) => entry.type === "session_permissions")).toBe(false);
		fork.close();
	});

	it("imports the complete settings and decision journal", () => {
		const source = SessionManager.create(directory, directory);
		source.setPermissionSettings({ mode: "ask", reviewerEnabled: false });
		source.appendPermissionDecision({
			actionId: "write-1",
			toolName: "write",
			source: "user",
			decision: "deny",
			reason: "cancelled",
		});
		const sourcePath = source.getSessionFile()!;
		source.close();

		const destination = join(directory, "imported.jsonl");
		const imported = SessionManager.importFrom(sourcePath, destination);
		expect(imported.getPermissionSettings()).toEqual({ mode: "ask", reviewerEnabled: false });
		expect(imported.getDurableJournalSnapshot()).toEqual(
			readFileSync(sourcePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		imported.close();
	});
});
