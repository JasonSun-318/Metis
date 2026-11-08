import { createRpcError, ProtocolValidationError, type RpcErrorResponse } from "@metis/app-protocol";
import type { AppServer } from "../app-server.ts";

export interface TransportHandlers {
	onEnvelope(envelope: unknown): Promise<void> | void;
	onInvalidFrame(error: ProtocolValidationError): Promise<void> | void;
	onDisconnect(): Promise<void> | void;
}

/** A framed, ordered, peer-owned connection with no session logic. */
export interface TransportConnection {
	start(handlers: TransportHandlers): void;
	send(envelope: unknown): Promise<void>;
	close(): Promise<void>;
}

export interface AppServerTransportBinding {
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

function invalidFrameResponse(error: ProtocolValidationError): RpcErrorResponse {
	return {
		jsonrpc: "2.0",
		id: null,
		error: createRpcError(error.kind === "parse" ? "PARSE_ERROR" : "INVALID_REQUEST"),
	};
}

function isShutdownRequest(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, "method");
	return descriptor !== undefined && "value" in descriptor && descriptor.value === "server/shutdown";
}

function isInitializeRequest(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, "method");
	return descriptor !== undefined && "value" in descriptor && descriptor.value === "initialize";
}

const ENVELOPE_TOO_LARGE_MESSAGE = "Protocol envelope exceeds the 8 MiB limit";

function isEnvelopeTooLargeError(error: unknown): boolean {
	return error instanceof ProtocolValidationError && error.message === ENVELOPE_TOO_LARGE_MESSAGE;
}

function requestIdOf(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const descriptor = Object.getOwnPropertyDescriptor(value, "id");
	if (!descriptor || !("value" in descriptor)) return null;
	const id = descriptor.value;
	return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * A response that cannot fit in one transport envelope is a per-request
 * failure, not a transport failure. Returning a correlated error keeps the
 * connection and every other session on the server alive.
 */
function oversizedResponseError(request: unknown): RpcErrorResponse | undefined {
	const id = requestIdOf(request);
	if (id === null) return undefined;
	// Protocol errors use fixed messages, so this reuses the non-retryable
	// OPERATION_FAILED code instead of adding a wire-contract error code.
	return { jsonrpc: "2.0", id, error: createRpcError("OPERATION_FAILED") };
}

function isConnectionAckRequest(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, "method");
	return descriptor !== undefined && "value" in descriptor && descriptor.value === "connection/ack";
}

/** Connects protocol framing to one app-server client connection. */
export function bindAppServerTransport(server: AppServer, transport: TransportConnection): AppServerTransportBinding {
	let connection = server.connect();
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let closePromise: Promise<void> | undefined;
	let requestTail = Promise.resolve();
	let controlTail = Promise.resolve();
	let detachOutbound = connection.onMessage((envelope) => transport.send(envelope));

	const close = (): Promise<void> => {
		if (!closePromise) {
			closePromise = (async () => {
				detachOutbound();
				connection.close();
				server.beginShutdown();
				try {
					await server.waitForShutdown();
				} finally {
					try {
						await transport.close();
					} finally {
						resolveClosed();
					}
				}
			})();
		}
		return closePromise;
	};

	const processRequest = async (envelope: unknown): Promise<void> => {
		if (isInitializeRequest(envelope) && connection.isClosed) {
			detachOutbound();
			connection = server.connect();
			detachOutbound = connection.onMessage((message) => transport.send(message));
		}
		if (!isShutdownRequest(envelope)) {
			const response = await connection.handle(envelope);
			try {
				await transport.send(response);
			} catch (error) {
				if (!isEnvelopeTooLargeError(error)) throw error;
				const fallback = oversizedResponseError(envelope);
				if (fallback === undefined) throw error;
				await transport.send(fallback);
			}
			return;
		}
		await transport.send(await server.handleHost(envelope));
		await close();
	};

	const enqueueRequest = (envelope: unknown): void => {
		if (isConnectionAckRequest(envelope)) {
			controlTail = controlTail.then(() => processRequest(envelope));
			void controlTail.catch(() => close()).catch(() => undefined);
			return;
		}

		requestTail = requestTail.then(() => processRequest(envelope));
		void requestTail.catch(() => close()).catch(() => undefined);
	};

	transport.start({
		onEnvelope: (envelope) => {
			if (connection.handleServerResponse(envelope)) return;
			enqueueRequest(envelope);
		},
		onInvalidFrame: async (error) => {
			await transport.send(invalidFrameResponse(error));
		},
		onDisconnect: close,
	});

	return { closed, close };
}
