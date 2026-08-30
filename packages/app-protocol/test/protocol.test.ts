import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertEnvelopeByteLimit,
	browserActionElementIds,
	ClientRequestMethods,
	createRpcError,
	findBrowserStateElement,
	formatBrowserStateNode,
	HostRequestMethods,
	MAX_BROWSER_ACTION_TEXT_UTF8_BYTES,
	MAX_BROWSER_SCREENSHOT_UTF8_BYTES,
	MAX_BROWSER_STATE_UTF8_BYTES,
	MAX_DELTA_UTF8_BYTES,
	MAX_ENVELOPE_UTF8_BYTES,
	MAX_EVENT_BATCH,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PATH_UTF8_BYTES,
	MAX_PROMPT_UTF8_BYTES,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
	MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES,
	ProtocolValidationError,
	parseRawEnvelope,
	RPC_ERROR_CODES,
	ServerNotificationMethods,
	ServerRequestMethods,
	validateClientRequest,
	validateHostRequest,
	validateResponseFor,
	validateServerNotification,
	validateServerRequest,
	validateUncorrelatedErrorResponse,
} from "../src/index.ts";

const fixturesDir = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const EPOCH = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const BROWSER_ID = "88888888-8888-4888-8888-888888888888";
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "99999999-9999-4999-8999-999999999999";

interface RequestFixture {
	direction: "client" | "host";
	method: string;
	envelope: Record<string, unknown>;
}

interface ResponseFixture {
	direction: "client" | "host";
	method: string;
	envelope: Record<string, unknown>;
}

interface ServerRequestFixture {
	method: "interaction/request" | "browser/tool";
	kind: string;
	request: Record<string, unknown>;
	response: Record<string, unknown>;
	cancelResponse?: Record<string, unknown>;
}

interface NotificationFixture {
	method: "connection/events" | "browser/tool/cancelled";
	envelope: Record<string, unknown>;
}

interface ErrorFixture {
	name: keyof typeof RPC_ERROR_CODES;
	envelope: Record<string, unknown>;
}

function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf8")) as T;
}

const requests = fixture<RequestFixture[]>("requests.json");
const responses = fixture<ResponseFixture[]>("responses.json");
const serverRequests = fixture<ServerRequestFixture[]>("server-requests.json");
const notifications = fixture<NotificationFixture[]>("notifications.json");
const errors = fixture<ErrorFixture[]>("errors.json");

function requestFor(direction: "client" | "host", method: string): RequestFixture {
	const found = requests.find((entry) => entry.direction === direction && entry.method === method);
	if (!found) throw new Error(`Missing request fixture for ${direction}:${method}`);
	return found;
}

function makeClientRequest(method: string, params: Record<string, unknown>): Record<string, unknown> {
	return { jsonrpc: "2.0", id: "limit-test", method, params };
}

function makeServerInteraction(interaction: Record<string, unknown>): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id: "server-limit",
		method: "interaction/request",
		params: { serverEpoch: EPOCH, interaction },
	};
}

function makeBrowserTool(call: Record<string, unknown>, id = "browser-call"): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id,
		method: "browser/tool",
		params: { serverEpoch: EPOCH, sessionId: SESSION_ID, toolCallId: `${id}:tool`, call },
	};
}

const browserObservation = {
	browserId: BROWSER_ID,
	profileId: PROFILE_ID,
	documentId: DOCUMENT_ID,
	revision: 1,
	change: "full",
	url: "https://example.test/",
	title: "Example",
	loading: false,
	state: "document WebArea Example\n  e1 button Continue",
} as const;

const scheduleTask = {
	id: TASK_ID,
	name: "生成日报",
	description: "工作日早间摘要",
	instruction: "生成日报",
	model: { provider: "openai", modelId: "gpt-test" },
	schedule: { kind: "daily", time: "09:00" },
	timezone: "Asia/Shanghai",
	target: { kind: "general", workspace: "fixed", cwd: "/tmp/metis-project" },
	status: "active",
	createdAt: "2026-07-26T00:00:00.000Z",
	updatedAt: "2026-07-26T00:00:00.000Z",
	nextRunAt: "2026-07-27T01:00:00.000Z",
	unreadCount: 0,
} as const;

