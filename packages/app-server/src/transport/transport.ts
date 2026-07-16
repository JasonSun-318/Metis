import { createRpcError, type ProtocolValidationError, type RpcErrorResponse } from "@arcmind/app-protocol";
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

/** Connects protocol framing to one app-server client connection. */
export function bindAppServerTransport(server: AppServer, transport: TransportConnection): AppServerTransportBinding {
	let connection = server.connect();
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	let closePromise: Promise<void> | undefined;
	let requestTail = Promise.resolve();
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

	const enqueueRequest = (envelope: unknown): void => {
		requestTail = requestTail.then(async () => {
			if (isInitializeRequest(envelope) && connection.isClosed) {
				detachOutbound();
				connection = server.connect();
				detachOutbound = connection.onMessage((message) => transport.send(message));
			}
			if (!isShutdownRequest(envelope)) {
				await transport.send(await connection.handle(envelope));
				return;
			}
			await transport.send(await server.handleHost(envelope));
			await close();
		});
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
