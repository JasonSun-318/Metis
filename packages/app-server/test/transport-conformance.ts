import { RPC_ERROR_CODES } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import type { TransportConnection, TransportHandlers } from "../src/transport/transport.ts";

export interface TransportConformanceHarness {
	readonly transport: TransportConnection;
	peerSend(value: unknown): void;
	peerMalformed(): void;
	peerOversized(): void;
	peerDisconnect(): void;
	sent(): readonly unknown[];
	blockNextSend(): { readonly started: Promise<void>; release(): void };
	failNextSend(): void;
	bindAppServer(): Promise<{ close(): Promise<void> }>;
}

function noopHandlers(overrides: Partial<TransportHandlers> = {}): TransportHandlers {
	return {
		onEnvelope: () => undefined,
		onInvalidFrame: () => undefined,
		onDisconnect: () => undefined,
		...overrides,
	};
}

export function runTransportConformance(name: string, createHarness: () => TransportConformanceHarness): void {
	describe(`${name} transport conformance`, () => {
		it("enforces initialize-first through the shared app-server core", async () => {
			const harness = createHarness();
			const binding = await harness.bindAppServer();
			harness.peerSend({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} });
			harness.peerSend({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 17, client: { name: "conformance", version: "1" }, capabilities: [] },
			});
			await vi.waitFor(() => expect(harness.sent()).toHaveLength(2));
			expect(harness.sent()[0]).toMatchObject({ error: { code: RPC_ERROR_CODES.NOT_INITIALIZED } });
			expect(harness.sent()[1]).toMatchObject({ result: { protocolVersion: 17 } });
			await binding.close();
		});

		it("delivers inbound envelopes in order even when the first handler yields", async () => {
			const harness = createHarness();
			const seen: unknown[] = [];
			let release!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			harness.transport.start(
				noopHandlers({
					onEnvelope: async (value) => {
						seen.push(value);
						if (seen.length === 1) await blocked;
					},
				}),
			);
			harness.peerSend({ sequence: 1 });
			harness.peerSend({ sequence: 2 });
			await vi.waitFor(() => expect(seen).toEqual([{ sequence: 1 }]));
			release();
			await vi.waitFor(() => expect(seen).toEqual([{ sequence: 1 }, { sequence: 2 }]));
			await harness.transport.close();
		});

		it("rejects malformed and oversized frames without delivering them", async () => {
			const harness = createHarness();
			const envelopes: unknown[] = [];
			const invalid: string[] = [];
			harness.transport.start(
				noopHandlers({
					onEnvelope: (value) => {
						envelopes.push(value);
					},
					onInvalidFrame: (error) => {
						invalid.push(error.kind);
					},
				}),
			);
			harness.peerMalformed();
			harness.peerOversized();
			await vi.waitFor(() => expect(invalid).toHaveLength(2));
			expect(envelopes).toEqual([]);
			await harness.transport.close();
		});

		it("serializes outbound server envelopes behind a slow write", async () => {
			const harness = createHarness();
			harness.transport.start(noopHandlers());
			const gate = harness.blockNextSend();
			const firstEnvelope = { jsonrpc: "2.0", id: "server-request", method: "example/request", params: {} };
			const secondEnvelope = { jsonrpc: "2.0", id: "server-response", result: { accepted: true } };
			const first = harness.transport.send(firstEnvelope);
			const second = harness.transport.send(secondEnvelope);
			await gate.started;
			expect(harness.sent()).toEqual([firstEnvelope]);
			gate.release();
			await Promise.all([first, second]);
			expect(harness.sent()).toEqual([firstEnvelope, secondEnvelope]);
			await harness.transport.close();
		});

		it("passes server responses through as direction-neutral structured envelopes", async () => {
			const harness = createHarness();
			const seen: unknown[] = [];
			harness.transport.start(
				noopHandlers({
					onEnvelope: (value) => {
						seen.push(value);
					},
				}),
			);
			const response = { jsonrpc: "2.0", id: "interaction", result: { confirmed: true } };
			harness.peerSend(response);
			await vi.waitFor(() => expect(seen).toEqual([response]));
			await harness.transport.close();
		});

		it("reports peer disconnect once and closes idempotently", async () => {
			const harness = createHarness();
			const disconnected = vi.fn();
			harness.transport.start(noopHandlers({ onDisconnect: disconnected }));
			harness.peerDisconnect();
			harness.peerDisconnect();
			await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
			await harness.transport.close();
			await harness.transport.close();
		});

		it("turns an outbound delivery failure into peer disconnect", async () => {
			const harness = createHarness();
			const disconnected = vi.fn();
			harness.transport.start(noopHandlers({ onDisconnect: disconnected }));
			harness.failNextSend();
			await expect(harness.transport.send({ jsonrpc: "2.0", id: "failed", result: {} })).rejects.toThrow();
			await vi.waitFor(() => expect(disconnected).toHaveBeenCalledTimes(1));
			await harness.transport.close();
		});
	});
}
