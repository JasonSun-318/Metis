import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertEnvelopeByteLimit,
	ClientRequestMethods,
	createRpcError,
	HostRequestMethods,
	MAX_DELTA_UTF8_BYTES,
	MAX_ENVELOPE_UTF8_BYTES,
	MAX_EVENT_BATCH,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PATH_UTF8_BYTES,
	MAX_PROMPT_UTF8_BYTES,
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
	method: "interaction/request";
	kind: string;
	request: Record<string, unknown>;
	response: Record<string, unknown>;
	cancelResponse?: Record<string, unknown>;
}

interface NotificationFixture {
	method: "connection/events";
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
			defaultThinkingSelection: "high",
			providers: [],
			loadError: null,
		},
	],
	[
		"model/testConnection",
		{ requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", provider: "openai", modelId: "gpt-test" },
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

	it("validates every server request and kind-correlated response", () => {
		expect(new Set(serverRequests.map((entry) => entry.method))).toEqual(new Set(Object.keys(ServerRequestMethods)));
		expect(new Set(serverRequests.map((entry) => entry.kind))).toEqual(
			new Set(["project_trust", "select", "confirm", "input", "ask_user"]),
		);
		for (const entry of serverRequests) {
			expect(validateServerRequest(entry.request)).toEqual(entry.request);
			expect(validateResponseFor("server", entry.request, entry.response)).toEqual(entry.response);
			if (entry.cancelResponse) {
				expect(validateResponseFor("server", entry.request, entry.cancelResponse)).toEqual(entry.cancelResponse);
			}
		}
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
				"session/thinkingSelectionChanged",
				"session/modelChanged",
				"session/tasksChanged",
				"subagent/updated",
				"subagent/item/started",
				"subagent/item/delta",
				"subagent/item/completed",
				"subagent/itemsChanged",
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

	it("validates scoped subagent item events", () => {
		const fixtureEnvelope = structuredClone(notifications[0]!.envelope) as {
			params: { events: Array<Record<string, unknown>> };
		};
		const childEvents = fixtureEnvelope.params.events.filter((event) =>
			String(event.type).startsWith("subagent/item"),
		);
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
		const delta = oversized.params.events.find((event) => event.type === "subagent/item/delta")!;
		(delta.delta as Record<string, unknown>).text = "x".repeat(MAX_DELTA_UTF8_BYTES + 1);
		expect(() => validateServerNotification(oversized)).toThrow(ProtocolValidationError);
	});

	it("requires configuration only for non-closed subagent summaries", () => {
		const envelope = structuredClone(notifications[0]!.envelope) as {
			params: { events: Array<{ type: string; subagent?: Record<string, unknown> }> };
		};
		const event = envelope.params.events.find((candidate) => candidate.type === "subagent/updated")!;
		const configuration = event.subagent!.configuration;
		delete event.subagent!.configuration;
		expect(() => validateServerNotification(envelope)).toThrow(ProtocolValidationError);

		event.subagent!.status = "closed";
		event.subagent!.configuration = configuration;
		expect(() => validateServerNotification(envelope)).toThrow(ProtocolValidationError);
		delete event.subagent!.configuration;
		expect(validateServerNotification(envelope)).toEqual(envelope);
	});

	it("accepts runtime identity fields in active subagent snapshots", () => {
		const request = requestFor("client", "session/subscribe");
		const response = structuredClone(
			responses.find((entry) => entry.direction === "client" && entry.method === "session/subscribe")!.envelope,
		) as {
			result: { snapshot: { subagents: Array<Record<string, unknown>> } };
		};
		response.result.snapshot.subagents = [
			{
				agentId: "22222222-2222-4222-8222-222222222222",
				runId: RUN_ID,
				name: "researcher",
				status: "stopped",
				background: false,
				taskSummary: "Inspect the runtime",
				configuration: {
					mode: "code",
					tools: ["read"],
					permissionMode: "ask",
					model: { provider: "openai", modelId: "gpt-test" },
					thinkingLevel: "max",
					cwd: "/tmp/metis-project",
					forkTurns: 0,
					timeoutSeconds: 1800,
				},
				createdAt: "2026-07-16T00:00:12.000Z",
				updatedAt: "2026-07-16T00:00:13.000Z",
			},
		];

		expect(validateResponseFor("client", request.envelope, response)).toEqual(response);
	});

	it.each([
		["auto", "permissionMode", "auto"],
		["readPaths", "readPaths", ["/tmp/project"]],
		["writePaths", "writePaths", ["/tmp/project"]],
	])("rejects legacy %s in current subagent notifications", (_label, field, value) => {
		const envelope = structuredClone(notifications[0]!.envelope) as {
			params: {
				events: Array<{
					type: string;
					subagent?: { configuration?: Record<string, unknown> };
				}>;
			};
		};
		const event = envelope.params.events.find((candidate) => candidate.type === "subagent/updated")!;
		event.subagent!.configuration![field] = value;
		expect(() => validateServerNotification(envelope)).toThrow(ProtocolValidationError);
	});

	it("rejects legacy auto for primary session permissions", () => {
		const request = structuredClone(requestFor("client", "session/setPermissionMode").envelope) as {
			params: { permissionMode: string };
		};
		request.params.permissionMode = "auto";
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