const scheduleRun = {
	id: RUN_ID,
	taskId: TASK_ID,
	trigger: "manual",
	status: "succeeded",
	scheduledFor: "2026-07-26T00:00:00.000Z",
	createdAt: "2026-07-26T00:00:00.000Z",
	completedAt: "2026-07-26T00:01:00.000Z",
	sessionId: "scheduled-session",
	resultPreview: "日报已生成",
	unread: true,
	snapshot: {
		name: "生成日报",
		description: "工作日早间摘要",
		instruction: "生成日报",
		model: { provider: "openai", modelId: "gpt-test" },
		schedule: { kind: "daily", time: "09:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "fixed", cwd: "/tmp/metis-project" },
	},
} as const;

const scheduleRunSummary = {
	id: scheduleRun.id,
	taskId: scheduleRun.taskId,
	status: scheduleRun.status,
	scheduledFor: scheduleRun.scheduledFor,
	createdAt: scheduleRun.createdAt,
	completedAt: scheduleRun.completedAt,
	sessionId: scheduleRun.sessionId,
	resultPreview: scheduleRun.resultPreview,
	unread: scheduleRun.unread,
} as const;

const scheduleCases = [
	["model/list", {}, { models: [{ provider: "openai", modelId: "gpt-test", name: "GPT Test" }] }],
	[
		"model/settings/get",
		{},
		{
			defaultModel: { provider: "openai", modelId: "gpt-test" },
			vision: null,
			embedding: null,
			rerank: null,
			defaultThinkingSelection: "high",
			providers: [
				{
					provider: "openai",
					name: "OpenAI",
					builtin: true,
					baseUrl: null,
					api: null,
					auth: { configured: true, source: "stored", label: "Saved API key" },
					models: [
						{
							provider: "openai",
							modelId: "gpt-test",
							name: "GPT Test",
							contextWindow: 200_000,
							maxOutputTokens: 32_000,
							reasoning: true,
							imageInput: true,
							custom: false,
						},
					],
				},
			],
			loadError: null,
		},
	],
	[
		"model/settings/update",
		{
			requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			mutation: {
				type: "set_defaults",
				model: { provider: "openai", modelId: "gpt-test" },
				thinkingSelection: "high",
			},
		},
		{
			defaultModel: { provider: "openai", modelId: "gpt-test" },
			vision: {
				name: "My vision",
				baseUrl: "https://api.openai.com/v1",
				api: "openai-responses",
				modelId: "gpt-4o",
				authConfigured: true,
			},
			embedding: null,
			rerank: null,
			defaultThinkingSelection: "high",
			providers: [],
			loadError: null,
		},
	],
	[
		"model/settings/update",
		{
			requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			mutation: {
				type: "set_vision",
				settings: null,
				credential: { action: "remove" },
			},
		},
		{
			defaultModel: { provider: "openai", modelId: "gpt-test" },
			vision: null,
			embedding: null,
			rerank: null,
			defaultThinkingSelection: "high",
			providers: [],
			loadError: null,
		},
	],
	[
		"model/testConnection",
		{ requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", kind: "chat", provider: "openai", modelId: "gpt-test" },
		{ ok: true, message: "Connection succeeded", latencyMs: 42 },
	],
	[
		"model/testConnection",
		{
			requestId: "abababab-abab-4bab-8bab-abababababab",
			kind: "embedding",
			settings: {
				name: "Qwen Embedding",
				provider: "Qwen",
				baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
				api: "openai-compatible",
				modelId: "text-embedding-v4",
			},
			credential: { action: "set", value: "one-shot" },
		},
		{ ok: true, message: "Connection succeeded", latencyMs: 42 },
	],
	[
		"usage/get",
		{ rangeDays: 7 },
		{
			generatedAt: "2026-08-08T00:00:00.000Z",
			rangeDays: 7,
			totalTokens: 12,
			inputTokens: 7,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			chatTokens: 5,
			codeTokens: 7,
			sessionCount: 2,
			chatSessionCount: 1,
			codeSessionCount: 1,
			daily: Array.from({ length: 7 }, (_, index) => ({
				date: `2026-08-0${index + 2}`,
				chatTokens: index === 6 ? 5 : 0,
				codeTokens: index === 6 ? 7 : 0,
				inputTokens: index === 6 ? 7 : 0,
				outputTokens: index === 6 ? 5 : 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			})),
			topModels: [{ provider: "openai", modelId: "gpt-test", totalTokens: 12 }],
		},
	],
	["webSearch/get", {}, { enabled: false, provider: "brave", authConfigured: false }],
	["webSearch/credential/reveal", { provider: "brave" }, { credential: "brave-key" }],
	[
		"webSearch/update",
		{ enabled: true, provider: "serpapi", credential: { action: "set", value: "serp-key" } },
		{ enabled: true, provider: "serpapi", authConfigured: true, authSource: "stored" },
	],
	[
		"memory/get",
		{},
		{
			autoMemoryEnabled: true,
			memoryEngine: "index",
			embeddingConfigured: false,
			rerankConfigured: false,
			lastError: null,
			memoryMigrationNotice: null,
		},
	],
	[
		"memory/update",
		{
			autoMemoryEnabled: true,
			memoryEngine: "extract",
		},
		{
			autoMemoryEnabled: true,
			memoryEngine: "extract",
			embeddingConfigured: true,
			rerankConfigured: false,
			lastError: null,
			memoryMigrationNotice: null,
		},
	],
	[
		"hooks/list",
		{},
		{
			hooks: [
				{
					id: "11111111-2222-4333-8444-555555555555",
					name: "Block dangerous bash",
					enabled: true,
					event: "PreToolUse",
					matcher: "bash",
					runMode: "shell",
					command: "echo blocked >&2; exit 2",
					timeoutSeconds: 30,
				},
			],
			loadErrors: [],
		},
	],
	[
		"hooks/upsert",
		{
			hook: {
				id: "11111111-2222-4333-8444-555555555555",
				name: "Block dangerous bash",
				enabled: true,
				event: "PreToolUse",
				matcher: "bash",
				runMode: "shell",
				command: "echo blocked >&2; exit 2",
				timeoutSeconds: 30,
			},
		},
		{ hooks: [], loadErrors: [] },
	],
	["hooks/delete", { id: "11111111-2222-4333-8444-555555555555" }, { hooks: [], loadErrors: [] }],
	[
		"schedule/create",
		{
			requestId: TASK_ID,
			sourceSessionId: SESSION_ID,
			name: "生成日报",
			description: "工作日早间摘要",
			instruction: "生成日报",
			model: { provider: "openai", modelId: "gpt-test" },
			schedule: { kind: "daily", time: "09:00" },
		},
		{ task: scheduleTask },
	],
	[
		"schedule/list",
		{ afterTaskId: null, limit: 20, unreadOnly: false },
		{ tasks: [scheduleTask], nextAfterTaskId: null, unreadCount: 0 },
	],
	["schedule/get", { taskId: TASK_ID }, { task: scheduleTask }],
	[
		"schedule/update",
		{ requestId: "88888888-8888-4888-8888-888888888888", taskId: TASK_ID, name: "生成项目日报" },
		{ task: scheduleTask },
	],
	["schedule/pause", { requestId: "99999999-9999-4999-8999-999999999999", taskId: TASK_ID }, { task: scheduleTask }],
	["schedule/resume", { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskId: TASK_ID }, { task: scheduleTask }],
	[
		"schedule/delete",
		{ requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", taskId: TASK_ID, deleteSessions: false },
		{ taskId: TASK_ID, deleted: true, deletedSessionCount: 0, retainedSessionCount: 1 },
	],
	["schedule/run-now", { requestId: RUN_ID, taskId: TASK_ID }, { run: scheduleRun }],
	[
		"schedule/run/list",
		{ taskId: TASK_ID, beforeRunId: null, limit: 20 },
		{ runs: [scheduleRun], nextBeforeRunId: null },
	],
	["schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }, { run: scheduleRun }],
	[
		"schedule/run/mark-read",
		{ requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", taskId: TASK_ID, runId: RUN_ID },
		{ run: { ...scheduleRun, unread: false }, unreadCount: 0 },
	],
	["schedule/subscribe", {}, { snapshot: { serverEpoch: EPOCH, tasks: [scheduleTask], unreadCount: 0, cursor: 53 } }],
	["schedule/unsubscribe", {}, { unsubscribed: true }],
	[
		"session/readImage",
		{
			sessionId: SESSION_ID,
			image: { hash: "a".repeat(64), mediaType: "image/png", byteLength: 4 },
		},
		{ data: "aGVsbG8=", mediaType: "image/png" },
	],
] as const;

const scheduleEvents = [
	{ type: "schedule/updated", task: scheduleTask },
	{ type: "schedule/deleted", taskId: TASK_ID },
	{
		type: "schedule/runUpdated",
		task: structuredClone(scheduleTask),
		run: structuredClone(scheduleRunSummary),
	},
	{ type: "schedule/refreshed" },
] as const;

describe("golden protocol fixtures", () => {
	it("covers and validates every client and host request method", () => {
		const clientMethods = requests.filter((entry) => entry.direction === "client").map((entry) => entry.method);
		const hostMethods = requests.filter((entry) => entry.direction === "host").map((entry) => entry.method);
		expect(new Set([...clientMethods, ...scheduleCases.map(([method]) => method)])).toEqual(
			new Set(Object.keys(ClientRequestMethods)),
		);
		expect(new Set(hostMethods)).toEqual(new Set(Object.keys(HostRequestMethods)));
		for (const entry of requests) {
			const validated =
				entry.direction === "client" ? validateClientRequest(entry.envelope) : validateHostRequest(entry.envelope);
			expect(validated).toEqual(entry.envelope);
		}
		for (const [method, params] of scheduleCases) {
			const request = makeClientRequest(method, params);
			expect(validateClientRequest(request)).toEqual(request);
		}
	});

	it("validates every success response against its pending method", () => {
		expect(responses).toHaveLength(requests.length);
		for (const entry of responses) {
			const request = requestFor(entry.direction, entry.method);
			expect(validateResponseFor(entry.direction, request.envelope, entry.envelope)).toEqual(entry.envelope);
		}
		for (const [method, params, result] of scheduleCases) {
			const request = makeClientRequest(method, params);
			const response = { jsonrpc: "2.0", id: "limit-test", result };
			expect(validateResponseFor("client", request, response)).toEqual(response);
		}
	});

	it("accepts the optional informational notice on a compact result", () => {
		const request = requestFor("client", "session/compact");
		const response = {
			jsonrpc: "2.0",
			id: request.envelope.id,
			result: {
				sessionId: "11111111-1111-4111-8111-111111111111",
				tokensBefore: 0,
				estimatedTokensAfter: null,
				message: "Nothing to compact (session too small)",
			},
		};
		expect(validateResponseFor("client", request.envelope, response)).toEqual(response);
	});

	it("validates every server request and kind-correlated response", () => {
		expect(new Set(serverRequests.map((entry) => entry.method))).toEqual(new Set(Object.keys(ServerRequestMethods)));
		expect(new Set(serverRequests.map((entry) => entry.kind))).toEqual(
			new Set(["project_trust", "select", "confirm", "input", "ask_user", "browser_tabs"]),
		);
		for (const entry of serverRequests) {
			expect(validateServerRequest(entry.request)).toEqual(entry.request);
			expect(validateResponseFor("server", entry.request, entry.response)).toEqual(entry.response);
			if (entry.cancelResponse) {
				expect(validateResponseFor("server", entry.request, entry.cancelResponse)).toEqual(entry.cancelResponse);
			}
		}
	});

	it("validates every browser call and action variant", () => {
		const calls = [
			{ tool: "browser_tabs", input: { action: "list" } },
			{ tool: "browser_tabs", input: { action: "open", profileId: PROFILE_ID } },
			{ tool: "browser_tabs", input: { action: "close", browserId: BROWSER_ID } },
			{ tool: "browser_navigate", input: { browserId: BROWSER_ID, action: "goto", url: "https://example.test" } },
			{ tool: "browser_navigate", input: { browserId: BROWSER_ID, action: "goto", url: "metis browser search" } },
			...(["back", "forward", "reload"] as const).map((action) => ({
				tool: "browser_navigate",
				input: { browserId: BROWSER_ID, action },
			})),
			{ tool: "browser_observe", input: { browserId: BROWSER_ID, mode: "both", sinceRevision: 1 } },
			...[
				{ type: "click", target: { elementId: "e1" }, button: "left" },
				{ type: "hover", target: { x: 10, y: 20 } },
				{ type: "type", elementId: "e1", text: "hello", replace: true },
				{ type: "press", key: "Enter" },
				{ type: "scroll", direction: "down", pages: 2, elementId: "e1" },
				{ type: "drag", from: { elementId: "e1" }, to: { x: 10, y: 20 } },
				{ type: "select", elementId: "e1", value: "one" },
				{ type: "dialog", decision: "dismiss" },
			].map((action) => ({
				tool: "browser_act",
				input: {
					browserId: BROWSER_ID,
					documentId: DOCUMENT_ID,
					snapshotRevision: 1,
					origin: "https://example.test",
					intent: "Test the fixture",
					risk: "ordinary",
					action,
				},
			})),
			...(["login", "otp", "passkey", "device_approval", "captcha", "sensitive_action", "other"] as const).map(
				(reason) => ({ tool: "browser_handoff", input: { browserId: BROWSER_ID, reason } }),
			),
		];
		for (const [index, call] of calls.entries()) {
			const request = makeBrowserTool(call, `browser-call-${index}`);
			expect(validateServerRequest(request)).toEqual(request);
		}
	});

	it("shares browser state element formatting and action target enumeration", () => {
		const line = formatBrowserStateNode({
			depth: 1,
			elementId: "e7",
			role: "button",
			label: 'Delete\n"all"',
			flags: ["enabled", "actions=click"],
		});
		expect(line).toBe('  e7 button "Delete \\"all\\"" [enabled, actions=click]');
		expect(findBrowserStateElement(`document WebArea\n${line}`, "e7")).toEqual({
			elementId: "e7",
			role: "button",
			label: 'Delete "all"',
		});
		expect(browserActionElementIds({ type: "drag", from: { elementId: "e1" }, to: { elementId: "e2" } })).toEqual([
			"e2",
			"e1",
		]);
		expect(browserActionElementIds({ type: "press", key: "Enter" })).toEqual([]);
	});

	it("correlates bounded browser results with their pending call", () => {
		const request = makeBrowserTool({ tool: "browser_observe", input: { browserId: BROWSER_ID } });
		const response = {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				toolCallId: (request.params as { toolCallId: string }).toolCallId,
				result: { tool: "browser_observe", observation: browserObservation },
			},
		};
		expect(validateResponseFor("server", request, response)).toEqual(response);
		expect(() =>
			validateResponseFor("server", request, {
				...response,
				result: { ...response.result, toolCallId: "another-tool-call" },
			}),
		).toThrow("does not match");
		expect(() =>
			validateResponseFor("server", request, {
				...response,
				result: {
					...response.result,
					result: { tool: "browser_act", details: { status: "completed", observation: browserObservation } },
				},
			}),
		).toThrow("does not match");
	});

	it("accepts a fail-closed stale browser action with a fresh observation", () => {
		const request = makeBrowserTool({
			tool: "browser_act",
			input: {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Click the fixture",
				risk: "ordinary",
				action: { type: "click", target: { elementId: "e1" } },
			},
		});
		const response = {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				toolCallId: (request.params as { toolCallId: string }).toolCallId,
				result: {
					tool: "browser_act",
					details: { status: "stale", reason: "revision_changed", observation: browserObservation },
				},
			},
		};
		expect(validateResponseFor("server", request, response)).toEqual(response);
		const closed = structuredClone(response);
		closed.result.result.details = { status: "cancelled", reason: "tab_closed" } as never;
		expect(validateResponseFor("server", request, closed)).toEqual(closed);
	});

	it("rejects unsafe or oversized browser payloads", () => {
		const valid = makeBrowserTool({
			tool: "browser_act",
			input: {
				browserId: BROWSER_ID,
				documentId: DOCUMENT_ID,
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Type fixture text",
				risk: "ordinary",
				action: { type: "type", elementId: "e1", text: "safe" },
			},
		});
		expect(() => validateServerRequest({ ...valid, extra: true })).toThrow();
		expect(() =>
			validateServerRequest(
				makeBrowserTool({
					tool: "browser_navigate",
					input: { browserId: BROWSER_ID, action: "goto", url: "https://user:secret@example.test" },
				}),
			),
		).toThrow();
		expect(() =>
			validateServerRequest(
				makeBrowserTool({
					tool: "browser_navigate",
					input: { browserId: BROWSER_ID, action: "goto", url: "file:///tmp/x" },
				}),
			),
		).toThrow();
		const oversizedText = structuredClone(valid);
		(oversizedText.params as { call: { input: { action: { text: string } } } }).call.input.action.text = "x".repeat(
			MAX_BROWSER_ACTION_TEXT_UTF8_BYTES + 1,
		);
		expect(() => validateServerRequest(oversizedText)).toThrow();

		const observeRequest = makeBrowserTool(
			{ tool: "browser_observe", input: { browserId: BROWSER_ID } },
			"observe-limit",
		);
		const result = {
			jsonrpc: "2.0",
			id: observeRequest.id,
			result: {
				toolCallId: (observeRequest.params as { toolCallId: string }).toolCallId,
				result: { tool: "browser_observe", observation: browserObservation },
			},
		};
		expect(() =>
			validateResponseFor("server", observeRequest, {
				...result,
				result: {
					...result.result,
					result: {
						tool: "browser_observe",
						observation: { ...browserObservation, state: "x".repeat(MAX_BROWSER_STATE_UTF8_BYTES + 1) },
					},
				},
			}),
		).toThrow();
		expect(() =>
			validateResponseFor("server", observeRequest, {
				...result,
				result: {
					...result.result,
					result: {
						tool: "browser_observe",
						observation: {
							...browserObservation,
							screenshot: { mediaType: "image/jpeg", data: "A".repeat(MAX_BROWSER_SCREENSHOT_UTF8_BYTES + 1) },
						},
					},
				},
			}),
		).toThrow();
	});

	it("validates every server notification and domain event kind", () => {
		expect(new Set(notifications.map((entry) => entry.method))).toEqual(
			new Set(Object.keys(ServerNotificationMethods)),
		);
		for (const entry of notifications) expect(validateServerNotification(entry.envelope)).toEqual(entry.envelope);
		const scheduleNotification = {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch: EPOCH, fromCursor: 100, toCursor: 99 + scheduleEvents.length, events: scheduleEvents },
		};
		expect(validateServerNotification(scheduleNotification)).toEqual(scheduleNotification);
		const eventTypes = [
			...(notifications[0]!.envelope.params as { events: Array<{ type: string }> }).events.map(
				(event) => event.type,
			),
			...scheduleEvents.map((event) => event.type),
		];
		expect(new Set(eventTypes)).toEqual(
			new Set([
				"session/updated",
				"session/invalidated",
				"project/invalidated",
				"turn/started",
				"turn/completed",
				"turn/interrupted",
				"item/started",
				"item/delta",
				"item/completed",
				"interaction/notify",
				"session/permissionModeChanged",
				"session/collaborationModeChanged",
				"session/thinkingSelectionChanged",
				"session/modelChanged",
				"session/tasksChanged",
				"session/deliveredFilesChanged",
				"session/goalChanged",
				"turn/queueChanged",
				"agent/updated",
				"agent/deleted",
				"agent/item/started",
				"agent/item/delta",
				"agent/item/completed",
				"agent/itemsChanged",
				"server/state",
				"schedule/updated",
				"schedule/deleted",
				"schedule/runUpdated",
				"schedule/refreshed",
			]),
		);
	});

	it("keeps session task snapshots bounded and strictly typed", () => {
		const request = requestFor("client", "session/subscribe").envelope;
		const fixture = responses.find((entry) => entry.method === "session/subscribe")!.envelope;
		const withTasks = structuredClone(fixture) as {
			result: { snapshot: { tasks: Array<{ task: string; completed: unknown }> } };
		};
		withTasks.result.snapshot.tasks = [
			{ task: "Inspect implementation", completed: true },
			{ task: "Build task panel", completed: false },
		];
		expect(() => validateResponseFor("client", request, withTasks)).not.toThrow();

		const blank = structuredClone(withTasks);
		blank.result.snapshot.tasks[0]!.task = "";
		expect(() => validateResponseFor("client", request, blank)).toThrow(ProtocolValidationError);

		const oversized = structuredClone(withTasks);
		oversized.result.snapshot.tasks = Array.from({ length: 257 }, (_, index) => ({
			task: `Task ${index}`,
			completed: false,
		}));
		expect(() => validateResponseFor("client", request, oversized)).toThrow(ProtocolValidationError);

		const nonBoolean = structuredClone(withTasks);
		nonBoolean.result.snapshot.tasks[0]!.completed = "yes";
		expect(() => validateResponseFor("client", request, nonBoolean)).toThrow(ProtocolValidationError);
	});

	it("validates session/goal/set params and goal snapshots", () => {
		const valid = {
			jsonrpc: "2.0",
			id: "goal-set-valid",
			method: "session/goal/set",
			params: {
				sessionId: SESSION_ID,
				requestId: "22222222-2222-4222-8222-222222222232",
				objective: "keep tests green",
			},
		};
		expect(validateClientRequest(valid)).toEqual(valid);

		const statusOnly = {
			...valid,
			id: "goal-set-status",
			params: {
				sessionId: SESSION_ID,
				requestId: "22222222-2222-4222-8222-222222222233",
				status: "paused",
			},
		};
		expect(validateClientRequest(statusOnly)).toEqual(statusOnly);

		expect(() =>
			validateClientRequest({
				...valid,
				id: "goal-set-empty",
				params: {
					sessionId: SESSION_ID,
					requestId: "22222222-2222-4222-8222-222222222234",
				},
			}),
		).toThrow(ProtocolValidationError);

		expect(() =>
			validateClientRequest({
				...valid,
				id: "goal-set-blank-objective",
				params: {
					sessionId: SESSION_ID,
					requestId: "22222222-2222-4222-8222-222222222235",
					objective: "",
				},
			}),
		).toThrow(ProtocolValidationError);

		const subscribeRequest = requestFor("client", "session/subscribe").envelope;
		const subscribeFixture = responses.find((entry) => entry.method === "session/subscribe")!.envelope;
		const withGoal = structuredClone(subscribeFixture) as {
			result: {
				snapshot: {
					goal: {
						goalId: string;
						objective: string;
						status: string;
						timeUsedSeconds: number;
						activeStartedAt: string | null;
					} | null;
				};
			};
		};
		withGoal.result.snapshot.goal = {
			goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			objective: "keep tests green",
			status: "active",
			timeUsedSeconds: 12,
			activeStartedAt: "2026-08-17T00:00:00.000Z",
		};
		expect(() => validateResponseFor("client", subscribeRequest, withGoal)).not.toThrow();

		const blankObjective = structuredClone(withGoal);
		blankObjective.result.snapshot.goal!.objective = "";
		expect(() => validateResponseFor("client", subscribeRequest, blankObjective)).toThrow(ProtocolValidationError);
	});

	it("accepts terminal session invalidation notifications", () => {
		const notification = {
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: EPOCH,
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "session/invalidated", sessionId: SESSION_ID, reason: "deleted" }],
			},
		};

		expect(validateServerNotification(notification)).toEqual(notification);
	});

	it("validates scoped agent item events", () => {
		const fixtureEnvelope = structuredClone(notifications[0]!.envelope) as {
			params: { events: Array<Record<string, unknown>> };
		};
		const childEvents = fixtureEnvelope.params.events.filter((event) => String(event.type).startsWith("agent/item"));
		const envelope = {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch: EPOCH, fromCursor: 1, toCursor: childEvents.length, events: childEvents },
		};
		expect(validateServerNotification(envelope)).toEqual(envelope);

		const mismatched = structuredClone(envelope);
		(mismatched.params.events[0]!.item as Record<string, unknown>).sessionId = "different-child";
		expect(() => validateServerNotification(mismatched)).toThrow(ProtocolValidationError);

		const oversized = structuredClone(envelope);
		const delta = oversized.params.events.find((event) => event.type === "agent/item/delta")!;
		(delta.delta as Record<string, unknown>).text = "x".repeat(MAX_DELTA_UTF8_BYTES + 1);
		expect(() => validateServerNotification(oversized)).toThrow(ProtocolValidationError);
	});

	it("accepts active agent summaries without legacy configuration fields", () => {
		const envelope = structuredClone(notifications[0]!.envelope) as {
			params: { events: Array<{ type: string; agent?: Record<string, unknown> }> };
		};
		const event = envelope.params.events.find((candidate) => candidate.type === "agent/updated")!;
		expect(event.agent).toMatchObject({ agentType: "worker", archived: false });
		expect(validateServerNotification(envelope)).toEqual(envelope);
	});

	it("accepts runtime identity fields in active agent snapshots", () => {
		const request = requestFor("client", "session/subscribe");
		const response = structuredClone(
			responses.find((entry) => entry.direction === "client" && entry.method === "session/subscribe")!.envelope,
		) as {
			result: { snapshot: { agents: Array<Record<string, unknown>> } };
		};
		response.result.snapshot.agents = [
			{
				agentId: "22222222-2222-4222-8222-222222222222",
				name: "researcher",
				agentType: "worker",
				depth: 1,
				status: "stopped",
				archived: false,
				parentSessionId: "11111111-1111-4111-8111-111111111111",
				rootSessionId: "11111111-1111-4111-8111-111111111111",
				agentPath: ["22222222-2222-4222-8222-222222222222"],
				tasks: [],
				latestTask: {
					taskId: "33333333-3333-4333-8333-333333333333",
					status: "stopped",
					taskSummary: "Inspect the runtime",
					finalMessage: "done",
					createdAt: "2026-07-16T00:00:12.000Z",
					updatedAt: "2026-07-16T00:00:13.000Z",
				},
				createdAt: "2026-07-16T00:00:12.000Z",
				updatedAt: "2026-07-16T00:00:13.000Z",
			},
		];

		expect(validateResponseFor("client", request.envelope, response)).toEqual(response);
	});

	it.each([
		["runId", "runId", "33333333-3333-4333-8333-333333333333"],
		[
			"configuration",
			"configuration",
			{
				mode: "code",
				tools: ["read"],
				permissionMode: "ask",
				model: { provider: "openai", modelId: "gpt-test" },
				thinkingLevel: "max",
				cwd: "/tmp/metis-project",
				forkTurns: 0,
				timeoutSeconds: 1800,
			},
		],
	])("rejects legacy %s in current agent notifications", (_label, field, value) => {
		const envelope = structuredClone(notifications[0]!.envelope) as {
			params: {
				events: Array<{
					type: string;
					agent?: Record<string, unknown>;
				}>;
			};
		};
		const event = envelope.params.events.find((candidate) => candidate.type === "agent/updated")!;
		event.agent![field] = value;
		expect(() => validateServerNotification(envelope)).toThrow(ProtocolValidationError);
	});

	it("accepts auto and rejects unknown primary session permissions", () => {
		const request = structuredClone(requestFor("client", "session/setPermissionMode").envelope) as {
			params: { permissionMode: string };
		};
		request.params.permissionMode = "auto";
		expect(() => validateClientRequest(request)).not.toThrow();
		request.params.permissionMode = "automatic";
		expect(() => validateClientRequest(request)).toThrow(ProtocolValidationError);
	});

	it("rejects invalid session action parameters", () => {
		expect(() =>
			validateClientRequest(
				makeClientRequest("session/rename", {
					sessionId: "session-a",
					requestId: RUN_ID,
					name: "",
				}),
			),
		).toThrow(ProtocolValidationError);
		expect(() =>
			validateClientRequest(
				makeClientRequest("session/rename", {
					sessionId: "session-a",
					requestId: RUN_ID,
					name: "Renamed",
					extra: true,
				}),
			),
		).toThrow(ProtocolValidationError);
		expect(() =>
			validateClientRequest(
				makeClientRequest("session/delete", {
					sessionId: "bad/session",
					requestId: RUN_ID,
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	it("pins every standard and Metis error", () => {
		expect(new Set(errors.map((entry) => entry.name))).toEqual(new Set(Object.keys(RPC_ERROR_CODES)));
		for (const entry of errors) expect(validateUncorrelatedErrorResponse(entry.envelope)).toEqual(entry.envelope);
	});
});

describe("session read state", () => {
	it("keeps mark-read strict and request-id free", () => {
		const request = makeClientRequest("session/markRead", { sessionId: SESSION_ID });
		expect(validateClientRequest(request)).toEqual(request);
		(request.params as Record<string, unknown>).requestId = "00000000-0000-4000-8000-000000000001";
		expect(() => validateClientRequest(request)).toThrow(ProtocolValidationError);
	});
});

describe("exact limits", () => {
	it("keeps personalization updates strict and within the public text limit", () => {
		const valid = makeClientRequest("personalization/update", {
			instructions: "a".repeat(MAX_PUBLIC_TEXT_UTF8_BYTES),
		});
		expect(() => validateClientRequest(valid)).not.toThrow();
		(valid.params as Record<string, unknown>).extra = true;
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);
		delete (valid.params as Record<string, unknown>).extra;
		(valid.params as { instructions: string }).instructions += "a";
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);
	});

	it("keeps scheduled-task execution fields host-owned and bounds instructions", () => {
		const valid = makeClientRequest("schedule/create", {
			requestId: TASK_ID,
			name: "A",
			instruction: "a".repeat(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES),
			model: { provider: "openai", modelId: "gpt-test" },
			schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
		});
		expect(() => validateClientRequest(valid)).not.toThrow();
		(valid.params as Record<string, unknown>).cwd = "/forbidden";
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);
		delete (valid.params as Record<string, unknown>).cwd;
		(valid.params as Record<string, unknown>).instruction = `${"a".repeat(MAX_SCHEDULE_INSTRUCTION_UTF8_BYTES)}a`;
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);
		(valid.params as Record<string, unknown>).instruction = "run";
		(valid.params as Record<string, unknown>).name = "a".repeat(121);
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);
		(valid.params as Record<string, unknown>).name = "A";
		(valid.params as Record<string, unknown>).description = "a".repeat(513);
		expect(() => validateClientRequest(valid)).toThrow(ProtocolValidationError);

		const [method, params, result] = scheduleCases.find(([name]) => name === "schedule/run/get")!;
		const response = { jsonrpc: "2.0", id: "limit-test", result: structuredClone(result) } as {
			result: { run: Record<string, unknown> };
		};
		response.result.run.sessionFile = "/internal/session.jsonl";
		expect(() => validateResponseFor("client", makeClientRequest(method, params), response)).toThrow(
			ProtocolValidationError,
		);

		const [createMethod, createParams, createResult] = scheduleCases.find(([name]) => name === "schedule/create")!;
		const oldTarget = { jsonrpc: "2.0", id: "old-target", result: structuredClone(createResult) } as {
			result: { task: Record<string, unknown> };
		};
		oldTarget.result.task.target = { kind: "project", cwd: "/tmp/metis-project" };
		expect(() => validateResponseFor("client", makeClientRequest(createMethod, createParams), oldTarget)).toThrow(
			ProtocolValidationError,
		);
		const oldSource = { jsonrpc: "2.0", id: "old-source", result: structuredClone(createResult) } as {
			result: { task: Record<string, unknown> };
		};
		oldSource.result.task.createdFromSessionId = SESSION_ID;
		expect(() => validateResponseFor("client", makeClientRequest(createMethod, createParams), oldSource)).toThrow(
			ProtocolValidationError,
		);
	});

	it("enforces names in UTF-16 code units, including emoji and combining marks", () => {
		const base = structuredClone(requestFor("client", "initialize").envelope) as {
			params: { client: { name: string } };
		};
		base.params.client.name = "😀".repeat(MAX_NAME_UTF16_UNITS / 2);
		expect(() => validateClientRequest(base)).not.toThrow();
		base.params.client.name += "a";
		expect(() => validateClientRequest(base)).toThrow(ProtocolValidationError);

		base.params.client.name = "e\u0301".repeat(MAX_NAME_UTF16_UNITS / 2);
		expect(() => validateClientRequest(base)).not.toThrow();
		base.params.client.name += "e";
		expect(() => validateClientRequest(base)).toThrow(ProtocolValidationError);
	});

	it("enforces path and prompt UTF-8 byte limits exactly", () => {
		const create = makeClientRequest("session/create", {
			requestId: "22222222-2222-4222-8222-222222222222",
			cwd: "a".repeat(MAX_PATH_UTF8_BYTES),
		});
		expect(() => validateClientRequest(create)).not.toThrow();
		(create.params as { cwd: string }).cwd += "a";
		expect(() => validateClientRequest(create)).toThrow(ProtocolValidationError);

		const start = makeClientRequest("turn/start", {
			sessionId: SESSION_ID,
			requestId: "22222222-2222-4222-8222-222222222223",
			text: "a".repeat(MAX_PROMPT_UTF8_BYTES),
		});
		expect(() => validateClientRequest(start)).not.toThrow();
		(start.params as { text: string }).text += "a";
		expect(() => validateClientRequest(start)).toThrow(ProtocolValidationError);
	});

	it("accepts chat creation without a cwd and rejects unknown modes", () => {
		const create = makeClientRequest("session/create", {
			requestId: "22222222-2222-4222-8222-222222222224",
			mode: "chat",
		});
		expect(() => validateClientRequest(create)).not.toThrow();
		(create.params as { mode: string }).mode = "cowork";
		expect(() => validateClientRequest(create)).toThrow(ProtocolValidationError);
	});

	it("accepts session and draft skill catalog contexts", () => {
		const sessionRequest = makeClientRequest("skill/list", { sessionId: SESSION_ID });
		const draftRequest = makeClientRequest("skill/list", { cwd: "/work/project" });
		const globalDraftRequest = makeClientRequest("skill/list", { cwd: null });

		expect(() => validateClientRequest(sessionRequest)).not.toThrow();
		expect(() => validateClientRequest(draftRequest)).not.toThrow();
		expect(() => validateClientRequest(globalDraftRequest)).not.toThrow();
		expect(() =>
			validateClientRequest(makeClientRequest("skill/list", { sessionId: SESSION_ID, cwd: "/work" })),
		).toThrow(ProtocolValidationError);
	});

	it("accepts public Skill sources and rejects unknown sources", () => {
		const request = requestFor("client", "skill/list").envelope;
		const response = structuredClone(responses.find((entry) => entry.method === "skill/list")!.envelope) as {
			result: { skills: Array<{ name: string; description: string; source?: string }> };
		};
		response.result.skills[0]!.source = "system";
		expect(() => validateResponseFor("client", request, response)).not.toThrow();
		response.result.skills[0]!.source = "temporary";
		expect(() => validateResponseFor("client", request, response)).toThrow(ProtocolValidationError);
	});

	it("validates bounded Skill detail and mutation targets", () => {
		expect(() =>
			validateClientRequest(makeClientRequest("skill/get", { cwd: null, source: "system", name: "pdf" })),
		).not.toThrow();
		expect(() =>
			validateClientRequest(makeClientRequest("skill/get", { cwd: null, source: "project", name: "pdf" })),
		).toThrow(ProtocolValidationError);

		const upsert = structuredClone(requestFor("client", "skill/upsert").envelope) as {
			params: { cwd: string | null; source: string; name: string; content: string };
		};
		upsert.params.source = "system";
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
		upsert.params.source = "project";
		upsert.params.cwd = null;
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
		upsert.params.source = "user";
		upsert.params.name = "Writing Plans";
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
		upsert.params.name = "writing-plans";
		upsert.params.content = "你".repeat(90_000);
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);

		const remove = structuredClone(requestFor("client", "skill/remove").envelope) as {
			params: { expectedRevision: string | null };
		};
		remove.params.expectedRevision = null;
		expect(() => validateClientRequest(remove)).toThrow(ProtocolValidationError);
	});

	it("keeps Skill detail bounded and correlated to its request", () => {
		const request = requestFor("client", "skill/get").envelope;
		const fixture = responses.find((entry) => entry.method === "skill/get")!.envelope;
		const wrongName = structuredClone(fixture) as { result: { name: string } };
		wrongName.result.name = "another-skill";
		expect(() => validateResponseFor("client", request, wrongName)).toThrow("does not match its request");

		const leaked = structuredClone(fixture) as { result: Record<string, unknown> };
		leaked.result.secret = "must-not-cross-the-wire";
		expect(() => validateResponseFor("client", request, leaked)).toThrow(ProtocolValidationError);
	});

	it("validates bounded Skill import inspection and installation", () => {
		const inspect = requestFor("client", "skill/import/inspect").envelope;
		expect(() => validateClientRequest(inspect)).not.toThrow();
		const globalProject = structuredClone(inspect) as { params: { cwd: string | null } };
		globalProject.params.cwd = null;
		expect(() => validateClientRequest(globalProject)).toThrow(ProtocolValidationError);
		const foreign = structuredClone(inspect) as { params: { input: { url: string } } };
		foreign.params.input.url = "https://example.com/skills";
		expect(() => validateClientRequest(foreign)).toThrow(ProtocolValidationError);

		const install = structuredClone(requestFor("client", "skill/import").envelope) as {
			params: { candidateIds: string[] };
		};
		install.params.candidateIds.push(install.params.candidateIds[0]!);
		expect(() => validateClientRequest(install)).toThrow(ProtocolValidationError);

		const response = responses.find((entry) => entry.method === "skill/import/inspect")!.envelope;
		const duplicate = structuredClone(response) as { result: { candidates: Array<Record<string, unknown>> } };
		duplicate.result.candidates.push({ ...duplicate.result.candidates[0] });
		expect(() => validateResponseFor("client", inspect, duplicate)).toThrow("duplicate ids or names");
	});

	it("validates MCP targets, revisions, and credential-free URLs", () => {
		expect(() =>
			validateClientRequest(
				makeClientRequest("mcp/get", { sessionId: SESSION_ID, scope: "project", name: "filesystem" }),
			),
		).not.toThrow();
		expect(() =>
			validateClientRequest(makeClientRequest("mcp/get", { cwd: null, scope: "project", name: "filesystem" })),
		).toThrow(ProtocolValidationError);

		const remove = structuredClone(requestFor("client", "mcp/remove").envelope) as {
			params: { expectedRevision: string | null };
		};
		remove.params.expectedRevision = null;
		expect(() => validateClientRequest(remove)).toThrow(ProtocolValidationError);

		const upsert = structuredClone(requestFor("client", "mcp/upsert").envelope) as {
			params: { server: { url: string } };
		};
		upsert.params.server.url = "https://user:password@mcp.example.test/rpc";
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
		upsert.params.server.url = "https://mcp.example.test/rpc";
		(upsert.params.server as { bearerTokenEnvVar?: string }).bearerTokenEnvVar = "literal-secret";
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
	});

	it("validates bounded MCP credentials and JSON import correlation", () => {
		const upsert = structuredClone(requestFor("client", "mcp/upsert").envelope) as {
			params: { credential?: { bearerToken?: string; environment?: Record<string, string> } };
		};
		upsert.params.credential = {};
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);
		upsert.params.credential = {
			environment: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`SECRET_${index}`, "value"])),
		};
		expect(() => validateClientRequest(upsert)).toThrow(ProtocolValidationError);

		const inspect = requestFor("client", "mcp/import/inspect").envelope;
		expect(() => validateClientRequest(inspect)).not.toThrow();
		const globalProject = structuredClone(inspect) as { params: { cwd: string | null } };
		globalProject.params.cwd = null;
		expect(() => validateClientRequest(globalProject)).toThrow(ProtocolValidationError);
		const oversized = structuredClone(inspect) as { params: { text: string } };
		oversized.params.text = "x".repeat(1024 * 1024 + 1);
		expect(() => validateClientRequest(oversized)).toThrow(ProtocolValidationError);

		const install = structuredClone(requestFor("client", "mcp/import").envelope) as {
			params: { candidates: Array<{ id: string; expectedRevision: string | null }> };
		};
		install.params.candidates.push({ ...install.params.candidates[0]! });
		expect(() => validateClientRequest(install)).toThrow(ProtocolValidationError);

		const response = responses.find((entry) => entry.method === "mcp/import/inspect")!.envelope;
		const duplicate = structuredClone(response) as { result: { candidates: Array<Record<string, unknown>> } };
		duplicate.result.candidates.push(structuredClone(duplicate.result.candidates[0]!));
		expect(() => validateResponseFor("client", inspect, duplicate)).toThrow("duplicate ids or names");
		const leaked = structuredClone(response) as { result: { candidates: Array<Record<string, unknown>> } };
		leaked.result.candidates[0]!.secret = "must-not-cross-the-wire";
		expect(() => validateResponseFor("client", inspect, leaked)).toThrow(ProtocolValidationError);
	});

	it("keeps MCP secrets request-only and correlates server details", () => {
		const request = requestFor("client", "mcp/get").envelope;
		const fixture = responses.find((entry) => entry.method === "mcp/get")!.envelope;
		const leaked = structuredClone(fixture) as { result: { server: Record<string, unknown> } };
		leaked.result.server.bearerToken = "must-not-cross-the-wire";
		expect(() => validateResponseFor("client", request, leaked)).toThrow(ProtocolValidationError);

		const wrongServer = structuredClone(fixture) as { result: { server: { name: string } } };
		wrongServer.result.server.name = "another-server";
		expect(() => validateResponseFor("client", request, wrongServer)).toThrow("does not match its request");
	});

	it("rejects duplicate and out-of-scope MCP list rows", () => {
		const request = requestFor("client", "mcp/list").envelope;
		const fixture = responses.find((entry) => entry.method === "mcp/list")!.envelope;
		const duplicate = structuredClone(fixture) as { result: { servers: Array<Record<string, unknown>> } };
		duplicate.result.servers.push(structuredClone(duplicate.result.servers[0]!));
		expect(() => validateResponseFor("client", request, duplicate)).toThrow("duplicate scope/name pairs");

		const projectRow = structuredClone(fixture) as { result: { servers: Array<{ scope: string }> } };
		projectRow.result.servers[0]!.scope = "project";
		expect(() => validateResponseFor("client", request, projectRow)).toThrow(
			"Global MCP server list contains a project-scoped server",
		);
	});

	it("keeps profile summaries bounded, sorted, and internally consistent", () => {
		const request = requestFor("client", "profile/get").envelope;
		const fixture = responses.find((entry) => entry.method === "profile/get")!.envelope;
		expect(() => validateResponseFor("client", request, fixture)).not.toThrow();
		expect(() => validateClientRequest(makeClientRequest("profile/get", { extra: true }))).toThrow(
			ProtocolValidationError,
		);

		const invalidCount = structuredClone(fixture) as { result: { totalTokens: number } };
		invalidCount.result.totalTokens = -1;
		expect(() => validateResponseFor("client", request, invalidCount)).toThrow(ProtocolValidationError);

		const invalidDate = structuredClone(fixture) as { result: { activity: Array<{ date: string }> } };
		invalidDate.result.activity[0]!.date = "2026-02-30";
		expect(() => validateResponseFor("client", request, invalidDate)).toThrow(ProtocolValidationError);

		const duplicateDate = structuredClone(fixture) as { result: { activity: Array<{ date: string }> } };
		duplicateDate.result.activity[1]!.date = duplicateDate.result.activity[0]!.date;
		expect(() => validateResponseFor("client", request, duplicateDate)).toThrow(ProtocolValidationError);

		const duplicateSkill = structuredClone(fixture) as {
			result: { topSkills: Array<{ name: string; count: number }> };
		};
		duplicateSkill.result.topSkills[1]!.name = duplicateSkill.result.topSkills[0]!.name;
		expect(() => validateResponseFor("client", request, duplicateSkill)).toThrow(ProtocolValidationError);

		const inconsistentStreak = structuredClone(fixture) as {
			result: { currentStreakDays: number; longestStreakDays: number };
		};
		inconsistentStreak.result.currentStreakDays = inconsistentStreak.result.longestStreakDays + 1;
		expect(() => validateResponseFor("client", request, inconsistentStreak)).toThrow(ProtocolValidationError);

		const inconsistentInsight = structuredClone(fixture) as {
			result: { mostUsedThinkingLevel: string | null; mostUsedThinkingLevelPercent: number };
		};
		inconsistentInsight.result.mostUsedThinkingLevel = null;
		expect(() => validateResponseFor("client", request, inconsistentInsight)).toThrow(ProtocolValidationError);
	});

	it("keeps project deletion requests and results strict and fixed-size", () => {
		const revision = "a".repeat(64);
		const preview = makeClientRequest("project/deletePreview", { mode: "chat", cwd: "/canonical/project" });
		const deletion = makeClientRequest("project/delete", {
			requestId: "00000000-0000-4000-8000-000000000001",
			mode: "chat",
			cwd: "/canonical/project",
			expectedRevision: revision,
		});
		expect(validateClientRequest(preview)).toEqual(preview);
		expect(validateClientRequest(deletion)).toEqual(deletion);

		const invalidRequests = [
			makeClientRequest("project/deletePreview", { mode: "chat", cwd: "/canonical/project", extra: true }),
			makeClientRequest("project/deletePreview", { mode: "chat", cwd: "" }),
			makeClientRequest("project/deletePreview", { mode: "chat", cwd: "a".repeat(MAX_PATH_UTF8_BYTES + 1) }),
			makeClientRequest("project/deletePreview", { mode: "cowork", cwd: "/canonical/project" }),
			makeClientRequest("project/delete", {
				requestId: "not-a-uuid",
				mode: "chat",
				cwd: "/canonical/project",
				expectedRevision: revision,
			}),
			makeClientRequest("project/delete", {
				requestId: "00000000-0000-4000-8000-000000000001",
				mode: "chat",
				cwd: "/canonical/project",
				expectedRevision: "g".repeat(64),
			}),
			makeClientRequest("project/delete", {
				requestId: "00000000-0000-4000-8000-000000000001",
				mode: "chat",
				cwd: "/canonical/project",
				expectedRevision: "a".repeat(63),
			}),
		];
		for (const request of invalidRequests) {
			expect(() => validateClientRequest(request)).toThrow(ProtocolValidationError);
		}

		const previewResult = (extra: Record<string, unknown> = {}) => ({
			jsonrpc: "2.0",
			id: "limit-test",
			result: {
				mode: "chat",
				cwd: "/canonical/project",
				sessionCount: 1,
				blockingScheduleCount: 0,
				revision,
				...extra,
			},
		});
		expect(() => validateResponseFor("client", preview, previewResult())).not.toThrow();
		for (const result of [
			previewResult({ sessionCount: -1 }),
			previewResult({ sessionCount: 100_001 }),
			previewResult({ sessionCount: Number.MAX_SAFE_INTEGER + 1 }),
			previewResult({ blockingScheduleCount: -1 }),
			previewResult({ blockingScheduleCount: 100_001 }),
			previewResult({ mode: "cowork" }),
			previewResult({ cwd: "" }),
			previewResult({ revision: "g".repeat(64) }),
			previewResult({ sessionIds: [SESSION_ID] }),
			previewResult({ paths: ["/private/session.jsonl"] }),
		]) {
			expect(() => validateResponseFor("client", preview, result)).toThrow(ProtocolValidationError);
		}

		const deleteResult = {
			jsonrpc: "2.0",
			id: "limit-test",
			result: { mode: "chat", cwd: "/canonical/project", deletedSessionCount: 1 },
		};
		expect(() => validateResponseFor("client", deletion, deleteResult)).not.toThrow();
		for (const deletedSessionCount of [-1, 100_001, Number.MAX_SAFE_INTEGER + 1]) {
			const invalid = structuredClone(deleteResult);
			invalid.result.deletedSessionCount = deletedSessionCount;
			expect(() => validateResponseFor("client", deletion, invalid)).toThrow(ProtocolValidationError);
		}
		const leaked = structuredClone(deleteResult) as typeof deleteResult & { result: { sessionIds: string[] } };
		leaked.result.sessionIds = [SESSION_ID];
		expect(() => validateResponseFor("client", deletion, leaked)).toThrow(ProtocolValidationError);
	});

	it("accepts bounded local file attachments on turns", () => {
		const request = makeClientRequest("turn/start", {
			sessionId: SESSION_ID,
			requestId: "22222222-2222-4222-8222-222222222222",
			text: "Summarize this",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		});
		expect(validateClientRequest(request).params).toMatchObject({
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		});

		expect(() =>
			validateClientRequest(
				makeClientRequest("turn/start", {
					sessionId: SESSION_ID,
					requestId: "22222222-2222-4222-8222-222222222222",
					text: "Too many",
					attachments: Array.from({ length: 17 }, (_, index) => ({ path: `/tmp/${index}.pdf` })),
				}),
			),
		).toThrow(ProtocolValidationError);
	});

	it("bounds choices, history pages, and event batches", () => {
		const choices = Array.from({ length: MAX_INTERACTION_CHOICES }, (_, index) => ({
			id: `choice-${index}`,
			label: `Choice ${index}`,
		}));
		const interaction = {
			interactionId: "44444444-4444-4444-8444-444444444444",
			sessionId: SESSION_ID,
			kind: "select",
			title: "Choose",
			message: "Choose one",
			createdAt: "2026-07-16T00:00:00.000Z",
			choices,
		};
		expect(() => validateServerRequest(makeServerInteraction(interaction))).not.toThrow();
		choices.push({ id: "too-many", label: "Too many" });
		expect(() => validateServerRequest(makeServerInteraction(interaction))).toThrow(ProtocolValidationError);

		const item = (index: number) => ({
			itemId: `item-${index}`,
			sessionId: SESSION_ID,
			role: "assistant",
			state: "completed",
			content: [],
			createdAt: "2026-07-16T00:00:00.000Z",
		});
		const readRequest = requestFor("client", "session/readItems").envelope;
		const page = {
			jsonrpc: "2.0",
			id: readRequest.id,
			result: {
				items: Array.from({ length: MAX_HISTORY_ITEMS }, (_, index) => item(index)),
				nextBeforeItemId: null,
			},
		};
		expect(() => validateResponseFor("client", readRequest, page)).not.toThrow();
		page.result.items.push(item(MAX_HISTORY_ITEMS));
		expect(() => validateResponseFor("client", readRequest, page)).toThrow(ProtocolValidationError);

		const events = Array.from({ length: MAX_EVENT_BATCH }, () => ({ type: "server/state", state: "ready" }));
		const batch = {
			jsonrpc: "2.0",
			method: "connection/events",
			params: { serverEpoch: EPOCH, fromCursor: 1, toCursor: MAX_EVENT_BATCH, events },
		};
		expect(() => validateServerNotification(batch)).not.toThrow();
		events.push({ type: "server/state", state: "ready" });
		expect(() => validateServerNotification(batch)).toThrow(ProtocolValidationError);
	});

	it("requires event cursor ranges to be contiguous and complete", () => {
		const notification = structuredClone(notifications[0]!.envelope) as {
			params: { toCursor: number };
		};
		notification.params.toCursor += 1;
		expect(() => validateServerNotification(notification)).toThrow(ProtocolValidationError);
	});

	it("caps raw ingress before decode or JSON.parse", () => {
		const exact = `${" ".repeat(MAX_ENVELOPE_UTF8_BYTES - 4)}null`;
		expect(parseRawEnvelope(exact)).toBeNull();
		expect(() => parseRawEnvelope(`${exact} `)).toThrow("8 MiB");
		expect(() => parseRawEnvelope(new Uint8Array(MAX_ENVELOPE_UTF8_BYTES + 1))).toThrow("8 MiB");
		expect(() => parseRawEnvelope(Uint8Array.of(0xff))).toThrow("valid UTF-8");
	});

	it("enforces the exact structured-envelope byte boundary before stringify", () => {
		const exact = { x: "a".repeat(MAX_ENVELOPE_UTF8_BYTES - 8) };
		expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(MAX_ENVELOPE_UTF8_BYTES);
		expect(() => assertEnvelopeByteLimit(exact)).not.toThrow();
		expect(() => assertEnvelopeByteLimit({ x: `${exact.x}a` })).toThrow("8 MiB");
	});
});

