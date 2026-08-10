import { randomUUID } from "node:crypto";
import {
	assertEnvelopeByteLimit,
	type ClientRpcRequest,
	type ClientRpcSuccessResponse,
	type HostRpcRequest,
	type HostRpcSuccessResponse,
	PROTOCOL_VERSION,
	RPC_ERROR_CODES,
	type RpcErrorResponse,
	type ServerRpcRequest,
	type ServerRpcSuccessResponse,
	validateClientRequest,
	validateResponseFor,
	validateServerNotification,
	validateServerRequest,
	validateUncorrelatedErrorResponse,
} from "@metis/app-protocol";
import type { SupervisorState, SupervisorView } from "../shared/desktop-api.ts";

export type { SupervisorState, SupervisorView } from "../shared/desktop-api.ts";

export interface DiagnosticReadable {
	on(event: "data", listener: (chunk: string | Buffer) => void): this;
	off(event: "data", listener: (chunk: string | Buffer) => void): this;
	pause(): this;
	resume(): this;
}

export interface UtilityChild {
	readonly pid: number | undefined;
	readonly stdout: DiagnosticReadable | null;
	readonly stderr: DiagnosticReadable | null;
	on(event: "spawn", listener: () => void): this;
	on(event: "message", listener: (message: unknown) => void): this;
	on(event: "exit", listener: (code: number) => void): this;
	off(event: "spawn", listener: () => void): this;
	off(event: "message", listener: (message: unknown) => void): this;
	off(event: "exit", listener: (code: number) => void): this;
	postMessage(message: unknown): void;
	kill(): boolean;
}

export interface DiagnosticSink {
	append(source: "stdout" | "stderr" | "supervisor", chunk: string | Uint8Array): Promise<void>;
}

export interface AppServerSupervisorOptions {
	readonly spawn?: () => UtilityChild;
	readonly diagnostics?: DiagnosticSink;
	readonly handshakeTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly restartDelaysMs?: readonly number[];
	readonly crashWindowMs?: number;
	readonly maxUnexpectedExits?: number;
	readonly now?: () => number;
}

interface PendingRequest {
	readonly direction: "client" | "host";
	readonly request: ClientRpcRequest | HostRpcRequest;
	readonly resolve: (response: ClientRpcSuccessResponse | HostRpcSuccessResponse | RpcErrorResponse) => void;
	readonly reject: (error: Error) => void;
	readonly initialize: boolean;
}

interface ChildListeners {
	readonly child: UtilityChild;
	readonly generation: number;
	readonly onSpawn: () => void;
	readonly onMessage: (message: unknown) => void;
	readonly onExit: (code: number) => void;
	readonly streamCleanup: readonly (() => void)[];
}

export class ServerRestartedError extends Error {
	readonly code = "SERVER_RESTARTED";
	readonly previousEpoch: string | null;

	constructor(previousEpoch: string | null) {
		super("Metis app-server restarted");
		this.name = "ServerRestartedError";
		this.previousEpoch = previousEpoch;
	}
}

export class ServerUnavailableError extends Error {
	readonly code = "SERVER_UNAVAILABLE";

	constructor(message = "Metis app-server is not ready") {
		super(message);
		this.name = "ServerUnavailableError";
	}
}

const DEFAULT_RESTART_DELAYS = [250, 1_000, 4_000] as const;

/** Main-owned lifecycle boundary for exactly one recoverable app-server child. */
export class AppServerSupervisor {
	private readonly spawnChild: () => UtilityChild;
	private readonly diagnostics?: DiagnosticSink;
	private readonly handshakeTimeoutMs: number;
	private readonly shutdownTimeoutMs: number;
	private readonly restartDelaysMs: readonly number[];
	private readonly crashWindowMs: number;
	private readonly maxUnexpectedExits: number;
	private readonly now: () => number;
	private state: SupervisorState = "stopped";
	private serverEpoch: string | null = null;
	private restartAttempt = 0;
	private failure: string | null = null;
	private childListeners?: ChildListeners;
	private generation = 0;
	private handshakeTimer?: ReturnType<typeof setTimeout>;
	private restartTimer?: ReturnType<typeof setTimeout>;
	private shutdownTimer?: ReturnType<typeof setTimeout>;
	private readonly crashTimes: number[] = [];
	private readonly pending = new Map<string, PendingRequest>();
	private readonly staleResponseIds = new Set<string>();
	private readonly readyWaiters = new Set<{
		resolve: (view: SupervisorView) => void;
		reject: (error: Error) => void;
	}>();
	private readonly stateListeners = new Set<(view: SupervisorView) => void>();
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly failedMessageListeners = new WeakSet<(message: unknown) => void>();
	private shutdownPromise?: Promise<void>;
	private resolveShutdown?: () => void;

