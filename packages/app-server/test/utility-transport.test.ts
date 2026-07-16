import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENVELOPE_UTF8_BYTES, RPC_ERROR_CODES, type ServerRpcRequest } from "@arcmind/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import { bindAppServerTransport } from "../src/transport/transport.ts";
import {
	requireUtilityParentPort,
	type UtilityParentPort,
	UtilityProcessTransport,
} from "../src/transport/utility-process-transport.ts";
import { runTransportConformance, type TransportConformanceHarness } from "./transport-conformance.ts";

class FakeParentPort extends EventEmitter implements UtilityParentPort {
	readonly sent: unknown[] = [];
	closed = false;
	private block = false;
	private fail = false;
	private started?: () => void;
	private releaseSend?: () => void;

	blockNext(): { readonly started: Promise<void>; release(): void } {
		this.block = true;
		const started = new Promise<void>((resolve) => {
			this.started = resolve;
		});
		return {
			started,
			release: () => {
				this.releaseSend?.();
				this.releaseSend = undefined;
			},
		};
	}

	failNext(): void {
		this.fail = true;
	}

	postMessage(message: unknown): Promise<void> | void {
		this.sent.push(structuredClone(message));
		if (this.fail) {
			this.fail = false;
			return Promise.reject(new Error("simulated parent-port failure"));
		}
		if (!this.block) return;
		this.block = false;
		this.started?.();
		this.started = undefined;
		return new Promise<void>((resolve) => {
			this.releaseSend = resolve;
		});
	}

	close(): void {
		this.closed = true;
	}
}

function createHarness(): TransportConformanceHarness {
	const port = new FakeParentPort();
	const transport = new UtilityProcessTransport(port);
	let disconnected = false;
	return {
		transport,
		peerSend: (value) => {
			port.emit("message", { data: structuredClone(value) });
		},
		peerMalformed: () => {
			port.emit("message", { data: new Date() });
		},
		peerOversized: () => {
			port.emit("message", { data: { payload: "x".repeat(MAX_ENVELOPE_UTF8_BYTES) } });
		},
		peerDisconnect: () => {
			if (disconnected) return;
			disconnected = true;
			port.emit("close");
		},
		sent: () => port.sent,
		blockNextSend: () => port.blockNext(),
		failNextSend: () => port.failNext(),
		bindAppServer: async () => {
			const directory = mkdtempSync(join(tmpdir(), "utility-conformance-"));
			const server = await AppServer.create({ agentDir: directory });
			const binding = bindAppServerTransport(server, transport);
			return {
				close: async () => {
					await binding.close();
					rmSync(directory, { recursive: true, force: true });
				},
			};
		},
	};
}

runTransportConformance("utility-process", createHarness);