describe("safe structured-clone ingress", () => {
	it("rejects accessors without invoking them", () => {
		let calls = 0;
		const value = { jsonrpc: "2.0", id: "x", method: "session/list" } as Record<string, unknown>;
		Object.defineProperty(value, "params", {
			enumerable: true,
			get() {
				calls += 1;
				return {};
			},
		});
		expect(() => validateClientRequest(value)).toThrow(ProtocolValidationError);
		expect(calls).toBe(0);
	});

	it("rejects non-enumerable data that would disappear on the wire", () => {
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "hidden", { value: true, enumerable: false });
		expect(() => assertEnvelopeByteLimit(value)).toThrow(ProtocolValidationError);
	});

	it.each([
		["custom prototype", Object.assign(Object.create({ inherited: true }), { value: 1 })],
		["array subclass", new (class extends Array<unknown> {})()],
		["Date", new Date()],
		["Map", new Map()],
		["symbol value", { value: Symbol("x") }],
		["function", { value: () => undefined }],
		["bigint", { value: 1n }],
		["undefined", { value: undefined }],
		["dangerous constructor key", { constructor: "x" }],
		["dangerous prototype key", { prototype: "x" }],
	])("rejects %s", (_label, value) => {
		expect(() => assertEnvelopeByteLimit(value)).toThrow(ProtocolValidationError);
	});

	it("rejects symbol keys, cycles, aliases, sparse arrays, and parsed __proto__ keys", () => {
		const symbolKey = { safe: true } as Record<PropertyKey, unknown>;
		symbolKey[Symbol("x")] = true;
		expect(() => assertEnvelopeByteLimit(symbolKey)).toThrow(ProtocolValidationError);

		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(() => assertEnvelopeByteLimit(cycle)).toThrow(ProtocolValidationError);

		const shared = { value: true };
		expect(() => assertEnvelopeByteLimit({ first: shared, second: shared })).toThrow(ProtocolValidationError);

		const sparse = new Array(2);
		sparse[1] = true;
		expect(() => assertEnvelopeByteLimit(sparse)).toThrow(ProtocolValidationError);
		expect(() => assertEnvelopeByteLimit(JSON.parse('{"__proto__":true}'))).toThrow(ProtocolValidationError);
	});
});

