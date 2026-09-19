import {
	type ClientRpcRequest,
	type ClientRpcSuccessResponse,
	createRpcError,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type RpcErrorContext,
	type RpcErrorName,
	type RpcErrorResponse,
	rpcErrorNameForCode,
	type ServerRequestMethod,
	type ServerResult,
	type ServerRpcNotification,
	type ServerRpcRequest,
	type ServerRpcSuccessResponse,
	validateClientRequest,
	validateResponseFor,
	validateServerNotification,
	validateServerRequest,
} from "@metis/app-protocol";
import type { ConnectionState, Dispatcher } from "./dispatcher.ts";
import { type OutboundEnvelope, OutboundQueue, type OutboundQueueLimits } from "./outbound-queue.ts";
import { AppServerError } from "./session-runtime-host.ts";
import { ConnectionSubscriptions, type SessionSubscriptions } from "./subscriptions.ts";

const SERVER_CAPABILITIES = [
	"archive.v1",
	"recovery.v1",
	"models.v1",
	"profile.v1",
	"schedules.v2",
	"session.cursor.v1",
	"sessions.v1",
	"agents.v1",
	"thinkingSelection.v1",
	"turns.v1",
] as const;

function protocolErrorName(error: ProtocolValidationError): RpcErrorName {
	switch (error.kind) {
		case "parse":
			return "PARSE_ERROR";
		case "invalid_request":
			return "INVALID_REQUEST";
		case "method_not_found":
			return "METHOD_NOT_FOUND";
		case "invalid_params":
			return "INVALID_PARAMS";
		case "invalid_response":
			return "INTERNAL";
	}
}

function safeEnvelopeId(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, "id");
		const id = descriptor && "value" in descriptor ? descriptor.value : undefined;
		return typeof id === "string" && id.length >= 1 && id.length <= 128 ? id : null;
	} catch {
		return null;
	}
}

function requestContext(request: ClientRpcRequest): RpcErrorContext {
	const params = request.params as Record<string, unknown>;
	return {
		...(typeof params.requestId === "string" ? { requestId: params.requestId } : {}),
		...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
	};
}

function normalizedError(error: unknown): { name: RpcErrorName; context: RpcErrorContext } {
	if (error instanceof AppServerError) return { name: error.code, context: error.context };
	if (error instanceof ProtocolValidationError) return { name: protocolErrorName(error), context: {} };
	if (typeof error === "object" && error !== null) {
		const code = "code" in error ? String(error.code) : undefined;
		if (code === "REQUEST_ID_REUSED") return { name: "REQUEST_ID_REUSED", context: {} };
		if (code === "TASK_ID_REUSED" || code === "RUN_ID_REUSED") {
			return { name: "REQUEST_ID_REUSED", context: {} };
		}
		if (code === "SCHEDULE_NOT_FOUND" || code === "RUN_NOT_FOUND") return { name: "NOT_FOUND", context: {} };
		if (code === "TASK_BUSY" || code === "TASK_DELETING") return { name: "BUSY", context: {} };
		if (code === "INVALID_SCHEDULE") return { name: "INVALID_PARAMS", context: {} };
		if (code === "MODEL_UNAVAILABLE") return { name: "INVALID_PARAMS", context: {} };
		if (code === "STORE_CORRUPT") return { name: "SCHEDULE_STORE_CORRUPT", context: {} };
		if (code === "SESSION_IN_USE" || ("name" in error && error.name === "SessionLeaseError")) {
			return { name: "SESSION_IN_USE", context: {} };
		}
	}
	return { name: "OPERATION_FAILED", context: {} };
}

export interface ConnectionOptions {
	readonly dispatcher: Dispatcher;
	readonly serverEpoch: string;
	readonly serverVersion: string;
	readonly subscriptionHub: SessionSubscriptions;
	readonly outboundQueueLimits?: OutboundQueueLimits;
	readonly onClose?: (connection: AppServerConnection) => void;
}

export type ConnectionOutboundEnvelope =
	| OutboundEnvelope
	| ServerRpcNotification<"browser/tool/cancelled" | "interaction/cancelled">
	| ServerRpcRequest;
