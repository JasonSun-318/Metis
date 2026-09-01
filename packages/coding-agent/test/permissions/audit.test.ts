import { describe, expect, it, vi } from "vitest";
import {
	createPermissionAuditEvent,
	type PermissionAuditEvent,
	PermissionAuditWriter,
} from "../../src/core/permissions/index.ts";
import { auditInputWithSecrets } from "./runtime-fixtures.ts";

describe("permission audit", () => {
	it("keeps only bounded digest and reason-code fields", () => {
		const event = createPermissionAuditEvent(auditInputWithSecrets());
		const serialized = JSON.stringify(event);

		expect(Object.isFrozen(event)).toBe(true);
		expect(serialized).not.toMatch(/secret-value|base64|reviewer prompt/i);
		expect(event).toEqual({
			eventId: "event-1",
			sessionId: "session-1",
			actionId: "action-1",
			actionDigest: "a".repeat(64),
			toolName: "write_file",
			provenance: "builtin",
			riskLevel: "medium",
			stage: "decision",
			outcome: "allow",
			executionTarget: "sandbox",
			reasonCode: "policy.allow",
			timestamp: "2026-09-01T00:00:00.000Z",
		});
	});

	it("rejects free-form, oversized, or invalid audit fields", () => {
		expect(() => createPermissionAuditEvent({ ...auditInputWithSecrets(), reasonCode: "secret value" })).toThrow(
			"reasonCode",
		);
		expect(() => createPermissionAuditEvent({ ...auditInputWithSecrets(), toolName: "x".repeat(257) })).toThrow(
			"toolName",
		);
		expect(() => createPermissionAuditEvent({ ...auditInputWithSecrets(), actionDigest: "forged" })).toThrow(
			"actionDigest",
		);
		expect(() => createPermissionAuditEvent({ ...auditInputWithSecrets(), timestamp: "tomorrow" })).toThrow(
			"timestamp",
		);
		expect(() => createPermissionAuditEvent({ ...auditInputWithSecrets(), eventId: "界".repeat(100) })).toThrow(
			"eventId",
		);
	});

	it("appends immutable events and reports sink failure without throwing", async () => {
		const appended: PermissionAuditEvent[] = [];
		const failure = vi.fn();
		const working = new PermissionAuditWriter(
			{
				append: (event) => {
					appended.push(event);
				},
			},
			failure,
		);
		const event = createPermissionAuditEvent(auditInputWithSecrets());

		expect(await working.append(event)).toBe(true);
		expect(appended).toEqual([event]);
		expect(failure).not.toHaveBeenCalled();

		const broken = new PermissionAuditWriter(
			{
				append: () => {
					throw new Error("sink leaked secret-value");
				},
			},
			failure,
		);
		expect(await broken.append(event)).toBe(false);
		expect(failure).toHaveBeenCalledWith({ eventId: "event-1", stage: "decision" });
		expect(JSON.stringify(failure.mock.calls)).not.toContain("secret-value");
	});
});
