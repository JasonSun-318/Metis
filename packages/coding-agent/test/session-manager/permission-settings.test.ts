import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";

const timestamp = "2026-07-17T00:00:00.000Z";

function writeRecords(path: string, records: readonly unknown[]): void {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("SessionManager permission settings", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "metis-permissions-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("defaults both Chat and Code to Auto", () => {
		const chat = SessionManager.inMemory(directory, { mode: "chat" });
		const code = SessionManager.inMemory(directory, { mode: "code" });

		expect(chat.getPermissionSettings()).toEqual({ mode: "auto" });
		expect(code.getPermissionSettings()).toEqual({ mode: "auto" });
		expect(chat.getHeader()).toMatchObject({ version: CURRENT_SESSION_VERSION, permissionMode: "auto" });
		expect(chat.getHeader()).not.toHaveProperty("reviewerEnabled");
		expect(code.getHeader()).not.toHaveProperty("reviewerEnabled");
		chat.close();
		code.close();
	});

	it("loads Auto and ignores reviewerEnabled", () => {
		const path = join(directory, "legacy-auto.jsonl");
		writeRecords(path, [
			{
				type: "session",
				version: 7,
				id: "legacy-auto",
				timestamp,
				cwd: directory,
				mode: "code",
				cwdOrigin: "user-selected",
				permissionMode: "auto",
				reviewerEnabled: true,
			},
			{
				type: "session_permissions",
				id: "permission-1",
				parentId: null,
				timestamp,
				permissionMode: "auto",
				reviewerEnabled: false,
			},
			{
				type: "session_permission_decision",
				id: "decision-1",
				parentId: null,
				timestamp,
				actionId: "legacy-action",
				toolName: "bash",
				source: "reviewer",
				decision: "ask",
				reason: "legacy audit",
			},
		]);

		const session = SessionManager.open(path, directory);
		expect(session.getPermissionSettings()).toEqual({ mode: "auto" });
		expect(session.getDurableJournalSnapshot()).toHaveLength(3);
		session.close();
	});

	it("writes no legacy permission fields and preserves Auto creation input", () => {
		const session = SessionManager.create(directory, directory, { mode: "code", permissionMode: "auto" });
		session.setPermissionSettings({ mode: "full" });
		const records = session.getDurableJournalSnapshot();

		expect(session.getPermissionSettings()).toEqual({ mode: "full" });
		expect(records[0]).toMatchObject({ permissionMode: "auto" });
		expect(records[0]).not.toHaveProperty("reviewerEnabled");
		expect(records.at(-1)).toEqual(expect.objectContaining({ type: "session_permissions", permissionMode: "full" }));
		expect(records.at(-1)).not.toHaveProperty("reviewerEnabled");
		session.close();
	});

	it("reduces permission controls without advancing or exposing the transcript tree", () => {
		const session = SessionManager.inMemory(directory, { mode: "code" });
		const leafId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const controlId = session.setPermissionSettings({ mode: "full" });
		const decisionId = session.appendPermissionDecision({
			actionId: "action-1",
			toolName: "bash",
			source: "user",
			decision: "allow",
			reason: "approved once",
		});

		expect(session.getPermissionSettings()).toEqual({ mode: "full" });
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

	it("notifies permission listeners after persistence and supports unsubscribe", () => {
		const session = SessionManager.inMemory(directory);
		const listener = vi.fn();
		const unsubscribe = session.subscribePermissionSettings(listener);

		session.setPermissionSettings({ mode: "full" });
		expect(listener).toHaveBeenCalledWith({ mode: "full" }, { mode: "auto" });
		unsubscribe();
		session.setPermissionSettings({ mode: "ask" });
		expect(listener).toHaveBeenCalledOnce();
		session.close();
	});

	it("derives Auto for legacy Chat and Code headers", () => {
		for (const [id, mode] of [
			["legacy-chat", "chat"],
			["legacy-code", undefined],
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
			expect(session.getPermissionSettings()).toEqual({ mode: "auto" });
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

		const policyDecision = {
			type: "session_permission_decision",
			id: "policy-1",
			parentId: null,
			timestamp,
			actionId: "write-1",
			toolName: "write",
			source: "policy",
			decision: "deny",
			reason: "outside workspace",
		};
		const oldPolicyPath = join(directory, "old-policy.jsonl");
		writeRecords(oldPolicyPath, [{ ...baseHeader, version: 8 }, policyDecision]);
		expect(() => SessionManager.open(oldPolicyPath, directory)).toThrow("require a v9 session header");

		const currentPolicyPath = join(directory, "current-policy.jsonl");
		writeRecords(currentPolicyPath, [{ ...baseHeader, version: CURRENT_SESSION_VERSION }, policyDecision]);
		const current = SessionManager.open(currentPolicyPath, directory);
		expect(current.getDurableJournalSnapshot().at(-1)).toMatchObject({ source: "policy", decision: "deny" });
		current.close();
	});

	it("inherits only effective settings when branching and forking", () => {
		const source = SessionManager.create(directory, directory, { mode: "chat", cwdOrigin: "user-selected" });
		const leafId = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		source.setPermissionSettings({ mode: "full" });
		const sourcePath = source.getSessionFile()!;

		const branch = source.createBranchedSessionManager(leafId);
		expect(branch.getPermissionSettings()).toEqual({ mode: "full" });
		expect(branch.getDurableJournalSnapshot().some((entry) => entry.type === "session_permissions")).toBe(false);
		branch.close();
		source.close();

		const fork = SessionManager.forkFrom(sourcePath, directory, directory);
		expect(fork.getPermissionSettings()).toEqual({ mode: "full" });
		expect(fork.getDurableJournalSnapshot().some((entry) => entry.type === "session_permissions")).toBe(false);
		fork.close();
	});

	it("imports the complete settings and decision journal", () => {
		const source = SessionManager.create(directory, directory);
		source.setPermissionSettings({ mode: "full" });
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
		expect(imported.getPermissionSettings()).toEqual({ mode: "full" });
		expect(imported.getDurableJournalSnapshot()).toEqual(
			readFileSync(sourcePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		imported.close();
	});
});
