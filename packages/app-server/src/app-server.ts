import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	createRpcError,
	type HostRpcRequest,
	type HostRpcSuccessResponse,
	ProtocolValidationError,
	type RpcErrorResponse,
	validateHostRequest,
	validateResponseFor,
} from "@metis/app-protocol";
import {
	createScheduledRunExecutor,
	ensureModeScopedMemoryLayout,
	ModelRegistry,
	pruneStaleSessionWorkDirs,
	ScheduleManager,
	type ScheduleManagerOptions,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@metis/coding-agent";
import { AgentSessionRuntimeHost } from "./agent-session-runtime-host.ts";
import { AppServerConnection } from "./connection.ts";
import { CredentialCoordinator } from "./credential-coordinator.ts";
import { Dispatcher } from "./dispatcher.ts";
import { HooksService } from "./hooks.ts";
import { InteractionBroker } from "./interactions.ts";
import { ModelSettingsService } from "./model-settings.ts";
import type { OutboundQueueLimits } from "./outbound-queue.ts";
import { PermissionRulesService } from "./permission-rules.ts";
import { PersonalizationService } from "./personalization.ts";
import { scheduleEventView } from "./schedule-projection.ts";
import { SessionCatalog } from "./session-catalog.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./session-registry.ts";
import { AppServerError, type SessionRuntimeHost } from "./session-runtime-host.ts";
import { DefaultSessionTitleGenerator, type SessionTitleGenerator } from "./session-title-generator.ts";
import { SessionSubscriptions } from "./subscriptions.ts";
import { WebSearchService } from "./web-search.ts";

export interface AppServerOptions extends SessionRegistryOptions, OutboundQueueLimits {
	readonly agentDir: string;
	readonly sessionsRoot?: string;
	readonly runtimeHost?: SessionRuntimeHost;
	readonly serverVersion?: string;
	readonly scheduleManager?: ScheduleManager;
	readonly scheduleExecute?: ScheduleManagerOptions["execute"];
	readonly titleGenerator?: SessionTitleGenerator;
}

/** Parent-owned application server hosting all open Metis sessions. */
export class AppServer {
	readonly serverEpoch = randomUUID();
	readonly catalog: SessionCatalog;
	readonly registry: SessionRegistry;
	readonly dispatcher: Dispatcher;
	readonly subscriptions: SessionSubscriptions;
	readonly interactions: InteractionBroker;
	readonly scheduleManager: ScheduleManager;
	private readonly connections = new Set<AppServerConnection>();
	private readonly serverVersion: string;
	private readonly outboundQueueLimits: OutboundQueueLimits;
	private shutdownPromise?: Promise<void>;
	private scheduleUnsubscribe?: () => void;
	private scheduleEventTail: Promise<void> = Promise.resolve();

	private constructor(options: AppServerOptions) {
		this.serverVersion = options.serverVersion ?? VERSION;
		this.catalog = new SessionCatalog({ agentDir: options.agentDir, sessionsRoot: options.sessionsRoot });
		this.scheduleManager =
			options.scheduleManager ??
			ScheduleManager.create({
				agentDir: options.agentDir,
				execute: options.scheduleExecute ?? createScheduledRunExecutor({ agentDir: options.agentDir }),
			});
		this.subscriptions = new SessionSubscriptions(this.serverEpoch, (session) => {
			this.catalog.updateSummary(session.sessionId, session);
		});
		this.interactions = new InteractionBroker({
			serverEpoch: this.serverEpoch,
			onPendingChange: (sessionId, attentionRequired) => {
				try {
					const session = this.catalog.updateSummary(sessionId, {
						attentionRequired,
						...(attentionRequired ? { unread: true } : {}),
					});
					this.subscriptions.publishSessionUpdated(session);
				} catch {
					// A closing session may disappear before its pending interaction settles.
				}
			},
		});
		const credentials = new CredentialCoordinator({ agentDir: options.agentDir });
		const authStorage = credentials.createView();
		const modelRegistry = ModelRegistry.create(authStorage, join(options.agentDir, "models.json"));
		const settingsManager = SettingsManager.create(options.agentDir, options.agentDir, { projectTrusted: false });
		const modelSettings = new ModelSettingsService({
			agentDir: options.agentDir,
			authStorage,
			modelRegistry,
			settingsManager,
		});
		const personalization = new PersonalizationService(options.agentDir);
		const permissionRules = new PermissionRulesService(options.agentDir, this.catalog);
		const webSearch = new WebSearchService({ settingsManager, authStorage });
		const hooks = new HooksService(options.agentDir);
		this.registry = new SessionRegistry(
			options.runtimeHost ??
				new AgentSessionRuntimeHost({
					agentDir: options.agentDir,
					interactions: this.interactions,
					credentials,
					scheduleManager: this.scheduleManager,
				}),
			{
				maxQueuedOperationsPerSession: options.maxQueuedOperationsPerSession,
			},
		);
		this.dispatcher = new Dispatcher(
			this.catalog,
			this.registry,
			this.subscriptions,
			this.interactions,
			this.scheduleManager,
			modelRegistry,
			modelSettings,
			personalization,
			permissionRules,
			webSearch,
			hooks,
			options.titleGenerator ?? new DefaultSessionTitleGenerator({ modelRegistry, settingsManager }),
		);
		this.outboundQueueLimits = {
			maxUnacknowledgedBytes: options.maxUnacknowledgedBytes,
			maxUnacknowledgedEvents: options.maxUnacknowledgedEvents,
			maxEnvelopeBytes: options.maxEnvelopeBytes,
		};
	}

	static async create(options: AppServerOptions): Promise<AppServer> {
		SessionManager.recoverInterruptedProjectTrash(options.agentDir);
		await ensureModeScopedMemoryLayout(options.agentDir);
		pruneStaleSessionWorkDirs(options.agentDir);
		const server = new AppServer(options);
		await server.catalog.refresh();
		await server.scheduleManager.start();
		try {
			server.scheduleUnsubscribe = server.scheduleManager.subscribe((event) => {
				server.scheduleEventTail = server.scheduleEventTail
					.then(async () => {
						if (event.type === "schedule/deleted") {
							await server.dispatcher.reconcileScheduledTaskSessions(event.taskId);
						} else if (event.type === "schedule/run-updated" && event.run.sessionId) {
							const registered = await server.catalog.registerScheduledRun(event.run).catch(() => undefined);
							if (registered?.changed) server.subscriptions.publishSessionUpdated(registered.session);
						}
						const view = scheduleEventView(event);
						if (view) server.subscriptions.publishSchedule(view);
					})
					.catch(() => undefined);
			});
		} catch {
			// Schedule RPCs report SCHEDULE_STORE_CORRUPT; ordinary sessions remain available.
		}
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
		this.shutdownPromise = (async () => {
			await this.scheduleManager.stop();
			await this.scheduleEventTail;
			this.scheduleUnsubscribe?.();
			this.scheduleUnsubscribe = undefined;
			await this.registry.shutdown();
		})();
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
