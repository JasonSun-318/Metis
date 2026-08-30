import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	BROWSER_TOOL_NAMES,
	BrowserActParams,
	BrowserNavigateParams,
	BrowserObserveParams,
	BrowserTabsParams,
	createBrowserToolDefinitions,
} from "../src/core/browser-tools.ts";

const BROWSER_ID = "88888888-8888-4888-8888-888888888888";
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "99999999-9999-4999-8999-999999999999";
const observation = {
	browserId: BROWSER_ID,
	profileId: PROFILE_ID,
	documentId: DOCUMENT_ID,
	revision: 1,
	change: "full" as const,
	url: "https://example.test/",
	title: "Fixture",
	loading: false,
	state: "document WebArea Fixture\n  e1 button Continue",
};

describe("browser host tools", () => {
	it("exposes exactly five sequential tools with safety guidance", () => {
		const tools = createBrowserToolDefinitions(async () => ({
			tool: "browser_tabs",
			details: { profiles: [], tabs: [] },
		}));
		expect(tools.map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
		expect(tools.every(({ executionMode }) => executionMode === "sequential")).toBe(true);
		const guidance = tools.flatMap(({ promptGuidelines = [] }) => promptGuidelines).join("\n");
		expect(guidance).toContain("untrusted");
		expect(guidance).toContain("documentId");
		expect(guidance).toContain("risk");
		expect(guidance).toContain("browser_handoff");
		expect(guidance).toContain("CAPTCHA");
	});

	it("uses exact bounded argument schemas", () => {
		expect(Value.Check(BrowserTabsParams, { action: "list" })).toBe(true);
		expect(Value.Check(BrowserTabsParams, { action: "list", extra: true })).toBe(false);
		expect(Value.Check(BrowserNavigateParams, { browserId: BROWSER_ID, action: "reload" })).toBe(true);
		expect(Value.Check(BrowserObserveParams, { browserId: BROWSER_ID, sinceRevision: -1 })).toBe(false);
		expect(
			Value.Check(BrowserActParams, {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Click Continue",
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			}),
		).toBe(true);
		expect(
			Value.Check(BrowserActParams, {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Click Continue",
				targetLabel: "Untrusted model label",
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			}),
		).toBe(false);
		expect(
			Value.Check(BrowserActParams, {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test/path",
				intent: "Click Continue",
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			}),
		).toBe(false);
		expect(
			Value.Check(BrowserActParams, {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "x".repeat(1025),
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			}),
		).toBe(false);
	});

	it("forwards toolCallId and signal and formats observations", async () => {
		const executor = vi.fn(async () => ({ tool: "browser_observe" as const, observation }));
		const tool = createBrowserToolDefinitions(executor).find(({ name }) => name === "browser_observe")!;
		const controller = new AbortController();
		const result = await tool.execute(
			"tool-call-1",
			{ browserId: BROWSER_ID, mode: "state" },
			controller.signal,
			undefined,
			{} as never,
		);
		expect(executor).toHaveBeenCalledWith({
			toolCallId: "tool-call-1",
			tool: "browser_observe",
			input: { browserId: BROWSER_ID, mode: "state" },
			signal: controller.signal,
		});
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(observation) }]);
	});

	it("returns screenshots as image content without duplicating base64 in text", async () => {
		const data = "dGlueS1qcGVn";
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_observe",
			observation: { ...observation, screenshot: { mediaType: "image/jpeg", data } },
		})).find(({ name }) => name === "browser_observe")!;
		const result = await tool.execute(
			"tool-call-2",
			{ browserId: BROWSER_ID, mode: "both" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toHaveLength(2);
		expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(observation) });
		expect(result.content[1]).toEqual({ type: "image", data, mimeType: "image/jpeg" });
		expect(JSON.stringify(result.content[0])).not.toContain(data);
	});

	it("returns stale action state explicitly without duplicating screenshots", async () => {
		const data = "c3RhbGUtanBlZw==";
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_act",
			details: {
				status: "stale",
				reason: "revision_changed",
				observation: { ...observation, revision: 2, screenshot: { mediaType: "image/jpeg", data } },
			},
		})).find(({ name }) => name === "browser_act")!;
		const result = await tool.execute(
			"tool-call-stale",
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
		);
		expect(result.content[0]).toEqual({
			type: "text",
			text: JSON.stringify({
				status: "stale",
				reason: "revision_changed",
				observation: { ...observation, revision: 2 },
			}),
		});
		expect(result.content[1]).toEqual({ type: "image", data, mimeType: "image/jpeg" });
		expect(JSON.stringify(result.content[0])).not.toContain(data);
	});

	it("returns tab closure as a normal browser tool result", async () => {
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_act",
			details: { status: "cancelled", reason: "tab_closed" },
		})).find(({ name }) => name === "browser_act")!;
		const result = await tool.execute(
			"tool-call-closed",
			{
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Authorize and close the popup",
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: "Browser control cancelled: tab_closed" }]);
	});

	it("rejects a result for a different browser tool", async () => {
		const tool = createBrowserToolDefinitions(async () => ({ tool: "browser_tabs", details: {} })).find(
			({ name }) => name === "browser_observe",
		)!;
		await expect(
			tool.execute("tool-call-3", { browserId: BROWSER_ID }, undefined, undefined, {} as never),
		).rejects.toThrow("mismatched");
	});
});
