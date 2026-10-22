import { describe, expect, it, vi } from "vitest";
import { BROWSER_TOOL_NAMES, createBrowserToolDefinitions } from "../src/browser-tools.ts";

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
	it("publishes object function parameters without root combinators", () => {
		const tools = createBrowserToolDefinitions(async () => ({
			tool: "browser_tabs",
			details: { profiles: [], tabs: [] },
		}));
		const schemas = JSON.parse(JSON.stringify(tools.map(({ name, parameters }) => ({ name, parameters }))));
		expect(schemas.map(({ parameters }: { parameters: { type?: string } }) => parameters.type)).toEqual(
			BROWSER_TOOL_NAMES.map(() => "object"),
		);
		for (const { parameters } of schemas) {
			expect(parameters.anyOf).toBeUndefined();
			expect(parameters.allOf).toBeUndefined();
			expect(parameters.properties).toBeDefined();
		}
		expect(Object.keys(schemas[0].parameters.properties).sort()).toEqual(["action", "browserId", "profileId"]);
		expect(Object.keys(schemas[1].parameters.properties).sort()).toEqual(["action", "browserId", "url"]);
	});

	it.each([
		["browser_tabs", { action: "close" }],
		["browser_tabs", { action: "list", browserId: BROWSER_ID }],
		["browser_tabs", { action: "open", browserId: BROWSER_ID }],
		["browser_navigate", { browserId: BROWSER_ID, action: "goto" }],
		["browser_navigate", { browserId: BROWSER_ID, action: "back", url: "https://example.test" }],
		["browser_navigate", { browserId: BROWSER_ID, action: "goto", url: "data:text/html,secret" }],
		["browser_navigate", { browserId: BROWSER_ID, action: "goto", url: "https://user:password@example.test" }],
	] as const)("rejects invalid %s action arguments before host execution", async (name, input) => {
		const executor = vi.fn().mockResolvedValue({ tool: "browser_tabs", details: { profiles: [], tabs: [] } });
		const tool = createBrowserToolDefinitions(executor).find((tool) => tool.name === name)!;
		await expect(tool.execute("invalid-action", input, undefined, undefined, {} as never)).rejects.toThrow(
			`Invalid ${name} arguments`,
		);
		expect(executor).not.toHaveBeenCalled();
	});

	it("tells the model how to recover an expired task-owned browser tab", async () => {
		const executor = vi.fn().mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }));
		const tool = createBrowserToolDefinitions(executor).find(({ name }) => name === "browser_observe")!;
		await expect(
			tool.execute("expired-tab", { browserId: BROWSER_ID }, undefined, undefined, {} as never),
		).rejects.toThrow('browser_tabs with {"action":"list"}');
		expect(executor).toHaveBeenCalledOnce();
	});

	it("keeps unrelated executor errors unchanged", async () => {
		const failure = Object.assign(new Error("OPERATION_FAILED"), { code: "OPERATION_FAILED" });
		const tool = createBrowserToolDefinitions(vi.fn().mockRejectedValue(failure)).find(
			({ name }) => name === "browser_observe",
		)!;
		await expect(
			tool.execute("failed-observe", { browserId: BROWSER_ID }, undefined, undefined, {} as never),
		).rejects.toBe(failure);
	});

	it("exposes exactly five sequential tools with safety guidance", () => {
		const tools = createBrowserToolDefinitions(async () => ({
			tool: "browser_tabs",
			details: { profiles: [], tabs: [] },
		}));
		expect(tools.map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
		expect(tools.every(({ executionMode }) => executionMode === "sequential")).toBe(true);
		expect(tools.every(({ permission }) => permission.version === 1)).toBe(true);
		const guidance = tools.flatMap(({ promptGuidelines = [] }) => promptGuidelines).join("\n");
		expect(guidance).toContain("untrusted");
		expect(guidance).toContain("documentId");
		expect(guidance).toContain("risk");
		expect(guidance).toContain("browser_handoff");
		expect(guidance).toContain("CAPTCHA");
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

	it("rejects stale actions as unexecuted errors with fresh state and no screenshot bytes", async () => {
		const data = "c3RhbGUtanBlZw==";
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_act",
			details: {
				status: "stale",
				reason: "revision_changed",
				observation: { ...observation, revision: 2, screenshot: { mediaType: "image/jpeg", data } },
			},
		})).find(({ name }) => name === "browser_act")!;
		const failure = await tool
			.execute(
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
			)
			.then(
				() => {
					throw new Error("Stale browser action was reported as success");
				},
				(cause: Error) => cause,
			);
		const details = JSON.parse(failure.message);
		expect(details).toMatchObject({
			status: "stale",
			reason: "revision_changed",
			observation: { ...observation, revision: 2 },
		});
		expect(details.message).toContain("not executed");
		expect(details.message).toContain("browser_observe");
		expect(failure.message).not.toContain(data);
	});

	it("returns only user takeover cancellation as a normal browser tool result", async () => {
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_act",
			details: { status: "cancelled", reason: "user_cancelled" },
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
		expect(result.content).toEqual([{ type: "text", text: "Browser control cancelled: user_cancelled" }]);
	});

	it("rejects a result for a different browser tool", async () => {
		const tool = createBrowserToolDefinitions(async () => ({
			tool: "browser_tabs",
			details: { profiles: [], tabs: [] },
		})).find(({ name }) => name === "browser_observe")!;
		await expect(
			tool.execute("tool-call-3", { browserId: BROWSER_ID }, undefined, undefined, {} as never),
		).rejects.toThrow("mismatched");
	});
});
