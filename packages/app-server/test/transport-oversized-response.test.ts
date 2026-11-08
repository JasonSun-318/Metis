import { assertEnvelopeByteLimit, validateUncorrelatedErrorResponse } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import type { AppServer } from "../src/app-server.ts";
import {
	bindAppServerTransport,
	type TransportConnection,
	type TransportHandlers,
} from "../src/transport/transport.ts";

class LimitedTransport implements TransportConnection {
	readonly sent: unknown[] = [];
	private handlers?: TransportHandlers;

	start(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async send(envelope: unknown): Promise<void> {
		assertEnvelopeByteLimit(envelope);
		this.sent.push(envelope);
	}

	async close(): Promise<void> {}

	emit(envelope: unknown): void {
		void this.handlers?.onEnvelope(envelope);
	}
}

class ControllableTransport implements TransportConnection {
	readonly sent: unknown[] = [];
	failNext: Error | undefined;
	private handlers?: TransportHandlers;

	start(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async send(envelope: unknown): Promise<void> {
		if (this.failNext) {
			const error = this.failNext;
			this.failNext = undefined;
			throw error;
		}
		this.sent.push(envelope);
	}

	async close(): Promise<void> {}

	emit(envelope: unknown): void {
		void this.handlers?.onEnvelope(envelope);
	}
}

function fakeServer(handle: (envelope: { id: string }) => Promise<unknown>) {
	const connection = {
		isClosed: false,
		onMessage: () => () => undefined,
		close: vi.fn(),
		handleServerResponse: () => false,
		handle: vi.fn(handle),
	};
	const server = {
		connect: () => connection,
		beginShutdown: vi.fn(),
		waitForShutdown: async () => undefined,
		handleHost: vi.fn(),
	} as unknown as AppServer;
	return server;
}

describe("app-server transport oversized responses", () => {
	it("degrades an oversized response to a correlated error and keeps the connection alive", async () => {
		const server = fakeServer(async (envelope) => ({
			jsonrpc: "2.0",
			id: envelope.id,
			result: { data: "x".repeat(9 * 1024 * 1024) },
		}));
		const transport = new LimitedTransport();
		const binding = bindAppServerTransport(server, transport);

		transport.emit({ jsonrpc: "2.0", id: "req-1", method: "session/list", params: {} });
		await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
		const errorResponse = transport.sent[0] as { id: string; error: { code: number; message: string } };
		expect(errorResponse.id).toBe("req-1");
		expect(errorResponse.error.code).toBe(-32011);
		expect(errorResponse.error.message).toBe("Operation failed");
		expect(() => validateUncorrelatedErrorResponse(errorResponse)).not.toThrow();
		expect(server.beginShutdown).not.toHaveBeenCalled();

		transport.emit({ jsonrpc: "2.0", id: "req-2", method: "session/list", params: {} });
		await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
		expect((transport.sent[1] as { id: string }).id).toBe("req-2");
		await binding.close();
	});

	it("still shuts down the server on a genuine transport failure", async () => {
		const server = fakeServer(async (envelope) => ({ jsonrpc: "2.0", id: envelope.id, result: {} }));
		const transport = new ControllableTransport();
		transport.failNext = new Error("socket closed");
		bindAppServerTransport(server, transport);

		transport.emit({ jsonrpc: "2.0", id: "req-1", method: "session/list", params: {} });
		await vi.waitFor(() => expect(server.beginShutdown).toHaveBeenCalled());
	});
});
