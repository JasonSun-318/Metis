import { type Static, type TSchema, Type } from "typebox";
import type { Validator } from "typebox/compile";
import { RPC_ERROR_CODES, type RpcErrorObject, RpcErrorObjectSchema } from "./errors.ts";
import {
	type ClientParams,
	type ClientRequestMethod,
	ClientRequestMethods,
	type ClientResult,
	type HostParams,
	type HostRequestMethod,
	HostRequestMethods,
	type HostResult,
	type InteractionResponseInput,
	type ServerNotificationMethod,
	ServerNotificationMethods,
	type ServerParams,
	type ServerRequestMethod,
	ServerRequestMethods,
	type ServerResult,
} from "./methods.ts";
import {
	assertEnvelopeByteLimit,
	assertSchema,
	compileSchema,
	type EmptySchemaContext,
	hasAtMostUtf8Bytes,
	MAX_ENVELOPE_UTF8_BYTES,
	ProtocolValidationError,
	StrictObject,
} from "./schema.ts";
import type { InteractionView } from "./views.ts";

const RPC_ID_SCHEMA = Type.Refine(
	Type.String({ minLength: 1, maxLength: 128, "x-metis-maxUtf16Units": 128 }),
	(value) => value.length <= 128,
	"must not exceed 128 UTF-16 code units",
);
const validatorCache = new WeakMap<object, Validator<EmptySchemaContext, TSchema>>();

function validatorFor(schema: TSchema): Validator<EmptySchemaContext, TSchema> {
	let validator = validatorCache.get(schema);
	if (!validator) {
		validator = compileSchema(schema);
		validatorCache.set(schema, validator);
	}
	return validator;
}

function RequestEnvelopeSchema(method: string, params: TSchema) {
	return StrictObject({
		jsonrpc: Type.Literal("2.0"),
		id: RPC_ID_SCHEMA,
		method: Type.Literal(method),
		params,
	});
}

function NotificationEnvelopeSchema(method: string, params: TSchema) {
	return StrictObject({
		jsonrpc: Type.Literal("2.0"),
		method: Type.Literal(method),
		params,
	});
}

function SuccessEnvelopeSchema(result: TSchema) {
	return StrictObject({
		jsonrpc: Type.Literal("2.0"),
		id: RPC_ID_SCHEMA,
		result,
	});
}

function unionOf(schemas: TSchema[]): TSchema {
	if (schemas.length === 0) return Type.Never();
	if (schemas.length === 1) return schemas[0]!;
	return Type.Union(schemas);
}

function requestSchemas(definitions: Record<string, { params: TSchema }>): TSchema[] {
	return Object.entries(definitions).map(([method, definition]) => RequestEnvelopeSchema(method, definition.params));
}

function successSchemas(definitions: Record<string, { result: TSchema }>): TSchema[] {
	return Object.values(definitions).map((definition) => SuccessEnvelopeSchema(definition.result));
}

export const ClientRequestEnvelopeSchema = unionOf(requestSchemas(ClientRequestMethods));
export const HostRequestEnvelopeSchema = unionOf(requestSchemas(HostRequestMethods));
export const ServerRequestEnvelopeSchema = unionOf(requestSchemas(ServerRequestMethods));
export const ServerNotificationEnvelopeSchema = unionOf(
	Object.entries(ServerNotificationMethods).map(([method, params]) => NotificationEnvelopeSchema(method, params)),
);
export const ClientSuccessResponseEnvelopeSchema = unionOf(successSchemas(ClientRequestMethods));
export const HostSuccessResponseEnvelopeSchema = unionOf(successSchemas(HostRequestMethods));
export const ServerSuccessResponseEnvelopeSchema = unionOf(successSchemas(ServerRequestMethods));
export const RpcErrorResponseEnvelopeSchema = StrictObject({
	jsonrpc: Type.Literal("2.0"),
	id: Type.Union([RPC_ID_SCHEMA, Type.Null()]),
	error: RpcErrorObjectSchema,
});
export const AppProtocolEnvelopeSchema = Type.Union([
	ClientRequestEnvelopeSchema,
	HostRequestEnvelopeSchema,
	ServerRequestEnvelopeSchema,
	ServerNotificationEnvelopeSchema,
	ClientSuccessResponseEnvelopeSchema,
	HostSuccessResponseEnvelopeSchema,
	ServerSuccessResponseEnvelopeSchema,
	RpcErrorResponseEnvelopeSchema,
]);

