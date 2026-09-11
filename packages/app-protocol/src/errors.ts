import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { OpaqueIdSchema, SessionIdSchema, StrictObject, UuidSchema } from "./schema.ts";

export const RPC_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL: -32603,
	NOT_INITIALIZED: -32001,
	PROTOCOL_MISMATCH: -32002,
	NOT_FOUND: -32003,
	BUSY: -32004,
	REQUEST_ID_REUSED: -32005,
	SERVER_RESTARTED: -32006,
	OVERLOADED: -32007,
	INTERACTION_CANCELLED: -32008,
	SESSION_IN_USE: -32009,
	SESSION_CORRUPT: -32010,
	OPERATION_FAILED: -32011,
	READ_ONLY_SESSION: -32012,
	SCHEDULE_STORE_CORRUPT: -32013,
	CONFLICT: -32014,
	INVALID_CURSOR: -32015,
	GITHUB_RATE_LIMITED: -32016,
	GITHUB_DOWNLOAD_FAILED: -32017,
	GITHUB_ACCESS_DENIED: -32018,
} as const;

export type RpcErrorName = keyof typeof RPC_ERROR_CODES;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[RpcErrorName];

const ERROR_MESSAGES: Record<RpcErrorName, string> = {
	PARSE_ERROR: "Parse error",
	INVALID_REQUEST: "Invalid request",
	METHOD_NOT_FOUND: "Method not found",
	INVALID_PARAMS: "Invalid params",
	INTERNAL: "Internal error",
	NOT_INITIALIZED: "Connection is not initialized",
	PROTOCOL_MISMATCH: "Protocol version mismatch",
	NOT_FOUND: "Resource not found",
	BUSY: "Resource is busy",
	REQUEST_ID_REUSED: "Request ID was reused with different parameters",
	SERVER_RESTARTED: "App-server restarted",
	OVERLOADED: "Connection is overloaded",
	INTERACTION_CANCELLED: "Interaction was cancelled",
	SESSION_IN_USE: "Session is already in use",
	SESSION_CORRUPT: "Session is corrupt",
	OPERATION_FAILED: "Operation failed",
	READ_ONLY_SESSION: "Session is read-only",
	SCHEDULE_STORE_CORRUPT: "Scheduled task store is corrupt",
	CONFLICT: "Resource changed",
	INVALID_CURSOR: "Cursor is invalid or no longer available",
	GITHUB_RATE_LIMITED: "GitHub request limit reached. Please wait and try again, or use a different network or proxy.",
	GITHUB_DOWNLOAD_FAILED: "Could not download from GitHub. Check your network or proxy and try again later.",
	GITHUB_ACCESS_DENIED:
		"GitHub repository is unavailable or access was denied. Check the address and repository visibility.",
};

const RETRYABLE: Record<RpcErrorName, boolean> = {
	PARSE_ERROR: false,
	INVALID_REQUEST: false,
	METHOD_NOT_FOUND: false,
	INVALID_PARAMS: false,
	INTERNAL: false,
	NOT_INITIALIZED: true,
	PROTOCOL_MISMATCH: false,
	NOT_FOUND: false,
	BUSY: true,
	REQUEST_ID_REUSED: false,
	SERVER_RESTARTED: true,
	OVERLOADED: true,
	INTERACTION_CANCELLED: true,
	SESSION_IN_USE: true,
	SESSION_CORRUPT: false,
	OPERATION_FAILED: false,
	READ_ONLY_SESSION: false,
	SCHEDULE_STORE_CORRUPT: false,
	CONFLICT: false,
	INVALID_CURSOR: false,
	GITHUB_RATE_LIMITED: true,
	GITHUB_DOWNLOAD_FAILED: true,
	GITHUB_ACCESS_DENIED: false,
};

const STANDARD_ERROR_NAMES = new Set<RpcErrorName>([
	"PARSE_ERROR",
	"INVALID_REQUEST",
	"METHOD_NOT_FOUND",
	"INVALID_PARAMS",
	"INTERNAL",
]);