export type ConnectionOutboundSender = (envelope: ConnectionOutboundEnvelope) => Promise<void> | void;

interface PendingServerRequest {
	readonly request: ServerRpcRequest;
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
}

function serverRequestContext(request: ServerRpcRequest): RpcErrorContext {
	if (request.method === "interaction/request") {
		return {
			interactionId: request.params.interaction.interactionId,
			sessionId: request.params.interaction.sessionId,
		};
	}
	return { sessionId: (request as ServerRpcRequest<"browser/tool">).params.sessionId };
}

function cancelledRequestError(request: ServerRpcRequest): AppServerError {
	return new AppServerError(
		request.method === "interaction/request" ? "INTERACTION_CANCELLED" : "OPERATION_FAILED",
		serverRequestContext(request),
	);
}

/** One independently initialized client connection. */
export class AppServerConnection {
	private readonly options: ConnectionOptions;
	private readonly outbound: OutboundQueue;
	private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
	private sender?: ConnectionOutboundSender;
	private initialized = false;
	private closed = false;
	readonly state: ConnectionState;

	get isClosed(): boolean {
		return this.closed;
	}

	constructor(options: ConnectionOptions) {
		this.options = options;
		this.outbound = new OutboundQueue({
			serverEpoch: options.serverEpoch,
			...options.outboundQueueLimits,
			onTerminal: () => this.close(),
		});
		this.state = {
			subscriptions: new ConnectionSubscriptions(options.subscriptionHub, this.outbound),
			interactionPeer: this,
		};
	}

	onMessage(sender: ConnectionOutboundSender): () => void {
		if (this.sender && this.sender !== sender) throw new TypeError("An outbound sender is already attached");
		this.sender = sender;
		const detachOutbound = this.outbound.setSender(sender);
		return () => {
			detachOutbound();
			if (this.sender === sender) {
				this.sender = undefined;
				this.rejectPendingServerRequests();
			}
		};
	}

