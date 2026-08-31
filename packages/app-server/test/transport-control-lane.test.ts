import { describe, expect, it, vi } from "vitest";
import type { AppServer } from "../src/app-server.ts";
import {
	bindAppServerTransport,
	type TransportConnection,
	type TransportHandlers,
} from "../src/transport/transport.ts";

class TestTransport implements TransportConnection {
	private handlers?: TransportHandlers;
	readonly sent: unknown[] = [];

	start(handlers: TransportHandlers): void {
		this.handlers = handlers;
	}

	async send(envelope: unknown): Promise<void> {
		this.sent.push(envelope);
	}

	async close(): Promise<void> {}

	emit(envelope: unknown): void {
		void this.handlers?.onEnvelope(envelope);
	}
}

describe("app-server transport control lane", () => {
	it("processes connection acknowledgements while a normal request is pending", async () => {
		let releaseSlow!: () => void;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const connection = {
			isClosed: false,
			onMessage: () => () => undefined,
			close: vi.fn(),
			handleServerResponse: () => false,
			handle: vi.fn(async (envelope: { id: number; method: string }) => {
				if (envelope.method === "session/compact") await slow;
				return { jsonrpc: "2.0", id: envelope.id, result: {} };
			}),
		};
		const server = {
			connect: () => connection,
			beginShutdown: vi.fn(),
			waitForShutdown: async () => undefined,
			handleHost: vi.fn(),
		} as unknown as AppServer;
		const transport = new TestTransport();
		const binding = bindAppServerTransport(server, transport);

		transport.emit({ jsonrpc: "2.0", id: 1, method: "session/compact", params: {} });
		transport.emit({ jsonrpc: "2.0", id: 2, method: "connection/ack", params: { sequence: 1 } });

		await vi.waitFor(() => expect(transport.sent).toContainEqual(expect.objectContaining({ id: 2 })));
		expect(transport.sent).not.toContainEqual(expect.objectContaining({ id: 1 }));

		releaseSlow();
		await vi.waitFor(() => expect(transport.sent).toContainEqual(expect.objectContaining({ id: 1 })));
		await binding.close();
	});
});