function ApplicationErrorDataSchema<Name extends RpcErrorName>(name: Name) {
	return StrictObject({
		name: Type.Literal(name),
		retryable: Type.Literal(RETRYABLE[name]),
		requestId: Type.Optional(UuidSchema),
		sessionId: Type.Optional(SessionIdSchema),
		operationId: Type.Optional(OpaqueIdSchema),
		interactionId: Type.Optional(UuidSchema),
	});
}

function StandardErrorSchema<Name extends RpcErrorName>(name: Name) {
	return StrictObject({
		code: Type.Literal(RPC_ERROR_CODES[name]),
		message: Type.Literal(ERROR_MESSAGES[name]),
	});
}

function ApplicationErrorSchema<Name extends RpcErrorName>(name: Name) {
	return StrictObject({
		code: Type.Literal(RPC_ERROR_CODES[name]),
		message: Type.Literal(ERROR_MESSAGES[name]),
		data: ApplicationErrorDataSchema(name),
	});
}

export const RpcErrorObjectSchema = Type.Union([
	StandardErrorSchema("PARSE_ERROR"),
	StandardErrorSchema("INVALID_REQUEST"),
	StandardErrorSchema("METHOD_NOT_FOUND"),
	StandardErrorSchema("INVALID_PARAMS"),
	StandardErrorSchema("INTERNAL"),
	ApplicationErrorSchema("NOT_INITIALIZED"),
	ApplicationErrorSchema("PROTOCOL_MISMATCH"),
	ApplicationErrorSchema("NOT_FOUND"),
	ApplicationErrorSchema("BUSY"),
	ApplicationErrorSchema("REQUEST_ID_REUSED"),
	ApplicationErrorSchema("SERVER_RESTARTED"),
	ApplicationErrorSchema("OVERLOADED"),
	ApplicationErrorSchema("INTERACTION_CANCELLED"),
	ApplicationErrorSchema("SESSION_IN_USE"),
	ApplicationErrorSchema("SESSION_CORRUPT"),
	ApplicationErrorSchema("OPERATION_FAILED"),
	ApplicationErrorSchema("READ_ONLY_SESSION"),
	ApplicationErrorSchema("SCHEDULE_STORE_CORRUPT"),
	ApplicationErrorSchema("CONFLICT"),
	ApplicationErrorSchema("INVALID_CURSOR"),
	ApplicationErrorSchema("GITHUB_RATE_LIMITED"),
	ApplicationErrorSchema("GITHUB_DOWNLOAD_FAILED"),
	ApplicationErrorSchema("GITHUB_ACCESS_DENIED"),
]);

export interface RpcErrorContext {
	requestId?: string;
	sessionId?: string;
	operationId?: string;
	interactionId?: string;
}

function safeContextValue(schema: typeof UuidSchema | typeof SessionIdSchema | typeof OpaqueIdSchema, value: unknown) {
	return typeof value === "string" && Check(schema, value) ? value : undefined;
}

export function createRpcError(name: RpcErrorName, context: RpcErrorContext = {}): Static<typeof RpcErrorObjectSchema> {
	if (STANDARD_ERROR_NAMES.has(name)) {
		return { code: RPC_ERROR_CODES[name], message: ERROR_MESSAGES[name] } as Static<typeof RpcErrorObjectSchema>;
	}
	const requestId = safeContextValue(UuidSchema, context.requestId);
	const sessionId = safeContextValue(SessionIdSchema, context.sessionId);
	const operationId = safeContextValue(OpaqueIdSchema, context.operationId);
	const interactionId = safeContextValue(UuidSchema, context.interactionId);
	return {
		code: RPC_ERROR_CODES[name],
		message: ERROR_MESSAGES[name],
		data: {
			name,
			retryable: RETRYABLE[name],
			...(requestId === undefined ? {} : { requestId }),
			...(sessionId === undefined ? {} : { sessionId }),
			...(operationId === undefined ? {} : { operationId }),
			...(interactionId === undefined ? {} : { interactionId }),
		},
	} as Static<typeof RpcErrorObjectSchema>;
}

export function rpcErrorNameForCode(code: number): RpcErrorName | undefined {
	return (Object.keys(RPC_ERROR_CODES) as RpcErrorName[]).find((name) => RPC_ERROR_CODES[name] === code);
}

export type RpcErrorObject = Static<typeof RpcErrorObjectSchema>;
