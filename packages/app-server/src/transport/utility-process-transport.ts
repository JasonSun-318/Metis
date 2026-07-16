import { assertEnvelopeByteLimit, ProtocolValidationError } from "@arcmind/app-protocol";
import type { TransportConnection, TransportHandlers } from "./transport.ts";

export interface UtilityParentPort {
	on(event: "message", listener: (event: { readonly data: unknown }) => void): this;
	on(event: "close" | "disconnect", listener: () => void): this;
	off(event: "message", listener: (event: { readonly data: unknown }) => void): this;
	off(event: "close" | "disconnect", listener: () => void): this;
	postMessage(message: unknown): Promise<void> | void;
	close?(): void;
}

export function requireUtilityParentPort(processValue: {
	readonly parentPort?: UtilityParentPort | null;
}): UtilityParentPort {
	const port = processValue.parentPort;
	if (!port) throw new Error("ArcMind utility entry requires Electron process.parentPort");
	return port;
}

/** Structured-clone transport for Electron's utility-process parentPort. */
export class UtilityProcessTransport implements TransportConnection {
	private readonly port: UtilityParentPort;
	private handlers?: TransportHandlers;
	private inboundTail = Promise.resolve();
	private outboundTail = Promise.resolve();
	private started = false;
	private closed = false;
	private disconnectQueued = false;

	constructor(port: UtilityParentPort) {
		this.port = port;
	}

	private readonly onMessage = (event: { readonly data: unknown }): void => {
		this.enqueue(async () => {
			try {
				assertEnvelopeByteLimit(event.data);
				await this.handlers?.onEnvelope(event.data);
			} catch (error) {
				if (error instanceof ProtocolValidationError) {
					await this.handlers?.onInvalidFrame(error);
					return;
				}
				throw error;
			}
		});
	};

	private readonly onDisconnect = (): void => {
		this.queueDisconnect();
	};

	start(handlers: TransportHandlers): void {
		if (this.started) throw new TypeError("Utility-process transport has already started");
		if (this.closed) throw new TypeError("Utility-process transport is closed");
		this.started = true;
		this.handlers = handlers;
		this.port.on("message", this.onMessage);
		// Electron currently documents only `message`; these defensive listeners
		// also support explicit close signals from test and future parent-port APIs.
		this.port.on("close", this.onDisconnect);
		this.port.on("disconnect", this.onDisconnect);
	}

	private enqueue(task: () => Promise<void> | void): void {
		this.inboundTail = this.inboundTail.then(task).catch(async () => {
			if (this.disconnectQueued) return;
			this.disconnectQueued = true;
			await this.handlers?.onDisconnect();
		});
	}

	private queueDisconnect(): void {
		if (this.disconnectQueued) return;
		this.disconnectQueued = true;
		this.enqueue(async () => await this.handlers?.onDisconnect());
	}

	async send(envelope: unknown): Promise<void> {
		if (!this.started || this.closed) throw new Error("Utility-process transport is not open");
		assertEnvelopeByteLimit(envelope);
		const message = structuredClone(envelope);
		this.outboundTail = this.outboundTail.then(async () => await this.port.postMessage(message));
		try {
			await this.outboundTail;
		} catch (error) {
			this.queueDisconnect();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.port.off("message", this.onMessage);
		this.port.off("close", this.onDisconnect);
		this.port.off("disconnect", this.onDisconnect);
		await this.outboundTail.catch(() => undefined);
		this.port.close?.();
	}
}