	request<Method extends ServerRequestMethod>(
		requestValue: ServerRpcRequest<Method>,
		signal: AbortSignal,
	): Promise<ServerResult<Method>>;
	request(requestValue: ServerRpcRequest, signal: AbortSignal): Promise<ServerResult<ServerRequestMethod>> {
		if (this.closed || !this.initialized || !this.sender) {
			return Promise.reject(cancelledRequestError(requestValue));
		}
		if (this.pendingServerRequests.size >= 128) {
			return Promise.reject(new AppServerError("OVERLOADED", serverRequestContext(requestValue)));
		}
		let request: ServerRpcRequest;
		try {
			request = validateServerRequest(requestValue);
			if (request.params.serverEpoch !== this.options.serverEpoch) throw new Error("Server request epoch mismatch");
		} catch {
			return Promise.reject(new AppServerError("INVALID_REQUEST"));
		}
		if (this.pendingServerRequests.has(request.id)) {
			return Promise.reject(new AppServerError("INVALID_REQUEST", serverRequestContext(request)));
		}

		return new Promise<ServerResult<ServerRequestMethod>>((resolve, reject) => {
			const onAbort = () => {
				if (request.method === "browser/tool" && this.sender) {
					const browserRequest = request as ServerRpcRequest<"browser/tool">;
					const notification = validateServerNotification({
						jsonrpc: "2.0",
						method: "browser/tool/cancelled",
						params: {
							serverEpoch: browserRequest.params.serverEpoch,
							sessionId: browserRequest.params.sessionId,
							toolCallId: browserRequest.params.toolCallId,
							requestId: request.id,
						},
					});
					void Promise.resolve(this.sender(notification)).catch(() => undefined);
				}
				if (request.method === "interaction/request" && this.sender) {
					const interactionRequest = request as ServerRpcRequest<"interaction/request">;
					const notification = validateServerNotification({
						jsonrpc: "2.0",
						method: "interaction/cancelled",
						params: {
							serverEpoch: interactionRequest.params.serverEpoch,
							sessionId: interactionRequest.params.interaction.sessionId,
							interactionId: interactionRequest.params.interaction.interactionId,
							requestId: request.id,
						},
					});
					void Promise.resolve(this.sender(notification)).catch(() => undefined);
				}

				const pending = this.takePendingServerRequest(request.id);
				pending?.reject(cancelledRequestError(request));
			};
			const pending: PendingServerRequest = {
				request,
				signal,
				onAbort,
				resolve: (result) => resolve(result as ServerResult<ServerRequestMethod>),
				reject,
			};
			this.pendingServerRequests.set(request.id, pending);
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			Promise.resolve(this.sender!(request)).catch((error) => {
				const failed = this.takePendingServerRequest(request.id);
				failed?.reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	handleServerResponse(value: unknown): boolean {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		if (!Object.hasOwn(record, "result") && !Object.hasOwn(record, "error")) return false;
		if (typeof record.id !== "string") return true;
		const pending = this.takePendingServerRequest(record.id);
		if (!pending) return true;
		try {
			const response = validateResponseFor("server", pending.request, value) as
				| ServerRpcSuccessResponse
				| RpcErrorResponse;
			if ("error" in response) {
				const name = rpcErrorNameForCode(response.error.code) ?? "OPERATION_FAILED";
				pending.reject(new AppServerError(name, "data" in response.error ? response.error.data : {}));
			} else {
				pending.resolve(response.result);
			}
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return true;
	}

	private takePendingServerRequest(id: string): PendingServerRequest | undefined {
		const pending = this.pendingServerRequests.get(id);
		if (!pending) return undefined;
		this.pendingServerRequests.delete(id);
		pending.signal.removeEventListener("abort", pending.onAbort);
		return pending;
	}

	private rejectPendingServerRequests(): void {
		for (const id of [...this.pendingServerRequests.keys()]) {
			const pending = this.takePendingServerRequest(id);
			if (pending) pending.reject(cancelledRequestError(pending.request));
		}
	}

	getOutboundStats(): ReturnType<OutboundQueue["getStats"]> {
		return this.outbound.getStats();
	}

	getTerminalError(): ReturnType<OutboundQueue["getTerminalError"]> {
		return this.outbound.getTerminalError();
	}

	private errorResponse(
		request: ClientRpcRequest,
		name: RpcErrorName,
		context: RpcErrorContext = {},
	): RpcErrorResponse {
		const response: RpcErrorResponse = {
			jsonrpc: "2.0",
			id: request.id,
			error: createRpcError(name, { ...requestContext(request), ...context }),
		};
		return validateResponseFor("client", request, response) as RpcErrorResponse;
	}

	async handle(value: unknown): Promise<ClientRpcSuccessResponse | RpcErrorResponse> {
		let request: ClientRpcRequest;
		try {
			request = validateClientRequest(value);
		} catch (error) {
			const normalized = normalizedError(error);
			return {
				jsonrpc: "2.0",
				id: safeEnvelopeId(value),
				error: createRpcError(normalized.name, normalized.context),
			};
		}

		if (this.closed) return this.errorResponse(request, "BUSY");
		if (!this.initialized && request.method !== "initialize") {
			return this.errorResponse(request, "NOT_INITIALIZED");
		}
		if (request.method === "initialize") {
			if (this.initialized) return this.errorResponse(request, "INVALID_REQUEST");
			if (request.params.protocolVersion !== PROTOCOL_VERSION) {
				return this.errorResponse(request, "PROTOCOL_MISMATCH");
			}
			const response: ClientRpcSuccessResponse<"initialize"> = {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: PROTOCOL_VERSION,
					server: { name: "metis-app-server", version: this.options.serverVersion },
					serverEpoch: this.options.serverEpoch,
					capabilities: [...SERVER_CAPABILITIES],
				},
			};
			validateResponseFor("client", request, response);
			this.initialized = true;
			return response;
		}

		try {
			const response = {
				jsonrpc: "2.0",
				id: request.id,
				result: await this.options.dispatcher.dispatch(request, this.state),
			} as const;
			return validateResponseFor("client", request, response) as ClientRpcSuccessResponse;
		} catch (error) {
			const normalized = normalizedError(error);
			return this.errorResponse(request, normalized.name, normalized.context);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.sender = undefined;
		this.rejectPendingServerRequests();
		this.state.subscriptions.close();
		this.outbound.close();
		this.options.onClose?.(this);
	}
}
