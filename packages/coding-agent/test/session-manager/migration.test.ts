import { describe, expect, it } from "vitest";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
} from "../../src/core/session-manager.ts";

describe("migrateSessionEntries", () => {
	it("keeps compatibility parsing tolerant of blank and malformed lines", () => {
		const header = { type: "session", id: "session-1" };
		const message = { type: "message", id: "message-1" };
		expect(parseSessionEntries(`${JSON.stringify(header)}\n\n{malformed}\n${JSON.stringify(message)}\n`)).toEqual([
			header,
			message,
		]);
	});

	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have the current version after all migrations.
		expect((entries[0] as any).version).toBe(CURRENT_SESSION_VERSION);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});

	it("migrates v11 headers to v12", () => {
		const entries: FileEntry[] = [
			{
				type: "session",
				id: "sess-v11",
				version: 11,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
		];
		migrateSessionEntries(entries);
		expect((entries[0] as { version: number }).version).toBe(CURRENT_SESSION_VERSION);
	});

	it("rejects plan controls under pre-v12 headers", () => {
		const entries: FileEntry[] = [
			{
				type: "session",
				id: "sess-v11",
				version: 11,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
			},
			{
				type: "session_plan_proposal",
				id: "plan-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				planId: "plan-a",
				revision: 1,
				title: "Plan",
				markdown: "# Plan",
			},
		] as FileEntry[];
		expect(() => migrateSessionEntries(entries)).toThrow(/v12 session header/iu);
	});

	it("converts v13 permissionMode journals to current preset records", () => {
		const entries: FileEntry[] = [
			{
				type: "session",
				version: 13,
				id: "sess-v13",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: "/tmp",
				permissionMode: "ask",
				reviewerEnabled: true,
			} as FileEntry,
			{
				type: "session_permissions",
				id: "permission-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				permissionMode: "full",
				reviewerEnabled: false,
			} as unknown as FileEntry,
			{
				type: "session_permission_decision",
				id: "decision-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:02Z",
				actionId: "action-1",
				toolName: "bash",
				source: "user",
				decision: "allow",
				reason: "approved once",
			} as unknown as FileEntry,
		];

		migrateSessionEntries(entries);

		expect(entries).toMatchObject([
			{ type: "session", version: CURRENT_SESSION_VERSION, permissionPreset: "ask" },
			{ type: "session_permission_preset", permissionPreset: "full" },
			{ type: "session_permission_audit", decision: "allow" },
		]);
		expect(entries[0]).not.toHaveProperty("permissionMode");
		expect(entries[0]).not.toHaveProperty("reviewerEnabled");
		expect(entries[1]).not.toHaveProperty("permissionMode");
		expect(entries[1]).not.toHaveProperty("reviewerEnabled");
	});
});