export type ClientRpcRequest = {
	[Method in ClientRequestMethod]: {
		jsonrpc: "2.0";
		id: string;
		method: Method;
		params: ClientParams<Method>;
	};
}[ClientRequestMethod];

export type HostRpcRequest = {
	[Method in HostRequestMethod]: {
		jsonrpc: "2.0";
		id: string;
		method: Method;
		params: HostParams<Method>;
	};
}[HostRequestMethod];

export type ServerRpcRequest = {
	[Method in ServerRequestMethod]: {
		jsonrpc: "2.0";
		id: string;
		method: Method;
		params: ServerParams<Method>;
	};
}[ServerRequestMethod];

export type ServerRpcNotification = {
	[Method in ServerNotificationMethod]: {
		jsonrpc: "2.0";
		method: Method;
		params: Static<(typeof ServerNotificationMethods)[Method]>;
	};
}[ServerNotificationMethod];

export type RpcErrorResponse = {
	jsonrpc: "2.0";
	id: string | null;
	error: RpcErrorObject;
};

export type ClientRpcSuccessResponse<Method extends ClientRequestMethod = ClientRequestMethod> = {
	jsonrpc: "2.0";
	id: string;
	result: ClientResult<Method>;
};
export type HostRpcSuccessResponse<Method extends HostRequestMethod = HostRequestMethod> = {
	jsonrpc: "2.0";
	id: string;
	result: HostResult<Method>;
};
export type ServerRpcSuccessResponse<Method extends ServerRequestMethod = ServerRequestMethod> = {
	jsonrpc: "2.0";
	id: string;
	result: ServerResult<Method>;
};

type RequestDefinition = { params: TSchema; result: TSchema };

function lookupDefinition(
	definitions: Record<string, RequestDefinition>,
	method: string,
): RequestDefinition | undefined {
	return Object.hasOwn(definitions, method) ? definitions[method] : undefined;
}

function assertExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	allowed: readonly string[],
	label: string,
): void {
	const keys = Object.keys(value);
	if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.includes(key))) {
		throw new ProtocolValidationError("invalid_request", `Invalid ${label}`);
	}
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	assertEnvelopeByteLimit(value);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ProtocolValidationError("invalid_request", `Invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function validateRequest(
	value: unknown,
	definitions: Record<string, RequestDefinition>,
	label: string,
): { jsonrpc: "2.0"; id: string; method: string; params: object } {
	const envelope = asRecord(value, label);
	assertExactKeys(envelope, ["jsonrpc", "id", "method", "params"], ["jsonrpc", "id", "method", "params"], label);
	if (
		envelope.jsonrpc !== "2.0" ||
		!validatorFor(RPC_ID_SCHEMA).Check(envelope.id) ||
		typeof envelope.method !== "string"
	) {
		throw new ProtocolValidationError("invalid_request", `Invalid ${label}`);
	}
	const definition = lookupDefinition(definitions, envelope.method);
	if (!definition) throw new ProtocolValidationError("method_not_found", "Method not found");
	assertSchema(validatorFor(definition.params), envelope.params, "invalid_params", `${envelope.method} params`);
	return envelope as { jsonrpc: "2.0"; id: string; method: string; params: object };
}

export function validateClientRequest(value: unknown): ClientRpcRequest {
	return validateRequest(value, ClientRequestMethods, "client request") as ClientRpcRequest;
}

export function validateHostRequest(value: unknown): HostRpcRequest {
	return validateRequest(value, HostRequestMethods, "host request") as HostRpcRequest;
}

export function validateServerRequest(value: unknown): ServerRpcRequest {
	return validateRequest(value, ServerRequestMethods, "server request") as ServerRpcRequest;
}

export function validateServerNotification(value: unknown): ServerRpcNotification {
	const envelope = asRecord(value, "server notification");
	assertExactKeys(envelope, ["jsonrpc", "method", "params"], ["jsonrpc", "method", "params"], "server notification");
	if (envelope.jsonrpc !== "2.0" || typeof envelope.method !== "string") {
		throw new ProtocolValidationError("invalid_request", "Invalid server notification");
	}
	const schema = Object.hasOwn(ServerNotificationMethods, envelope.method)
		? ServerNotificationMethods[envelope.method as ServerNotificationMethod]
		: undefined;
	if (!schema) throw new ProtocolValidationError("method_not_found", "Method not found");
	assertSchema(validatorFor(schema), envelope.params, "invalid_params", `${envelope.method} params`);
	return envelope as ServerRpcNotification;
}

function validateInteractionCorrelation(request: ServerRpcRequest, result: InteractionResponseInput): void {
	const interaction = request.params.interaction as InteractionView;
	if (result.interactionId !== interaction.interactionId || result.kind !== interaction.kind) {
		throw new ProtocolValidationError("invalid_response", "Interaction response does not match its request");
	}
	if (interaction.kind === "project_trust" || interaction.kind === "select") {
		if (!("choiceId" in result) || !interaction.choices.some((choice) => choice.id === result.choiceId)) {
			throw new ProtocolValidationError("invalid_response", "Interaction response selected an unknown choice");
		}
	}
	if (interaction.kind === "ask_user") {
		if (!("answers" in result) || !("cancelled" in result)) {
			throw new ProtocolValidationError("invalid_response", "ask_user response is incomplete");
		}
		if (result.cancelled) {
			if (result.answers.length !== 0) {
				throw new ProtocolValidationError("invalid_response", "Cancelled ask_user response contains answers");
			}
			return;
		}
		if (result.answers.length !== interaction.questions.length) {
			throw new ProtocolValidationError("invalid_response", "ask_user response must answer every question");
		}
		const questions = new Map(interaction.questions.map((question) => [question.id, question]));
		for (const answer of result.answers) {
			const question = questions.get(answer.questionId);
			if (!question) {
				throw new ProtocolValidationError("invalid_response", "ask_user response answered an unknown question");
			}
			questions.delete(answer.questionId);
			if (answer.choiceIds.some((choiceId) => !question.choices.some((choice) => choice.id === choiceId))) {
				throw new ProtocolValidationError("invalid_response", "ask_user response selected an unknown choice");
			}
			const answerSources = answer.choiceIds.length + (answer.customAnswer === undefined ? 0 : 1);
			if (question.multiple ? answerSources === 0 : answerSources !== 1) {
				throw new ProtocolValidationError(
					"invalid_response",
					"ask_user response violates the question selection mode",
				);
			}
		}
		if (questions.size !== 0) {
			throw new ProtocolValidationError("invalid_response", "ask_user response omitted a question");
		}
	}
}

function failResponseCorrelation(message: string): never {
	throw new ProtocolValidationError("invalid_response", message);
}

function hasUniqueIds(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function validateClientResultCorrelation(request: ClientRpcRequest, result: unknown): void {
	switch (request.method) {
		case "initialize":
			if ((result as ClientResult<"initialize">).protocolVersion !== request.params.protocolVersion) {
				failResponseCorrelation("Initialize response does not match the requested protocol version");
			}
			return;
		case "session/list": {
			const sessions = (result as ClientResult<"session/list">).sessions;
			if (!hasUniqueIds(sessions.map((session) => session.sessionId))) {
				failResponseCorrelation("Session list contains duplicate session ids");
			}
			return;
		}
		case "skill/list":
		case "skill/remove":
		case "skill/import": {
			const skills = (result as ClientResult<"skill/list">).skills;
			if (!hasUniqueIds(skills.map((skill) => skill.name))) {
				failResponseCorrelation("Skill list contains duplicate names");
			}
			if (
				"cwd" in request.params &&
				request.params.cwd === null &&
				skills.some((skill) => skill.source === "project")
			) {
				failResponseCorrelation("Global Skill list contains a project Skill");
			}
			return;
		}
		case "skill/import/inspect": {
			const candidates = (result as ClientResult<"skill/import/inspect">).candidates;
			if (
				!hasUniqueIds(candidates.map((candidate) => candidate.id)) ||
				!hasUniqueIds(candidates.map((candidate) => candidate.name))
			) {
				failResponseCorrelation("Skill import candidates contain duplicate ids or names");
			}
			return;
		}
		case "skill/get":
		case "skill/upsert": {
			const detail = result as ClientResult<"skill/get">;
			if (detail.name !== request.params.name || detail.source !== request.params.source) {
				failResponseCorrelation("Skill result does not match its request");
			}
			return;
		}
		case "mcp/list":
		case "mcp/upsert":
		case "mcp/remove":
		case "mcp/import": {
			const servers = (result as ClientResult<"mcp/list">).servers;
			if (!hasUniqueIds(servers.map((server) => `${server.scope}\0${server.name}`))) {
				failResponseCorrelation("MCP server list contains duplicate scope/name pairs");
			}
			if (
				"cwd" in request.params &&
				request.params.cwd === null &&
				servers.some((server) => server.scope !== "user")
			) {
				failResponseCorrelation("Global MCP server list contains a project-scoped server");
			}
			return;
		}
		case "mcp/import/inspect": {
			const candidates = (result as ClientResult<"mcp/import/inspect">).candidates;
			if (
				!hasUniqueIds(candidates.map((candidate) => candidate.id)) ||
				!hasUniqueIds(candidates.map((candidate) => candidate.name))
			) {
				failResponseCorrelation("MCP import candidates contain duplicate ids or names");
			}
			return;
		}
		case "mcp/get":
		case "mcp/restart":
		case "mcp/credential/set":
		case "mcp/credential/clear": {
			const server = (result as ClientResult<"mcp/get">).server;
			if (server.name !== request.params.name || server.scope !== request.params.scope) {
				failResponseCorrelation("MCP server result does not match its request");
			}
			return;
		}
		case "session/open":
			if ((result as ClientResult<"session/open">).session.sessionId !== request.params.sessionId) {
				failResponseCorrelation("Opened session does not match its request");
			}
			return;
		case "session/readItems": {
			const items = (result as ClientResult<"session/readItems">).items;
			if (
				items.some((item) => item.sessionId !== request.params.sessionId) ||
				!hasUniqueIds(items.map((item) => item.itemId))
			) {
				failResponseCorrelation("Item page does not match its requested session");
			}
			return;
		}
		case "session/status":
			if ((result as ClientResult<"session/status">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Session status does not match its request");
			}
			return;
		case "session/compact":
			if ((result as ClientResult<"session/compact">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Compacted session does not match its request");
			}
			return;
		case "session/goal/get":
			if ((result as ClientResult<"session/goal/get">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Goal get session does not match its request");
			}
			return;
		case "session/goal/set":
			if ((result as ClientResult<"session/goal/set">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Goal set session does not match its request");
			}
			return;
		case "session/goal/clear":
			if ((result as ClientResult<"session/goal/clear">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Goal clear session does not match its request");
			}
			return;
		case "session/close":
			if ((result as ClientResult<"session/close">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Closed session does not match its request");
			}
			return;
		case "session/archive": {
			const session = (result as ClientResult<"session/archive">).session;
			if (session.sessionId !== request.params.sessionId || !session.archived) {
				failResponseCorrelation("Archived session does not match its request");
			}
			return;
		}
		case "session/unarchive": {
			const session = (result as ClientResult<"session/unarchive">).session;
			if (session.sessionId !== request.params.sessionId || session.archived) {
				failResponseCorrelation("Unarchived session does not match its request");
			}
			return;
		}
		case "session/subscribe": {
			const snapshot = (result as ClientResult<"session/subscribe">).snapshot;
			if (
				snapshot.session.sessionId !== request.params.sessionId ||
				snapshot.turns.some((turn) => turn.sessionId !== request.params.sessionId) ||
				snapshot.recentItems.some((item) => item.sessionId !== request.params.sessionId) ||
				snapshot.pendingInteractions.some((interaction) => interaction.sessionId !== request.params.sessionId) ||
				!hasUniqueIds(snapshot.turns.map((turn) => turn.turnId)) ||
				!hasUniqueIds(snapshot.recentItems.map((item) => item.itemId)) ||
				!hasUniqueIds(snapshot.pendingInteractions.map((interaction) => interaction.interactionId)) ||
				!hasUniqueIds(snapshot.queuedTurns.map((turn) => turn.queueItemId)) ||
				(snapshot.activeTurnId !== null && !snapshot.turns.some((turn) => turn.turnId === snapshot.activeTurnId))
			) {
				failResponseCorrelation("Session snapshot does not match its subscription");
			}
			return;
		}
		case "turn/queue/update":
			if ((result as ClientResult<"turn/queue/update">).queuedTurn.queueItemId !== request.params.queueItemId) {
				failResponseCorrelation("Updated queued turn does not match its request");
			}
			return;
		case "turn/queue/delete":
			if ((result as ClientResult<"turn/queue/delete">).queueItemId !== request.params.queueItemId) {
				failResponseCorrelation("Deleted queued turn does not match its request");
			}
			return;
		case "turn/queue/send":
			if ((result as ClientResult<"turn/queue/send">).queueItemId !== request.params.queueItemId) {
				failResponseCorrelation("Sent queued turn does not match its request");
			}
			return;
		case "session/unsubscribe":
			if ((result as ClientResult<"session/unsubscribe">).sessionId !== request.params.sessionId) {
				failResponseCorrelation("Unsubscribed session does not match its request");
			}
			return;
		case "schedule/create":
			if ((result as ClientResult<"schedule/create">).task.id !== request.params.requestId) {
				failResponseCorrelation("Created schedule does not match its request");
			}
			return;
		case "schedule/list": {
			const tasks = (result as ClientResult<"schedule/list">).tasks;
			if (!hasUniqueIds(tasks.map((task) => task.id)))
				failResponseCorrelation("Schedule list contains duplicate tasks");
			return;
		}
		case "schedule/get":
		case "schedule/update":
		case "schedule/pause":
		case "schedule/resume":
			if ((result as ClientResult<typeof request.method>).task.id !== request.params.taskId) {
				failResponseCorrelation("Scheduled task does not match its request");
			}
			return;
		case "schedule/delete":
			if ((result as ClientResult<"schedule/delete">).taskId !== request.params.taskId) {
				failResponseCorrelation("Deleted schedule does not match its request");
			}
			return;
		case "schedule/run-now": {
			const run = (result as ClientResult<"schedule/run-now">).run;
			if (run.taskId !== request.params.taskId || run.id !== request.params.requestId) {
				failResponseCorrelation("Scheduled run does not match its request");
			}
			return;
		}
		case "schedule/run/list": {
			const runs = (result as ClientResult<"schedule/run/list">).runs;
			if (runs.some((run) => run.taskId !== request.params.taskId) || !hasUniqueIds(runs.map((run) => run.id))) {
				failResponseCorrelation("Scheduled run page does not match its task");
			}
			return;
		}
		case "schedule/run/get":
		case "schedule/run/mark-read": {
			const run = (result as ClientResult<typeof request.method>).run;
			if (run.taskId !== request.params.taskId || run.id !== request.params.runId) {
				failResponseCorrelation("Scheduled run does not match its request");
			}
			return;
		}
		case "schedule/subscribe": {
			const tasks = (result as ClientResult<"schedule/subscribe">).snapshot.tasks;
			if (!hasUniqueIds(tasks.map((task) => task.id))) {
				failResponseCorrelation("Schedule snapshot contains duplicate tasks");
			}
			return;
		}
		case "schedule/unsubscribe":
			return;
		case "connection/ack":
			if ((result as ClientResult<"connection/ack">).acknowledgedCursor !== request.params.cursor) {
				failResponseCorrelation("Acknowledged cursor does not match its request");
			}
	}
}

function validateErrorCorrelation(request: PendingRpcRequest, error: RpcErrorObject): void {
	if (!("data" in error)) return;
	const params = request.params as Record<string, unknown>;
	const interaction =
		request.method === "interaction/request"
			? (request.params as ServerParams<"interaction/request">).interaction
			: undefined;
	const expectedSessionId =
		typeof params.sessionId === "string"
			? params.sessionId
			: typeof params.sourceSessionId === "string"
				? params.sourceSessionId
				: interaction?.sessionId;
	if (error.data.requestId !== undefined && error.data.requestId !== params.requestId) {
		failResponseCorrelation("Error request id does not match its pending request");
	}
	if (error.data.sessionId !== undefined && error.data.sessionId !== expectedSessionId) {
		failResponseCorrelation("Error session id does not match its pending request");
	}
}

export type PendingRequestDirection = "client" | "host" | "server";
export type PendingRpcRequest = ClientRpcRequest | HostRpcRequest | ServerRpcRequest;

export function validateResponseFor(
	direction: PendingRequestDirection,
	requestValue: unknown,
	responseValue: unknown,
): ClientRpcSuccessResponse | HostRpcSuccessResponse | ServerRpcSuccessResponse | RpcErrorResponse {
	if (direction !== "client" && direction !== "host" && direction !== "server") {
		throw new ProtocolValidationError("invalid_response", "Invalid pending request direction");
	}
	const request =
		direction === "client"
			? validateClientRequest(requestValue)
			: direction === "host"
				? validateHostRequest(requestValue)
				: validateServerRequest(requestValue);
	const definitions =
		direction === "client" ? ClientRequestMethods : direction === "host" ? HostRequestMethods : ServerRequestMethods;
	const definition = lookupDefinition(definitions, request.method)!;
	const response = asRecord(responseValue, "RPC response");
	if (response.jsonrpc !== "2.0" || response.id !== request.id) {
		throw new ProtocolValidationError("invalid_response", "RPC response does not match its pending request");
	}
	const hasResult = Object.hasOwn(response, "result");
	const hasError = Object.hasOwn(response, "error");
	if (hasResult === hasError)
		throw new ProtocolValidationError("invalid_response", "RPC response must contain one result or error");
	if (hasError) {
		assertExactKeys(response, ["jsonrpc", "id", "error"], ["jsonrpc", "id", "error"], "RPC error response");
		assertSchema(validatorFor(RpcErrorObjectSchema), response.error, "invalid_response", "RPC error");
		validateErrorCorrelation(request, response.error as RpcErrorObject);
		if (direction === "server" && request.method === "interaction/request") {
			const interactionId = (request as ServerRpcRequest).params.interaction.interactionId;
			const error = response.error as RpcErrorObject;
			if (
				error.code !== RPC_ERROR_CODES.INTERACTION_CANCELLED ||
				!("data" in error) ||
				error.data.interactionId !== interactionId
			) {
				throw new ProtocolValidationError(
					"invalid_response",
					"Interaction cancellation does not match its pending request",
				);
			}
		}
		return response as RpcErrorResponse;
	}
	assertExactKeys(response, ["jsonrpc", "id", "result"], ["jsonrpc", "id", "result"], "RPC success response");
	assertSchema(validatorFor(definition.result), response.result, "invalid_response", `${request.method} result`);
	if (direction === "client") {
		validateClientResultCorrelation(request as ClientRpcRequest, response.result);
	} else if (direction === "server" && request.method === "interaction/request") {
		validateInteractionCorrelation(request as ServerRpcRequest, response.result as InteractionResponseInput);
	}
	return response as ClientRpcSuccessResponse | HostRpcSuccessResponse | ServerRpcSuccessResponse;
}

export function validateUncorrelatedErrorResponse(value: unknown): RpcErrorResponse {
	const response = asRecord(value, "RPC error response");
	assertSchema(validatorFor(RpcErrorResponseEnvelopeSchema), response, "invalid_response", "RPC error response");
	return response as RpcErrorResponse;
}

export function parseRawEnvelope(raw: string | Uint8Array): unknown {
	let text: string;
	if (typeof raw === "string") {
		if (!hasAtMostUtf8Bytes(raw, MAX_ENVELOPE_UTF8_BYTES)) {
			throw new ProtocolValidationError("parse", "Protocol envelope exceeds the 8 MiB limit");
		}
		text = raw;
	} else {
		if (raw.byteLength > MAX_ENVELOPE_UTF8_BYTES) {
			throw new ProtocolValidationError("parse", "Protocol envelope exceeds the 8 MiB limit");
		}
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
		} catch {
			throw new ProtocolValidationError("parse", "Protocol envelope is not valid UTF-8");
		}
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ProtocolValidationError("parse", "Protocol envelope is not valid JSON");
	}
}