describe("direction and response correlation", () => {
	it("uses one exact UTF-16 limit for request and error-response RPC ids", () => {
		const request = structuredClone(requestFor("client", "session/list").envelope) as { id: string };
		request.id = "😀".repeat(64);
		expect(() => validateClientRequest(request)).not.toThrow();
		const errorResponse = { jsonrpc: "2.0", id: request.id, error: createRpcError("INTERNAL") };
		expect(() => validateUncorrelatedErrorResponse(errorResponse)).not.toThrow();

		request.id += "😀";
		expect(() => validateClientRequest(request)).toThrow(ProtocolValidationError);
		errorResponse.id = request.id;
		expect(() => validateUncorrelatedErrorResponse(errorResponse)).toThrow(ProtocolValidationError);
	});

	it("keeps unsupported integer initialize versions available for protocol negotiation", () => {
		const initialize = structuredClone(requestFor("client", "initialize").envelope) as {
			params: { protocolVersion: number | string };
		};
		initialize.params.protocolVersion = 3;
		expect(validateClientRequest(initialize)).toEqual(initialize);
		initialize.params.protocolVersion = 0;
		expect(() => validateClientRequest(initialize)).toThrow(ProtocolValidationError);
		initialize.params.protocolVersion = "2";
		expect(() => validateClientRequest(initialize)).toThrow(ProtocolValidationError);
	});

	it("preserves canonical custom session ids while request ids remain UUIDs", () => {
		const open = structuredClone(requestFor("client", "session/open").envelope) as {
			params: { sessionId: string };
		};
		expect(open.params.sessionId).toBe("my-custom-id");
		expect(() => validateClientRequest(open)).not.toThrow();
		open.params.sessionId = "-invalid";
		expect(() => validateClientRequest(open)).toThrow(ProtocolValidationError);

		const create = structuredClone(requestFor("client", "session/create").envelope) as {
			params: { requestId: string };
		};
		create.params.requestId = "not-a-uuid";
		expect(() => validateClientRequest(create)).toThrow(ProtocolValidationError);
	});

	it("does not expose host-only or server-origin methods to renderer clients", () => {
		expect(() => validateClientRequest(requestFor("host", "server/shutdown").envelope)).toThrow("Method not found");
		expect(() => validateClientRequest(serverRequests[0]!.request)).toThrow("Method not found");
		expect(() => validateHostRequest(requestFor("host", "server/shutdown").envelope)).not.toThrow();
	});

	it("rejects a success result belonging to another method", () => {
		const open = requestFor("client", "session/open").envelope;
		const listResponse = responses.find((entry) => entry.method === "session/list")!.envelope;
		const wrong = { ...listResponse, id: open.id };
		expect(() => validateResponseFor("client", open, wrong)).toThrow(ProtocolValidationError);
	});

	it("rejects context breakdowns whose sum does not match contextTokens", () => {
		const request = requestFor("client", "session/status").envelope;
		const response = structuredClone(responses.find((entry) => entry.method === "session/status")!.envelope) as {
			result: { contextBreakdown: Array<{ category: string; tokens: number }> };
		};
		response.result.contextBreakdown[0]!.tokens += 1;
		expect(() => validateResponseFor("client", request, response)).toThrow(ProtocolValidationError);
	});

	it("requires unavailable context status to carry null tokens and breakdown", () => {
		const request = requestFor("client", "session/status").envelope;
		const response = structuredClone(responses.find((entry) => entry.method === "session/status")!.envelope) as {
			result: { contextBasis: string; contextTokens: number | null; contextBreakdown: unknown };
		};
		response.result.contextBasis = "unavailable";
		response.result.contextTokens = 64_000;
		expect(() => validateResponseFor("client", request, response)).toThrow(ProtocolValidationError);
	});

	it("rejects duplicate skill names", () => {
		const request = requestFor("client", "skill/list").envelope;
		const response = structuredClone(responses.find((entry) => entry.method === "skill/list")!.envelope) as {
			result: { skills: Array<{ name: string; description: string }> };
		};
		response.result.skills.push({ ...response.result.skills[0]! });
		expect(() => validateResponseFor("client", request, response)).toThrow("duplicate names");
	});

	it("rejects method-valid results and errors correlated to another session", () => {
		const open = requestFor("client", "session/open").envelope;
		const response = structuredClone(responses.find((entry) => entry.method === "session/open")!.envelope) as {
			result: { session: { sessionId: string } };
		};
		response.result.session.sessionId = "another-session";
		expect(() => validateResponseFor("client", open, response)).toThrow("does not match");

		for (const method of ["session/status", "session/compact"] as const) {
			const request = requestFor("client", method).envelope;
			const methodResponse = structuredClone(responses.find((entry) => entry.method === method)!.envelope) as {
				result: { sessionId: string };
			};
			methodResponse.result.sessionId = "another-session";
			expect(() => validateResponseFor("client", request, methodResponse)).toThrow("does not match");
		}

		const wrongError = {
			jsonrpc: "2.0",
			id: open.id,
			error: createRpcError("NOT_FOUND", { sessionId: "another-session" }),
		};
		expect(() => validateResponseFor("client", open, wrongError)).toThrow("does not match");
		wrongError.error = createRpcError("NOT_FOUND", { sessionId: "my-custom-id" });
		expect(() => validateResponseFor("client", open, wrongError)).not.toThrow();
	});

	it("rejects an invalid pending-request direction at runtime", () => {
		const fixture = serverRequests[0]!;
		expect(() => validateResponseFor("bogus" as never, fixture.request, fixture.response)).toThrow(
			"Invalid pending request direction",
		);
	});

	it("requires exactly one result or error and rejects unknown fields", () => {
		const request = requestFor("client", "session/list").envelope;
		expect(() =>
			validateResponseFor("client", request, {
				jsonrpc: "2.0",
				id: request.id,
				result: { sessions: [], nextAfterSessionId: null },
				error: createRpcError("INTERNAL"),
			}),
		).toThrow(ProtocolValidationError);
		const extra = structuredClone(request) as { params: Record<string, unknown> };
		extra.params.extra = true;
		expect(() => validateClientRequest(extra)).toThrow(ProtocolValidationError);
	});

	it("correlates interaction kind, id, and offered choices", () => {
		const fixture = serverRequests.find((entry) => entry.kind === "select")!;
		const wrongKind = structuredClone(fixture.response) as { result: Record<string, unknown> };
		wrongKind.result.kind = "confirm";
		wrongKind.result.confirmed = true;
		delete wrongKind.result.choiceId;
		expect(() => validateResponseFor("server", fixture.request, wrongKind)).toThrow(ProtocolValidationError);

		const unknownChoice = structuredClone(fixture.response) as { result: { choiceId: string } };
		unknownChoice.result.choiceId = "not-offered";
		expect(() => validateResponseFor("server", fixture.request, unknownChoice)).toThrow("unknown choice");
	});

	it("correlates every ask_user answer with its question and selection mode", () => {
		const fixture = serverRequests.find((entry) => entry.kind === "ask_user")!;
		const request = () =>
			structuredClone(fixture.request) as {
				params: {
					interaction: {
						questions: Array<{
							id: string;
							choices: Array<{ id: string; label: string }>;
						}>;
					};
				};
			};
		const invalidRequests = [
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions = [];
			},
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions = Array.from({ length: 6 }, (_unused, index) => ({
					...structuredClone(value.params.interaction.questions[0]!),
					id: `question:${index}`,
				}));
			},
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions[0]!.choices.pop();
			},
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions[0]!.choices = Array.from({ length: 6 }, (_unused, index) => ({
					id: `choice:${index}`,
					label: `Choice ${index}`,
				}));
			},
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions[1]!.id = value.params.interaction.questions[0]!.id;
			},
			(value: ReturnType<typeof request>) => {
				value.params.interaction.questions[0]!.choices[1]!.id =
					value.params.interaction.questions[0]!.choices[0]!.id;
			},
		];
		for (const mutate of invalidRequests) {
			const value = request();
			mutate(value);
			expect(() => validateServerRequest(value)).toThrow(ProtocolValidationError);
		}
		const response = () =>
			structuredClone(fixture.response) as {
				result: {
					cancelled: boolean;
					answers: Array<{ questionId: string; choiceIds: string[]; customAnswer?: string }>;
				};
			};
		const invalid = [
			(value: ReturnType<typeof response>) => {
				value.result.answers[0]!.questionId = "question:missing";
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers[0]!.choiceIds = ["choice:missing"];
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers[1]!.questionId = "question:0";
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers[0]!.choiceIds = ["choice:0", "choice:1"];
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers[0]!.customAnswer = "also custom";
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers.pop();
			},
			(value: ReturnType<typeof response>) => {
				value.result.cancelled = true;
			},
			(value: ReturnType<typeof response>) => {
				value.result.answers[1]!.customAnswer = "x".repeat(4097);
			},
		];
		for (const mutate of invalid) {
			const value = response();
			mutate(value);
			expect(() => validateResponseFor("server", fixture.request, value)).toThrow(ProtocolValidationError);
		}

		const cancelled = response();
		cancelled.result.cancelled = true;
		cancelled.result.answers = [];
		expect(() => validateResponseFor("server", fixture.request, cancelled)).not.toThrow();
	});

	it("only accepts a cancellation error correlated to its pending interaction", () => {
		const fixture = serverRequests.find((entry) => entry.cancelResponse)!;
		expect(() => validateResponseFor("server", fixture.request, fixture.cancelResponse)).not.toThrow();

		const missingId = structuredClone(fixture.cancelResponse) as {
			error: { data: { interactionId?: string } };
		};
		delete missingId.error.data.interactionId;
		expect(() => validateResponseFor("server", fixture.request, missingId)).toThrow("does not match");

		const wrongId = structuredClone(fixture.cancelResponse) as {
			error: { data: { interactionId: string } };
		};
		wrongId.error.data.interactionId = "44444444-4444-4444-8444-444444444449";
		expect(() => validateResponseFor("server", fixture.request, wrongId)).toThrow("does not match");

		const internal = {
			jsonrpc: "2.0",
			id: fixture.request.id,
			error: createRpcError("INTERNAL"),
		};
		expect(() => validateResponseFor("server", fixture.request, internal)).toThrow("does not match");
	});
});

