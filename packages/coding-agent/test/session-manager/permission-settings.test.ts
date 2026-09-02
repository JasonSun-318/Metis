import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION_PRESETS } from "../../src/core/permissions/index.ts";
import { CorruptSessionError } from "../../src/core/session-journal.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../src/core/session-manager.ts";
import { createPermissionSession, readSessionJson, restartSession } from "../permissions/session-fixtures.ts";

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

		expect(chat.getPermissionPreset()).toBe("auto");
		expect(code.getPermissionPreset()).toBe("auto");
		expect(chat.getPermissionSettings()).toEqual(PERMISSION_PRESETS.auto);
		expect(chat.getHeader()).toMatchObject({ version: CURRENT_SESSION_VERSION, permissionPreset: "auto" });
		chat.close();
		code.close();
	});

	it("persists only permissionPreset and reconstructs effective axes on restart", async () => {
		const { session, sessionManager, file } = await createPermissionSession("ask");
		await session.setPermissionPreset("auto");
		const persisted = readSessionJson(file);
		expect(sessionManager.getPermissionPreset()).toBe("auto");
		expect(persisted).toMatchObject({ permissionPreset: "ask" });
		expect(sessionManager.getDurableJournalSnapshot().at(-1)).toMatchObject({ permissionPreset: "auto" });
		expect((await restartSession(file)).permissionView.effectiveSettings).toEqual(PERMISSION_PRESETS.auto);
	});

	it("writes only the preset contract and preserves Auto creation input", () => {
		const session = SessionManager.create(directory, directory, { mode: "code", permissionPreset: "auto" });
		session.setPermissionPreset("full");
		const records = session.getDurableJournalSnapshot();

		expect(session.getPermissionPreset()).toBe("full");
		expect(records[0]).toMatchObject({ permissionPreset: "auto" });
		expect(records.at(-1)).toEqual(
			expect.objectContaining({ type: "session_permission_preset", permissionPreset: "full" }),
		);
		session.close();
	});

	it("reduces permission controls without advancing or exposing the transcript tree", () => {
		const session = SessionManager.inMemory(directory, { mode: "code" });
		const leafId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const controlId = session.setPermissionPreset("full");
		const decisionId = session.appendPermissionAuditRecord({
			actionId: "action-1",
			toolName: "bash",
			source: "user",
			decision: "allow",
			reason: "approved once",
		});

		expect(session.getPermissionPreset()).toBe("full");
		expect(session.getLeafId()).toBe(leafId);
		expect(session.getEntries().map((entry) => entry.id)).toEqual([leafId]);
		expect(session.getEntry(controlId)).toBeUndefined();
		expect(session.getEntry(decisionId)).toBeUndefined();
		expect(session.getTree()).toHaveLength(1);
		expect(session.getDurableJournalSnapshot().slice(2)).toMatchObject([
			{ type: "session_permission_preset", id: controlId, parentId: leafId },
			{ type: "session_permission_audit", id: decisionId, parentId: leafId },
		]);
		session.close();
	});

	it("notifies permission listeners after persistence and supports unsubscribe", () => {
		const session = SessionManager.inMemory(directory);
		const listener = vi.fn();
		const unsubscribe = session.subscribePermissionPreset(listener);

		session.setPermissionPreset("full");
		expect(listener).toHaveBeenCalledWith("full", "auto");
		unsubscribe();
		session.setPermissionPreset("ask");
		expect(listener).toHaveBeenCalledOnce();
		session.close();
	});

	it("derives Auto when older session formats have no permission field", () => {
		for (const [id, mode] of [
			["older-chat", "chat"],
			["older-code", undefined],
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
			expect(session.getPermissionPreset()).toBe("auto");
			expect(session.getHeader()).toMatchObject({ permissionPreset: "auto" });
			session.close();
		}
	});

	it("opens and atomically rewrites a v13 permission journal as v14", () => {
		const path = join(directory, "legacy-permissions.jsonl");
		writeRecords(path, [
			{
				type: "session",
				version: 13,
				id: "legacy-permissions",
				timestamp,
				cwd: directory,
				mode: "code",
				permissionMode: "ask",
				reviewerEnabled: true,
			},
			{
				type: "session_permissions",
				id: "permission-1",
				parentId: null,
				timestamp,
				permissionMode: "full",
				reviewerEnabled: false,
			},
			{
				type: "session_permission_decision",
				id: "decision-1",
				parentId: null,
				timestamp,
				actionId: "action-1",
				toolName: "bash",
				source: "user",
				decision: "allow",
				reason: "approved once",
			},
		]);

		const session = SessionManager.open(path, directory);
		expect(session.getPermissionPreset()).toBe("full");
		expect(session.getDurableJournalSnapshot()).toMatchObject([
			{ type: "session", version: CURRENT_SESSION_VERSION, permissionPreset: "ask" },
			{ type: "session_permission_preset", permissionPreset: "full" },
			{ type: "session_permission_audit", decision: "allow" },
		]);
		session.close();

		const persisted = readFileSync(path, "utf8");
		expect(persisted).not.toContain("permissionMode");
		expect(persisted).not.toContain("reviewerEnabled");
		expect(persisted).not.toContain("session_permission_decision");
	});

	it("exposes a migrated v13 preset from openReadOnly without rewriting the source", () => {
		const path = join(directory, "legacy-readonly.jsonl");
		writeRecords(path, [
			{
				type: "session",
				version: 13,
				id: "legacy-readonly",
				timestamp,
				cwd: directory,
				mode: "code",
				permissionMode: "ask",
				reviewerEnabled: false,
			},
		]);
		const original = readFileSync(path, "utf8");

		const session = SessionManager.openReadOnly(path);
		expect(session.getPermissionPreset()).toBe("ask");
		expect(session.getHeader()).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			permissionPreset: "ask",
		});
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it.each([
		{
			name: "invalid permissionMode",
			header: { permissionMode: "everything" },
			message: "Legacy permission mode is invalid",
		},
		{
			name: "non-boolean reviewerEnabled",
			header: { permissionMode: "ask", reviewerEnabled: "yes" },
			message: "Legacy reviewer setting is invalid",
		},
		{
			name: "conflicting permissionMode and permissionPreset",
			header: { permissionMode: "ask", permissionPreset: "full" },
			message: "Legacy and current permission settings conflict",
		},
	])("rejects $name without rewriting the source", ({ header, message }) => {
		const path = join(directory, "legacy-invalid.jsonl");
		writeRecords(path, [
			{
				type: "session",
				version: 13,
				id: "legacy-invalid",
				timestamp,
				cwd: directory,
				mode: "code",
				...header,
			},
		]);
		const original = readFileSync(path, "utf8");
		expect(() => SessionManager.open(path, directory)).toThrow(CorruptSessionError);
		expect(() => SessionManager.open(path, directory)).toThrow(message);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("rejects malformed or version-mismatched control records", () => {
		const baseHeader = { type: "session", id: "invalid", timestamp, cwd: directory };
		const control = {
			type: "session_permission_preset",
			id: "control-1",
			parentId: null,
			timestamp,
			permissionPreset: "auto",
		};

		const oldPath = join(directory, "old-control.jsonl");
		writeRecords(oldPath, [{ ...baseHeader, version: 5 }, control]);
		expect(() => SessionManager.open(oldPath, directory)).toThrow("require a v14 session header");

		const malformedPath = join(directory, "malformed-control.jsonl");
		writeRecords(malformedPath, [
			{ ...baseHeader, version: CURRENT_SESSION_VERSION, permissionPreset: "auto" },
			{ ...control, extra: "unsupported" },
		]);
		expect(() => SessionManager.open(malformedPath, directory)).toThrow("Invalid session control entry");

		const policyDecision = {
			type: "session_permission_audit",
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
		expect(() => SessionManager.open(oldPolicyPath, directory)).toThrow("require a v14 session header");

		const currentPolicyPath = join(directory, "current-policy.jsonl");
		writeRecords(currentPolicyPath, [
			{ ...baseHeader, version: CURRENT_SESSION_VERSION, permissionPreset: "auto" },
			policyDecision,
		]);
		const current = SessionManager.open(currentPolicyPath, directory);
		expect(current.getDurableJournalSnapshot().at(-1)).toMatchObject({ source: "policy", decision: "deny" });
		current.close();
	});

	it("inherits only the effective preset when branching and forking", () => {
		const source = SessionManager.create(directory, directory, { mode: "chat", cwdOrigin: "user-selected" });
		const leafId = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		source.setPermissionPreset("full");
		const sourcePath = source.getSessionFile()!;

		const branch = source.createBranchedSessionManager(leafId);
		expect(branch.getPermissionPreset()).toBe("full");
		expect(branch.getDurableJournalSnapshot().some((entry) => entry.type === "session_permission_preset")).toBe(
			false,
		);
		branch.close();
		source.close();

		const fork = SessionManager.forkFrom(sourcePath, directory, directory);
		expect(fork.getPermissionPreset()).toBe("full");
		expect(fork.getDurableJournalSnapshot().some((entry) => entry.type === "session_permission_preset")).toBe(false);
		fork.close();
	});

	it("imports the complete settings and decision journal", () => {
		const source = SessionManager.create(directory, directory);
		source.setPermissionPreset("full");
		source.appendPermissionAuditRecord({
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
		expect(imported.getPermissionPreset()).toBe("full");
		expect(imported.getDurableJournalSnapshot()).toEqual(
			readFileSync(sourcePath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		);
		imported.close();
	});
});
