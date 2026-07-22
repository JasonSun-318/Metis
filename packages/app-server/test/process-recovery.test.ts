import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientRpcRequest, HostRpcRequest, SessionSnapshot } from "@arcmind/app-protocol";
import { identifySubmitPromptRequest } from "@arcmind/coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-000000000201";
const TURN_ID = "00000000-0000-4000-8000-000000000202";
const fixture = join(import.meta.dirname, "fixtures", "process-server.ts");
const tsx = import.meta.resolve("tsx");
const crashPoints = [
	"accepted_only",
	"turn_start",
	"provider_start",
	"assistant_append",
	"tool_start",
	"tool_side_effect",
	"tool_result",
	"tool_complete",
	"operation_finish",
] as const;

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

class RpcProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exit: Promise<void>;
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
	private buffer = "";
	private stderr = "";

	constructor(agentDir: string, cwd: string, crashPoint?: string) {
		this.child = spawn(process.execPath, ["--import", tsx, fixture], {
			cwd,
			env: {
				...process.env,
				ARCMIND_CODING_AGENT_DIR: agentDir,
				ARCMIND_TEST_CRASH_POINT: crashPoint ?? "",
				HTTP_PROXY: "",
				HTTPS_PROXY: "",
				NO_PROXY: "127.0.0.1,localhost",
			},
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stdout.on("data", (chunk) => this.consume(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk;
		});
		this.exit = once(this.child, "exit").then(([code, signal]) => {
			const error = new Error(
				`App Server exited (code=${code ?? "none"}, signal=${signal ?? "none"}, pending=${
					[...this.pending.keys()].join(",") || "none"
				})\n${this.stderr}`,
			);
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
		});
	}

	request(request: ClientRpcRequest | HostRpcRequest): Promise<unknown> {
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
			this.child.stdin.write(`${JSON.stringify(request)}\n`);
		});
	}

	async stop(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const requestId = crypto.randomUUID();
		await this.request({
			jsonrpc: "2.0",
			id: requestId,
			method: "server/shutdown",
			params: { requestId, reason: "test_complete" },
		}).catch(() => undefined);
		this.child.stdin.end();
		await within(this.exit, "App Server shutdown", 2_000).catch(() => this.child.kill("SIGKILL"));
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const envelope = JSON.parse(line) as { id?: string };
			if (!envelope.id) continue;
			const pending = this.pending.get(envelope.id);
			if (!pending) continue;
			this.pending.delete(envelope.id);
			pending.resolve(envelope);
		}
	}
}

function request(id: string, method: ClientRpcRequest["method"], params: unknown): ClientRpcRequest {
	return { jsonrpc: "2.0", id, method, params } as ClientRpcRequest;
}

async function initialize(rpc: RpcProcess): Promise<void> {
	await rpc.request(
		request("initialize", "initialize", {
			protocolVersion: 3,
			client: { name: "process-recovery-test", version: "1" },
			capabilities: [],
		}),
	);
}