describe("redacted errors and generated schema", () => {
	it("never copies causes, stacks, or provider payloads into protocol errors", () => {
		const sentinel = "SECRET_SENTINEL";
		const error = createRpcError("OPERATION_FAILED", {
			operationId: "operation_safe",
			cause: sentinel,
			stack: sentinel,
			providerPayload: sentinel,
		} as never);
		expect(JSON.stringify(error)).not.toContain(sentinel);
	});

	it("drops malformed allowlisted error context instead of serializing attacker-controlled values", () => {
		const sentinel = "SECRET_SENTINEL";
		const error = createRpcError("OPERATION_FAILED", {
			operationId: { toJSON: () => sentinel },
			requestId: "not-a-uuid",
		} as never);
		expect(error).toEqual({
			code: RPC_ERROR_CODES.OPERATION_FAILED,
			message: "Operation failed",
			data: { name: "OPERATION_FAILED", retryable: false },
		});
		expect(JSON.stringify(error)).not.toContain(sentinel);
	});

	it("publishes deterministic limit annotations without runtime type leaks", () => {
		const generated = readFileSync(join(fixturesDir, "../../generated/app-server.schema.json"), "utf8");
		expect(generated).toContain("x-metis-maxUtf16Units");
		expect(generated).toContain("x-metis-maxUtf8Bytes");
		for (const forbidden of [
			"AgentSessionEvent",
			"SessionEntry",
			"apiKey",
			"accessToken",
			"refreshToken",
			"Electron",
		]) {
			expect(generated).not.toContain(forbidden);
		}
	});
});
