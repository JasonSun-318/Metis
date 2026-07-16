import { randomUUID } from "node:crypto";
import {
	createRpcError,
	type HostRpcRequest,
	type HostRpcSuccessResponse,
	ProtocolValidationError,
	type RpcErrorResponse,
	validateHostRequest,
	validateResponseFor,
} from "@arcmind/app-protocol";
import { VERSION } from "@arcmind/coding-agent";
import { AgentSessionRuntimeHost } from "./agent-session-runtime-host.ts";
import { AppServerConnection } from "./connection.ts";
import { CredentialCoordinator } from "./credential-coordinator.ts";
import { Dispatcher } from "./dispatcher.ts";
import { InteractionBroker } from "./interactions.ts";
import type { OutboundQueueLimits } from "./outbound-queue.ts";
import { SessionCatalog } from "./session-catalog.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./session-registry.ts";
import { AppServerError, type SessionRuntimeHost } from "./session-runtime-host.ts";
import { SessionSubscriptions } from "./subscriptions.ts";

export interface AppServerOptions extends SessionRegistryOptions, OutboundQueueLimits {
	readonly agentDir: string;
	readonly sessionsRoot?: string;
	readonly runtimeHost?: SessionRuntimeHost;
	readonly serverVersion?: string;
}

/** Parent-owned application server hosting all open ArcMind sessions. */
export class AppServer {
	readonly serverEpoch = randomUUID();
	readonly catalog: SessionCatalog;
	readonly registry: SessionRegistry;
	readonly dispatcher: Dispatcher;
	readonly subscriptions: SessionSubscriptions;
	readonly interactions: InteractionBroker;
	private readonly connections = new Set<AppServerConnection>();
	private readonly serverVersion: string;
	private readonly outboundQueueLimits: OutboundQueueLimits;
	private shutdownPromise?: Promise<void>;

	private constructor(options: AppServerOptions) {
		this.serverVersion = options.serverVersion ?? VERSION;
		this.catalog = new SessionCatalog({ agentDir: options.agentDir, sessionsRoot: options.sessionsRoot });
		this.interactions = new InteractionBroker({ serverEpoch: this.serverEpoch });
		const credentials = new CredentialCoordinator({ agentDir: options.agentDir });
		this.registry = new SessionRegistry(
			options.runtimeHost ??
				new AgentSessionRuntimeHost({
					agentDir: options.agentDir,
					interactions: this.interactions,
					credentials,
				}),
			{
				maxQueuedOperationsPerSession: options.maxQueuedOperationsPerSession,
			},
		);
		this.subscriptions = new SessionSubscriptions(this.serverEpoch);
		this.dispatcher = new Dispatcher(this.catalog, this.registry, this.subscriptions, this.interactions);
		this.outboundQueueLimits = {
			maxUnacknowledgedBytes: options.maxUnacknowledgedBytes,
			maxUnacknowledgedEvents: options.maxUnacknowledgedEvents,
			maxEnvelopeBytes: options.maxEnvelopeBytes,
		};
	}

	static async create(options: AppServerOptions): Promise<AppServer> {
		const server = new AppServer(options);
		await server.catalog.refresh();
		return server;
	}

	connect(): AppServerConnection {
		if (this.shutdownPromise) throw new AppServerError("BUSY");
		const connection = new AppServerConnection({
			dispatcher: this.dispatcher,
			serverEpoch: this.serverEpoch,
			serverVersion: this.serverVersion,
			subscriptionHub: this.subscriptions,
			outboundQueueLimits: this.outboundQueueLimits,
			onClose: (closed) => {
				this.interactions.releasePeer(closed);
				this.connections.delete(closed);
			},
		});
		this.connections.add(connection);
		return connection;
	}

	beginShutdown(): void {
		if (this.shutdownPromise) return;
		for (const connection of this.connections) connection.close();
		this.connections.clear();
		this.subscriptions.close();
		this.shutdownPromise = this.registry.shutdown();
	}

	waitForShutdown(): Promise<void> {
		return this.shutdownPromise ?? Promise.resolve();
	}

	async handleHost(value: unknown): Promise<HostRpcSuccessResponse | RpcErrorResponse> {
		let request: HostRpcRequest;
		try {
			request = validateHostRequest(value);
		} catch (error) {
			const name =
				error instanceof ProtocolValidationError
					? error.kind === "method_not_found"
						? "METHOD_NOT_FOUND"
						: error.kind === "invalid_params"
							? "INVALID_PARAMS"
							: "INVALID_REQUEST"
					: "INVALID_REQUEST";
			return { jsonrpc: "2.0", id: null, error: createRpcError(name) };
		}
		if (request.method === "server/shutdown") {
			this.beginShutdown();
			const response: HostRpcSuccessResponse<"server/shutdown"> = {
				jsonrpc: "2.0",
				id: request.id,
				result: { accepted: true },
			};
			return validateResponseFor("host", request, response) as HostRpcSuccessResponse;
		}
		return {
			jsonrpc: "2.0",
			id: request.id,
			error: createRpcError("METHOD_NOT_FOUND"),
		};
	}
}