describe("utility-process app-server binding", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("refuses to start without an Electron parent port", () => {
		expect(() => requireUtilityParentPort({ ...process, parentPort: null })).toThrow("requires Electron");
	});

	it("serves initialize and shuts down when the parent port closes", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "utility-transport-"));
		const server = await AppServer.create({ agentDir: tempDir });
		const port = new FakeParentPort();
		const binding = bindAppServerTransport(server, new UtilityProcessTransport(port));
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 1, client: { name: "utility-test", version: "1" }, capabilities: [] },
			},
		});
		await vi.waitFor(() => expect(port.sent).toHaveLength(1));
		expect(port.sent[0]).toMatchObject({ result: { protocolVersion: 1 } });

		port.emit("close");
		await binding.closed;
		expect(port.closed).toBe(true);
		await expect(server.waitForShutdown()).resolves.toBeUndefined();
	});

	it("acknowledges the supervisor-owned shutdown request before closing", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "utility-shutdown-"));
		const server = await AppServer.create({ agentDir: tempDir });
		const port = new FakeParentPort();
		const binding = bindAppServerTransport(server, new UtilityProcessTransport(port));
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: "shutdown",
				method: "server/shutdown",
				params: {
					requestId: "11111111-1111-4111-8111-111111111111",
					reason: "test",
				},
			},
		});

		await binding.closed;
		expect(port.sent).toEqual([{ jsonrpc: "2.0", id: "shutdown", result: { accepted: true } }]);
		expect(port.closed).toBe(true);
		await expect(server.waitForShutdown()).resolves.toBeUndefined();
	});

	it("rejects unsafe structured-clone input and continues with initialize", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "utility-invalid-"));
		const server = await AppServer.create({ agentDir: tempDir });
		const port = new FakeParentPort();
		const binding = bindAppServerTransport(server, new UtilityProcessTransport(port));
		port.emit("message", { data: new Map() });
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 1, client: { name: "utility-test", version: "1" }, capabilities: [] },
			},
		});
		await vi.waitFor(() => expect(port.sent).toHaveLength(2));
		expect(port.sent[0]).toMatchObject({ error: { code: RPC_ERROR_CODES.INVALID_REQUEST } });
		expect(port.sent[1]).toMatchObject({ result: { protocolVersion: 1 } });
		port.emit("close");
		await binding.closed;
	});

	it("delivers an interaction response while its originating request is still open", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "utility-interaction-"));
		const projectDir = join(tempDir, "project");
		const extensionDir = join(projectDir, ".arcmind", "extensions");
		mkdirSync(extensionDir, { recursive: true });
		writeFileSync(
			join(extensionDir, "confirm.ts"),
			`export default function (arcmind) {
				arcmind.on("session_start", async (_event, ctx) => {
					await ctx.ui.confirm("Extension loaded", "Confirm the packaged interaction path.");
				});
			}
`,
		);
		const server = await AppServer.create({ agentDir: join(tempDir, "agent") });
		const port = new FakeParentPort();
		const binding = bindAppServerTransport(server, new UtilityProcessTransport(port));
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 1, client: { name: "utility-test", version: "1" }, capabilities: [] },
			},
		});
		await vi.waitFor(() => expect(port.sent).toHaveLength(1));
		const sessionId = "11111111-1111-4111-8111-111111111111";
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: "create",
				method: "session/create",
				params: { requestId: sessionId, cwd: projectDir },
			},
		});
		await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ id: "create" })));

		port.emit("message", {
			data: { jsonrpc: "2.0", id: "open", method: "session/open", params: { sessionId } },
		});
		await vi.waitFor(() =>
			expect(port.sent).toContainEqual(
				expect.objectContaining({
					method: "interaction/request",
					params: expect.objectContaining({
						interaction: expect.objectContaining({ kind: "project_trust" }),
					}),
				}),
			),
		);
		const trustRequest = port.sent.find(
			(message): message is ServerRpcRequest =>
				typeof message === "object" &&
				message !== null &&
				"method" in message &&
				message.method === "interaction/request" &&
				(message as ServerRpcRequest).params.interaction.kind === "project_trust",
		);
		if (!trustRequest || trustRequest.params.interaction.kind !== "project_trust") {
			throw new Error("Missing project trust request");
		}
		const choice = trustRequest.params.interaction.choices.find((candidate) =>
			candidate.label.startsWith("Trust (this session only)"),
		);
		if (!choice) throw new Error("Missing session-only trust choice");
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: trustRequest.id,
				result: {
					interactionId: trustRequest.params.interaction.interactionId,
					kind: "project_trust",
					choiceId: choice.id,
				},
			},
		});

		await vi.waitFor(() =>
			expect(port.sent).toContainEqual(
				expect.objectContaining({
					method: "interaction/request",
					params: expect.objectContaining({ interaction: expect.objectContaining({ kind: "confirm" }) }),
				}),
			),
		);
		const confirmRequest = port.sent.find(
			(message): message is ServerRpcRequest =>
				typeof message === "object" &&
				message !== null &&
				"method" in message &&
				message.method === "interaction/request" &&
				(message as ServerRpcRequest).params.interaction.kind === "confirm",
		);
		if (!confirmRequest || confirmRequest.params.interaction.kind !== "confirm") {
			throw new Error("Missing extension confirmation request");
		}
		port.emit("message", {
			data: {
				jsonrpc: "2.0",
				id: confirmRequest.id,
				result: {
					interactionId: confirmRequest.params.interaction.interactionId,
					kind: "confirm",
					confirmed: true,
				},
			},
		});
		await vi.waitFor(() =>
			expect(
				port.sent.some(
					(message) => typeof message === "object" && message !== null && "id" in message && message.id === "open",
				),
			).toBe(true),
		);

		await binding.close();
	});
});