	constructor(options: AppServerSupervisorOptions = {}) {
		this.spawnChild =
			options.spawn ??
			(() => {
				throw new ServerUnavailableError("No utility-process factory configured");
			});
		this.diagnostics = options.diagnostics;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
		this.restartDelaysMs = options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS;
		this.crashWindowMs = options.crashWindowMs ?? 60_000;
		this.maxUnexpectedExits = options.maxUnexpectedExits ?? 3;
		this.now = options.now ?? Date.now;
	}

	view(): SupervisorView {
		return {
			state: this.state,
			serverEpoch: this.serverEpoch,
			restartAttempt: this.restartAttempt,
			failure: this.failure,
		};
	}

	onState(listener: (view: SupervisorView) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	onMessage(listener: (message: unknown) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	start(): Promise<SupervisorView> {
		if (this.state === "ready") return Promise.resolve(this.view());
		if (this.state === "failed") return Promise.reject(new ServerUnavailableError(this.failure ?? undefined));
		if (this.state === "stopped") {
			this.failure = null;
			this.restartAttempt = 0;
			this.crashTimes.length = 0;
			this.spawnNow();
		}
		if (this.state === "shuttingDown")
			return Promise.reject(new ServerUnavailableError("App-server is shutting down"));
		return new Promise<SupervisorView>((resolve, reject) => this.readyWaiters.add({ resolve, reject }));
	}

	retry(): Promise<SupervisorView> {
		if (this.state !== "failed") return this.start();
		this.failure = null;
		this.restartAttempt = 0;
		this.crashTimes.length = 0;
		this.spawnNow();
		return new Promise<SupervisorView>((resolve, reject) => this.readyWaiters.add({ resolve, reject }));
	}

	request(requestValue: ClientRpcRequest): Promise<ClientRpcSuccessResponse | RpcErrorResponse> {
		if (this.state !== "ready" || !this.childListeners) return Promise.reject(new ServerUnavailableError());
		const request = validateClientRequest(requestValue);
		if (request.method === "initialize") {
			return Promise.reject(new ServerUnavailableError("Initialize is supervisor-owned"));
		}
		return this.sendPending("client", request, false) as Promise<ClientRpcSuccessResponse | RpcErrorResponse>;
	}

	respondToServerRequest(
		requestValue: ServerRpcRequest,
		responseValue: ServerRpcSuccessResponse | RpcErrorResponse,
	): void {
		if (this.state !== "ready" || !this.childListeners) throw new ServerUnavailableError();
		const request = validateServerRequest(requestValue);
		if (request.params.serverEpoch !== this.serverEpoch) {
			throw new ServerUnavailableError("Interaction belongs to an inactive app-server epoch");
		}
		const response = validateResponseFor("server", request, responseValue);
		try {
			assertEnvelopeByteLimit(response);
			this.childListeners.child.postMessage(structuredClone(response));
		} catch (error) {
			this.failCurrentChild("postMessage failed", true);
			throw error;
		}
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		if (this.state === "stopped") return Promise.resolve();
		this.shutdownPromise = new Promise<void>((resolve) => {
			this.resolveShutdown = resolve;
		});
		this.clearRestartTimer();
		this.state = "shuttingDown";
		this.emitState();
		if (!this.childListeners) {
			this.finishStop();
			return this.shutdownPromise;
		}

		const request: HostRpcRequest = {
			jsonrpc: "2.0",
			id: randomUUID(),
			method: "server/shutdown",
			params: { requestId: randomUUID(), reason: "desktop_app_quit" },
		};
		void this.sendPending("host", request, false).catch(() => undefined);
		this.shutdownTimer = setTimeout(() => {
			this.childListeners?.child.kill();
			this.finishStop();
		}, this.shutdownTimeoutMs);
		return this.shutdownPromise;
	}

	private spawnNow(): void {
		this.clearRestartTimer();
		this.state = "starting";
		this.serverEpoch = null;
		this.emitState();
		const generation = ++this.generation;
		try {
			const child = this.spawnChild();
			const streamCleanup = [this.drain(child.stdout, "stdout"), this.drain(child.stderr, "stderr")].filter(
				(cleanup): cleanup is () => void => cleanup !== undefined,
			);
			const onSpawn = () => this.initializeChild(generation);
			const onMessage = (message: unknown) => this.handleMessage(generation, message);
			const onExit = (code: number) => this.handleExit(generation, code);
			this.childListeners = { child, generation, onSpawn, onMessage, onExit, streamCleanup };
			child.on("spawn", onSpawn);
			child.on("message", onMessage);
			child.on("exit", onExit);
		} catch (error) {
			this.recordUnexpectedFailure(`spawn failed: ${this.publicError(error)}`);
		}
	}

	private initializeChild(generation: number): void {
		if (generation !== this.childListeners?.generation || (this.state !== "starting" && this.state !== "restarting"))
			return;
		const request: ClientRpcRequest = {
			jsonrpc: "2.0",
			id: randomUUID(),
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				client: { name: "metis-desktop-main", version: "0.80.6" },
				capabilities: [],
			},
		};
		this.handshakeTimer = setTimeout(() => {
			if (
				generation !== this.childListeners?.generation ||
				(this.state !== "starting" && this.state !== "restarting")
			)
				return;
			this.failCurrentChild("initialize handshake timed out", true);
		}, this.handshakeTimeoutMs);
		void this.sendPending("client", request, true).catch(() => undefined);
	}

	private sendPending(
		direction: "client" | "host",
		request: ClientRpcRequest | HostRpcRequest,
		initialize: boolean,
	): Promise<ClientRpcSuccessResponse | HostRpcSuccessResponse | RpcErrorResponse> {
		const child = this.childListeners?.child;
		if (!child) return Promise.reject(new ServerUnavailableError());
		return new Promise((resolve, reject) => {
			this.pending.set(request.id, { direction, request, resolve, reject, initialize });
			try {
				assertEnvelopeByteLimit(request);
				child.postMessage(structuredClone(request));
			} catch (error) {
				this.pending.delete(request.id);
				reject(error instanceof Error ? error : new Error("Failed to send request"));
				this.failCurrentChild("postMessage failed", true);
			}
		});
	}

	private handleMessage(generation: number, message: unknown): void {
		if (generation !== this.childListeners?.generation) return;
		try {
			assertEnvelopeByteLimit(message);
			const record = message as Record<string, unknown>;
			const responseShape = Object.hasOwn(record, "result") || Object.hasOwn(record, "error");
			const id = responseShape ? this.messageId(message) : undefined;
			const pending = id === undefined ? undefined : this.pending.get(id);
			if (pending) {
				const response = validateResponseFor(pending.direction, pending.request, message) as
					| ClientRpcSuccessResponse
					| HostRpcSuccessResponse
					| RpcErrorResponse;
				this.pending.delete(id!);
				if (pending.initialize) {
					if ("error" in response) {
						const error = new ServerUnavailableError(response.error.message);
						pending.reject(error);
						throw error;
					}
					this.clearHandshakeTimer();
					this.serverEpoch = (response as ClientRpcSuccessResponse<"initialize">).result.serverEpoch;
					this.state = "ready";
					this.failure = null;
					pending.resolve(response);
					this.emitState();
					this.resolveReadyWaiters();
					return;
				}
				pending.resolve(response);
				return;
			}
			if (id !== undefined && this.staleResponseIds.delete(id)) return;
			if (responseShape) {
				const response = validateUncorrelatedErrorResponse(message);
				if (response.error.code === RPC_ERROR_CODES.OVERLOADED) {
					this.reconnectCurrentChild("app-server connection overloaded");
					return;
				}
				throw new ServerUnavailableError(response.error.message);
			}

			if (Object.hasOwn(record, "id")) validateServerRequest(message);
			else validateServerNotification(message);
			for (const listener of this.messageListeners) {
				try {
					listener(message);
					this.failedMessageListeners.delete(listener);
				} catch (error) {
					if (this.failedMessageListeners.has(listener)) continue;
					this.failedMessageListeners.add(listener);
					void this.diagnostics
						?.append("supervisor", `app-server message listener failed: ${this.publicError(error)}\n`)
						.catch(() => undefined);
				}
			}
		} catch (error) {
			this.failCurrentChild(`invalid app-server message: ${this.publicError(error)}`, true);
		}
	}

	private reconnectCurrentChild(reason: string): void {
		const generation = this.childListeners?.generation;
		if (generation === undefined || this.state === "shuttingDown") return;
		this.clearHandshakeTimer();
		const previousEpoch = this.serverEpoch;
		this.serverEpoch = null;
		for (const id of this.pending.keys()) this.staleResponseIds.add(id);
		this.rejectPending(new ServerRestartedError(previousEpoch));
		this.state = "restarting";
		this.failure = reason;
		this.emitState();
		void this.diagnostics?.append("supervisor", `${reason}\n`).catch(() => undefined);
		this.initializeChild(generation);
	}

	private handleExit(generation: number, code: number): void {
		if (generation !== this.childListeners?.generation) return;
		if (this.state === "shuttingDown") {
			this.finishStop();
			return;
		}
		this.releaseChild();
		this.recordUnexpectedFailure(`app-server exited with code ${code}`);
	}

	private failCurrentChild(reason: string, terminate: boolean): void {
		const child = this.childListeners?.child;
		this.releaseChild();
		if (terminate) child?.kill();
		this.recordUnexpectedFailure(reason);
	}

	private recordUnexpectedFailure(reason: string): void {
		this.clearHandshakeTimer();
		const previousEpoch = this.serverEpoch;
		this.serverEpoch = null;
		this.rejectPending(new ServerRestartedError(previousEpoch));
		void this.diagnostics?.append("supervisor", `${reason}\n`).catch(() => undefined);
		const now = this.now();
		while (this.crashTimes.length > 0 && now - this.crashTimes[0] >= this.crashWindowMs) this.crashTimes.shift();
		this.crashTimes.push(now);
		this.restartAttempt = this.crashTimes.length;
		if (this.restartAttempt >= this.maxUnexpectedExits) {
			this.state = "failed";
			this.failure = reason;
			this.emitState();
			this.rejectReadyWaiters(new ServerUnavailableError(reason));
			return;
		}
		this.state = "restarting";
		this.failure = reason;
		this.emitState();
		const delay = this.restartDelaysMs[Math.min(this.restartAttempt - 1, this.restartDelaysMs.length - 1)] ?? 0;
		this.restartTimer = setTimeout(() => this.spawnNow(), delay);
	}

	private releaseChild(): void {
		const listeners = this.childListeners;
		if (!listeners) return;
		listeners.child.off("spawn", listeners.onSpawn);
		listeners.child.off("message", listeners.onMessage);
		listeners.child.off("exit", listeners.onExit);
		for (const cleanup of listeners.streamCleanup) cleanup();
		this.childListeners = undefined;
		this.staleResponseIds.clear();
		this.clearHandshakeTimer();
	}

	private drain(stream: DiagnosticReadable | null, source: "stdout" | "stderr"): (() => void) | undefined {
		if (!stream) return undefined;
		const onData = (chunk: string | Buffer): void => {
			stream.pause();
			const bytes = typeof chunk === "string" ? chunk : new Uint8Array(chunk);
			void (this.diagnostics?.append(source, bytes) ?? Promise.resolve())
				.catch(() => undefined)
				.finally(() => stream.resume());
		};
		stream.on("data", onData);
		stream.resume();
		return () => stream.off("data", onData);
	}

	private finishStop(): void {
		this.clearHandshakeTimer();
		this.clearRestartTimer();
		if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
		this.shutdownTimer = undefined;
		this.releaseChild();
		this.rejectPending(new ServerUnavailableError("Metis app-server stopped"));
		this.rejectReadyWaiters(new ServerUnavailableError("Metis app-server stopped"));
		this.serverEpoch = null;
		this.restartAttempt = 0;
		this.failure = null;
		this.state = "stopped";
		this.emitState();
		this.resolveShutdown?.();
		this.resolveShutdown = undefined;
	}

	private messageId(message: unknown): string | undefined {
		if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(message, "id");
		return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
	}

	private resolveReadyWaiters(): void {
		const view = this.view();
		for (const waiter of this.readyWaiters) waiter.resolve(view);
		this.readyWaiters.clear();
	}

	private rejectReadyWaiters(error: Error): void {
		for (const waiter of this.readyWaiters) waiter.reject(error);
		this.readyWaiters.clear();
	}

	private rejectPending(error: Error): void {
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}

	private emitState(): void {
		const view = this.view();
		for (const listener of this.stateListeners) listener(view);
	}

	private clearHandshakeTimer(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = undefined;
	}

	private clearRestartTimer(): void {
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
	}

	private publicError(error: unknown): string {
		return error instanceof Error ? error.message : "unknown failure";
	}
}
