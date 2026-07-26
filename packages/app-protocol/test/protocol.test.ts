import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertEnvelopeByteLimit,
	ClientRequestMethods,
	createRpcError,
	HostRequestMethods,
	MAX_ENVELOPE_UTF8_BYTES,
	MAX_EVENT_BATCH,
	MAX_HISTORY_ITEMS,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PATH_UTF8_BYTES,
	MAX_PROMPT_UTF8_BYTES,
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

describe("golden protocol fixtures", () => {
	it("covers and validates every client and host request method", () => {
		const clientMethods = requests.filter((entry) => entry.direction === "client").map((entry) => entry.method);
		const hostMethods = requests.filter((entry) => entry.direction === "host").map((entry) => entry.method);
		expect(new Set(clientMethods)).toEqual(new Set(Object.keys(ClientRequestMethods)));
		expect(new Set(hostMethods)).toEqual(new Set(Object.keys(HostRequestMethods)));
		for (const entry of requests) {
			const validated =
				entry.direction === "client" ? validateClientRequest(entry.envelope) : validateHostRequest(entry.envelope);
			expect(validated).toEqual(entry.envelope);
		}
	});

	it("validates every success response against its pending method", () => {
		expect(responses).toHaveLength(requests.length);
		for (const entry of responses) {
			const request = requestFor(entry.direction, entry.method);
			expect(validateResponseFor(entry.direction, request.envelope, entry.envelope)).toEqual(entry.envelope);
		}
	});

	it("validates every server request and kind-correlated response", () => {
		expect(new Set(serverRequests.map((entry) => entry.method))).toEqual(new Set(Object.keys(ServerRequestMethods)));
		expect(new Set(serverRequests.map((entry) => entry.kind))).toEqual(
			new Set(["project_trust", "select", "confirm", "input"]),
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
		const eventTypes = (notifications[0]!.envelope.params as { events: Array<{ type: string }> }).events.map(
			(event) => event.type,
		);
		expect(new Set(eventTypes)).toEqual(
			new Set([
				"session/updated",
				"turn/started",
				"turn/completed",
				"turn/interrupted",
				"item/started",
				"item/delta",
				"item/completed",
				"interaction/notify",
				"session/thinkingSelectionChanged",
				"subagent/updated",
				"server/state",
			]),
		);
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

	it("pins every standard and ArcMind error", () => {
		expect(new Set(errors.map((entry) => entry.name))).toEqual(new Set(Object.keys(RPC_ERROR_CODES)));
		for (const entry of errors) expect(validateUncorrelatedErrorResponse(entry.envelope)).toEqual(entry.envelope);
	});
});

describe("exact limits", () => {
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
		expect(generated).toContain("x-arcmind-maxUtf16Units");
		expect(generated).toContain("x-arcmind-maxUtf8Bytes");
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