describe("real process recovery", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it.each(crashPoints)(
		"replays %s without repeating provider or tool work",
		async (crashPoint) => {
			const root = mkdtempSync(join(tmpdir(), `arcmind-process-recovery-${crashPoint}-`));
			roots.push(root);
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const extensionDir = join(projectDir, ".arcmind", "extensions");
			const sideEffects = join(root, "side-effects.txt");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(extensionDir, { recursive: true });

			let providerRequests = 0;
			let firstProcess: RpcProcess | undefined;
			const provider = createServer(async (incoming, response) => {
				for await (const _chunk of incoming) {
					// Drain the request before emitting a deterministic response.
				}
				providerRequests += 1;
				if (crashPoint === "provider_start" && providerRequests === 1) {
					firstProcess?.child.kill("SIGKILL");
					response.destroy();
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream" });
				const choice =
					providerRequests === 1
						? {
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "call-process-recovery",
											type: "function",
											function: { name: "crash_side_effect", arguments: "{}" },
										},
									],
								},
								finish_reason: "tool_calls",
							}
						: { index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" };
				response.end(
					`data: ${JSON.stringify({
						id: `chatcmpl-${providerRequests}`,
						object: "chat.completion.chunk",
						created: 1,
						model: "process-recovery-model",
						choices: [choice],
					})}\n\ndata: [DONE]\n\n`,
				);
			});
			provider.listen(0, "127.0.0.1");
			await once(provider, "listening");
			const address = provider.address();
			if (!address || typeof address === "string") throw new Error("Provider did not bind TCP");

			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						local: {
							baseUrl: `http://127.0.0.1:${address.port}/v1`,
							apiKey: "test-key",
							api: "openai-completions",
							models: [
								{ id: "process-recovery-model", name: "Recovery", contextWindow: 32_000, maxTokens: 1_024 },
							],
						},
					},
				}),
			);
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					defaultProvider: "local",
					defaultModel: "process-recovery-model",
					defaultProjectTrust: "always",
					retry: { enabled: false },
				}),
			);
			writeFileSync(
				join(extensionDir, "crash-tool.ts"),
				`import { appendFileSync } from "node:fs";
export default function (arcmind) {
	arcmind.registerTool({
		name: "crash_side_effect",
		label: "Crash side effect",
		description: "Records one test side effect",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => {
			appendFileSync(${JSON.stringify(sideEffects)}, "run\\n");
			if (process.env.ARCMIND_TEST_CRASH_POINT === "tool_side_effect") process.kill(process.pid, "SIGKILL");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
}
`,
			);

			try {
				firstProcess = new RpcProcess(agentDir, projectDir, crashPoint);
				await within(initialize(firstProcess), `${crashPoint}: initialize`);
				await within(
					firstProcess.request(request("create", "session/create", { requestId: SESSION_ID, cwd: projectDir })),
					`${crashPoint}: create`,
				);
				await within(
					firstProcess.request(request("open", "session/open", { sessionId: SESSION_ID })),
					`${crashPoint}: open`,
				);
				void firstProcess
					.request(request("turn", "turn/start", { sessionId: SESSION_ID, requestId: TURN_ID, text: "run" }))
					.catch(() => undefined);
				await within(firstProcess.exit, `${crashPoint}: crash`);

				const requestsBeforeRecovery = providerRequests;
				const effectsBeforeRecovery = readFileSync(sideEffects, { encoding: "utf8", flag: "a+" })
					.trim()
					.split("\n")
					.filter(Boolean).length;
				const recovered = new RpcProcess(agentDir, projectDir);
				try {
					await within(initialize(recovered), `${crashPoint}: recovery initialize`);
					await within(
						recovered.request(request("reopen", "session/open", { sessionId: SESSION_ID })),
						`${crashPoint}: recovery open`,
					);
					const replay = (await within(
						recovered.request(
							request("replay", "turn/start", { sessionId: SESSION_ID, requestId: TURN_ID, text: "run" }),
						),
						`${crashPoint}: replay`,
					)) as { result: { operationId: string; status: string } };
					const snapshotResponse = (await within(
						recovered.request(request("snapshot", "session/subscribe", { sessionId: SESSION_ID })),
						`${crashPoint}: snapshot`,
					)) as { result: { snapshot: SessionSnapshot } };

					expect(replay.result).toMatchObject({
						operationId: identifySubmitPromptRequest(TURN_ID, { text: "run" }).operationId,
						status: "existing",
					});
					expect(snapshotResponse.result.snapshot.activeTurnId).toBeNull();
					if (crashPoint !== "accepted_only") {
						expect(snapshotResponse.result.snapshot.turns.at(-1)?.state).toBe(
							crashPoint === "operation_finish" ? "completed" : "interrupted",
						);
					}
					expect(providerRequests).toBe(requestsBeforeRecovery);
					const effectsAfterRecovery = readFileSync(sideEffects, { encoding: "utf8", flag: "a+" })
						.trim()
						.split("\n")
						.filter(Boolean).length;
					expect(effectsAfterRecovery).toBe(effectsBeforeRecovery);
				} finally {
					await recovered.stop();
				}
			} finally {
				await firstProcess?.stop();
				provider.closeAllConnections();
				await new Promise<void>((resolve) => provider.close(() => resolve()));
			}
		},
		30_000,
	);
});
