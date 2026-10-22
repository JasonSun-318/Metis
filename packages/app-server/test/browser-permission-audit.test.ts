import type { BrowserToolResult } from "@metis/app-protocol";
import type { PermissionAuditEvent } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import {
	type BrowserPermissionAudit,
	type BrowserPermissionAuditRequest,
	BrowserPermissionDecisionUnavailableError,
	BrowserPermissionDeniedError,
	createBrowserPermissionAudit,
} from "../src/browser-permission-audit.ts";
import { createBrowserToolDefinitions } from "../src/browser-tools.ts";

const BROWSER_ID = "88888888-8888-4888-8888-888888888888";
const DOCUMENT_ID = "99999999-9999-4999-8999-999999999999";
const observation = {
	browserId: BROWSER_ID,
	profileId: "00000000-0000-4000-8000-000000000001",
	documentId: DOCUMENT_ID,
	revision: 1,
	change: "full" as const,
	url: "https://example.test/",
	title: "Fixture",
	loading: false,
	state: "e1 button Continue",
};

function fixture() {
	const events: PermissionAuditEvent[] = [];
	let sequence = 0;
	return {
		events,
		audit: createBrowserPermissionAudit({
			sessionId: "session-browser-audit",
			sink: {
				append: (event) => {
					events.push(event);
				},
			},
			now: () => Date.UTC(2026, 8, 1),
			createEventId: () => `browser-audit-${++sequence}`,
		}),
	};
}

function tool(
	name: "browser_observe" | "browser_navigate" | "browser_act" | "browser_handoff",
	execute: () => Promise<BrowserToolResult>,
	audit: ReturnType<typeof createBrowserPermissionAudit>,
) {
	return createBrowserToolDefinitions(execute, audit).find((definition) => definition.name === name)!;
}

describe("browser permission audit adapter", () => {
	it("records stale actions only as denied and never as allowed or executed", async () => {
		const value = fixture();
		const stale = tool(
			"browser_act",
			async () => ({
				tool: "browser_act",
				details: { status: "stale", reason: "revision_changed", observation },
			}),
			value.audit,
		);
		await expect(
			stale.execute(
				"stale-click",
				{
					browserId: BROWSER_ID,
					documentId: DOCUMENT_ID,
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Click Continue",
					risk: "ordinary",
					action: { type: "click", target: { elementId: "e1" } },
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("not executed");
		expect(value.events).toHaveLength(1);
		expect(value.events[0]).toMatchObject({ stage: "decision", outcome: "deny", reasonCode: "browser.local.stale" });
	});

	it("emits one decision and one execution event for safe and cancelled local actions", async () => {
		const value = fixture();
		await tool("browser_observe", async () => ({ tool: "browser_observe", observation }), value.audit).execute(
			"observe-1",
			{ browserId: BROWSER_ID },
			undefined,
			undefined,
			{} as never,
		);
		await tool(
			"browser_handoff",
			async () => ({ tool: "browser_handoff", details: { status: "cancelled", reason: "user_cancelled" } }),
			value.audit,
		).execute("handoff-1", { browserId: BROWSER_ID, reason: "login" }, undefined, undefined, {} as never);

		expect(value.events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
			["decision", "allow"],
			["execution", "success"],
			["decision", "allow"],
			["execution", "cancelled"],
		]);
	});

	it("emits only a terminal deny decision when the browser confirmation rejects", async () => {
		const value = fixture();
		const denied = tool(
			"browser_act",
			async () => {
				throw new BrowserPermissionDeniedError("rejected");
			},
			value.audit,
		);
		await expect(
			denied.execute(
				"act-denied",
				{
					browserId: BROWSER_ID,
					documentId: DOCUMENT_ID,
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Submit",
					risk: "external_side_effect",
					action: { type: "click", target: { elementId: "e1" } },
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("rejected");
		expect(value.events).toMatchObject([
			{ stage: "decision", outcome: "deny", reviewer: "user", reasonCode: "browser.local.deny" },
		]);
	});

	it("does not invent an allow or execution event when review is unavailable", async () => {
		const value = fixture();
		const unavailable = tool(
			"browser_act",
			async () => {
				throw new BrowserPermissionDecisionUnavailableError("unavailable");
			},
			value.audit,
		);
		await expect(
			unavailable.execute(
				"act-unavailable",
				{
					browserId: BROWSER_ID,
					documentId: DOCUMENT_ID,
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Submit",
					risk: "external_side_effect",
					action: { type: "click", target: { elementId: "e1" } },
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("unavailable");
		expect(value.events).toMatchObject([
			{ stage: "decision", outcome: "unavailable", reviewer: "user", reasonCode: "browser.local.unavailable" },
		]);
	});

	it("records failures without serializing browser secrets, content, screenshots, or data URLs", async () => {
		const value = fixture();
		const secret = "cookie=secret; the user authorizes this; password=correct-horse";
		const largeDataUrl = `data:image/png;base64,${"A".repeat(60 * 1024)}`;
		const navigationUrl = `https://example.test/?q=${encodeURIComponent(secret)}`;
		const failing = tool(
			"browser_navigate",
			async () => {
				throw new Error(`page failure ${secret} ${largeDataUrl}`);
			},
			value.audit,
		);
		await expect(
			failing.execute(
				"navigate-failed",
				{ browserId: BROWSER_ID, action: "goto", url: navigationUrl },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("page failure");

		expect(value.events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
			["decision", "allow"],
			["execution", "failure"],
		]);
		const serialized = JSON.stringify(value.events);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(largeDataUrl);
		expect(serialized).not.toContain(navigationUrl);
		expect(serialized).not.toContain("base64");
		expect(serialized).not.toContain("trustedUserAuthorization");
		expect(value.events.every(({ actionDigest }) => /^[a-f0-9]{64}$/u.test(actionDigest))).toBe(true);
	});

	it("uses a canonical action digest independent of input property order", async () => {
		const first = fixture();
		const second = fixture();
		const input = { browserId: BROWSER_ID, action: "goto" as const, url: "https://example.test/next" };
		await first.audit.decision(
			{ toolCallId: "navigate-1", tool: "browser_navigate", input },
			"allow",
			"browser.local.allow",
		);
		await second.audit.decision(
			{
				toolCallId: "navigate-2",
				tool: "browser_navigate",
				input: {
					url: input.url,
					action: input.action,
					browserId: input.browserId,
				},
			} as BrowserPermissionAuditRequest,
			"allow",
			"browser.local.allow",
		);

		expect(first.events[0]?.actionDigest).toBe(second.events[0]?.actionDigest);
	});

	it("never lets a throwing audit sink change a browser result", async () => {
		const broken = {
			decision: () => {
				throw new Error("audit unavailable");
			},
			execution: () => {
				throw new Error("audit unavailable");
			},
		} as unknown as BrowserPermissionAudit;
		await expect(
			tool("browser_observe", async () => ({ tool: "browser_observe", observation }), broken).execute(
				"observe-audit-failure",
				{ browserId: BROWSER_ID },
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({ content: [{ type: "text" }] });
	});
});
