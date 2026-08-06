import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { MAX_ENVELOPE_UTF8_BYTES, RPC_ERROR_CODES } from "@arcmind/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import { StdioTransport } from "../src/transport/stdio-transport.ts";
import { bindAppServerTransport } from "../src/transport/transport.ts";
import { runTransportConformance, type TransportConformanceHarness } from "./transport-conformance.ts";

class ControlledOutput extends Writable {
	readonly envelopes: unknown[] = [];
	private block = false;
	private fail = false;
	private started?: () => void;
	private pending?: () => void;

	blockNext(): { readonly started: Promise<void>; release(): void } {
		this.block = true;
		const started = new Promise<void>((resolve) => {
			this.started = resolve;
		});
		return {
			started,
			release: () => {
				this.pending?.();
				this.pending = undefined;
			},
		};
	}

	failNext(): void {
		this.fail = true;
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		const lines = chunk.toString("utf8").split("\n");
		for (const line of lines) {
			if (line.length > 0) this.envelopes.push(JSON.parse(line));
		}
		if (this.fail) {
			this.fail = false;
			callback(new Error("simulated output failure"));
			return;
		}
		if (this.block) {
			this.block = false;
			this.pending = callback;
			this.started?.();
			this.started = undefined;
			return;
		}
		callback();
	}
}

function createHarness(): TransportConformanceHarness {
	const input = new PassThrough();
	const output = new ControlledOutput();
	const transport = new StdioTransport(input, output);
	let ended = false;
	return {
		transport,
		peerSend: (value) => {
			input.write(`${JSON.stringify(value)}\n`);
		},
		peerMalformed: () => {
			input.write("{}\r\n");
		},
		peerOversized: () => {
			input.write(Buffer.alloc(MAX_ENVELOPE_UTF8_BYTES + 1, 0x20));
			input.write("\n");
		},
		peerDisconnect: () => {
			if (ended) return;
			ended = true;
			input.end();
		},
		sent: () => output.envelopes,
		blockNextSend: () => output.blockNext(),
		failNextSend: () => output.failNext(),
		bindAppServer: async () => {
			const directory = mkdtempSync(join(tmpdir(), "stdio-conformance-"));
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

runTransportConformance("stdio", createHarness);

describe("stdio app-server binding", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("enforces initialize-first and shuts down cleanly on EOF", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "stdio-transport-"));
		const server = await AppServer.create({ agentDir: tempDir });
		const input = new PassThrough();
		const output = new ControlledOutput();
		const binding = bindAppServerTransport(server, new StdioTransport(input, output));
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} })}\n`);
		input.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 10, client: { name: "stdio-test", version: "1" }, capabilities: [] },
			})}\n`,
		);
		await vi.waitFor(() => expect(output.envelopes).toHaveLength(2));
		expect(output.envelopes[0]).toMatchObject({ error: { data: { name: "NOT_INITIALIZED" } } });
		expect(output.envelopes[1]).toMatchObject({ result: { protocolVersion: 10 } });

		input.end();
		await binding.closed;
		await expect(server.waitForShutdown()).resolves.toBeUndefined();
	});

	it("returns PARSE_ERROR for malformed JSON and continues with the next frame", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "stdio-parse-"));
		const server = await AppServer.create({ agentDir: tempDir });
		const input = new PassThrough();
		const output = new ControlledOutput();
		const binding = bindAppServerTransport(server, new StdioTransport(input, output));
		input.write("{not-json}\n");
		input.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 10, client: { name: "stdio-test", version: "1" }, capabilities: [] },
			})}\n`,
		);
		await vi.waitFor(() => expect(output.envelopes).toHaveLength(2));
		expect(output.envelopes[0]).toMatchObject({ error: { code: RPC_ERROR_CODES.PARSE_ERROR } });
		expect(output.envelopes[1]).toMatchObject({ result: { protocolVersion: 10 } });
		input.end();
		await binding.closed;
	});

	it("replays a journal-completed create after an app-server restart over stdio", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "stdio-restart-"));
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		const changedProjectDir = join(tempDir, "changed-project");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(changedProjectDir, { recursive: true });
		const requestId = "00000000-0000-4000-8000-000000000101";
		const initialize = {
			jsonrpc: "2.0",
			id: "initialize",
			method: "initialize",
			params: { protocolVersion: 10, client: { name: "stdio-restart", version: "1" }, capabilities: [] },
		};
		const create = {
			jsonrpc: "2.0",
			id: "create",
			method: "session/create",
			params: { requestId, cwd: projectDir, name: "restart proof" },
		};

		const run = async (frames: readonly unknown[]): Promise<unknown[]> => {
			const server = await AppServer.create({ agentDir });
			const input = new PassThrough();
			const output = new ControlledOutput();
			const binding = bindAppServerTransport(server, new StdioTransport(input, output));
			for (const frame of frames) input.write(`${JSON.stringify(frame)}\n`);
			await vi.waitFor(() => expect(output.envelopes).toHaveLength(frames.length));
			input.end();
			await binding.closed;
			return output.envelopes;
		};

		const first = await run([initialize, create]);
		expect(first[1]).toMatchObject({ result: { session: { sessionId: requestId, name: "restart proof" } } });
		const second = await run([
			{ ...initialize, id: "initialize-restarted" },
			{ ...create, id: "create-replay" },
			{ ...create, id: "create-reused", params: { ...create.params, cwd: changedProjectDir } },
		]);
		expect(second[1]).toMatchObject({ result: (first[1] as { result: unknown }).result });
		expect(second[2]).toMatchObject({ error: { code: RPC_ERROR_CODES.REQUEST_ID_REUSED } });
		const sessionFiles = readdirSync(agentDir, { recursive: true }).filter((path) => String(path).endsWith(".jsonl"));
		expect(sessionFiles).toHaveLength(1);
	});
});
