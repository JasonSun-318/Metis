import { randomUUID } from "node:crypto";
import {
	type ClientParams,
	type ClientResult,
	type ClientRpcRequest,
	type ClientRpcSuccessResponse,
	createRpcError,
	type InteractionResponseInput,
	type RpcErrorResponse,
	type ServerRpcRequest,
	type ServerRpcSuccessResponse,
	validateClientRequest,
	validateServerNotification,
	validateServerRequest,
} from "@arcmind/app-protocol";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
	DESKTOP_EVENT_CHANNEL,
	DESKTOP_IPC_CHANNELS,
	type DesktopApiEvent,
	type DesktopAttachmentSelection,
	type SupervisorView,
	validateInteractionResponseInput,
} from "../shared/desktop-api.ts";

interface BrokerSupervisor {
	view(): SupervisorView;
	onState(listener: (view: SupervisorView) => void): () => void;
	onMessage(listener: (message: unknown) => void): () => void;
	request(request: ClientRpcRequest): Promise<ClientRpcSuccessResponse | RpcErrorResponse>;
	retry(): Promise<SupervisorView>;
	respondToServerRequest(request: ServerRpcRequest, response: ServerRpcSuccessResponse | RpcErrorResponse): void;
}

interface ClientBrokerOptions {
	readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	readonly supervisor: BrokerSupervisor;
	readonly selectProjectFolder?: () => Promise<string | null>;
	readonly selectAttachmentFiles?: () => Promise<DesktopAttachmentSelection[]>;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

interface PendingInteraction {
	readonly request: ServerRpcRequest;
	readonly timer?: ReturnType<typeof setTimeout>;
}

export function isTrustedRendererUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "app:" &&
			url.hostname === "renderer" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/index.html" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

function rpcFailure(response: RpcErrorResponse): Error {
	const error = new Error(response.error.message);
	error.name = "ArcMindRpcError";
	Object.defineProperty(error, "code", { value: response.error.code, enumerable: true });
	return error;
}

/** Owns the single narrow, validated renderer-to-app-server capability surface. */
export class ClientBroker {
	private readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
	private readonly supervisor: BrokerSupervisor;
	private readonly selectProjectFolder: () => Promise<string | null>;
	private readonly selectAttachmentFiles: () => Promise<DesktopAttachmentSelection[]>;
	private readonly pendingInteractions = new Map<string, PendingInteraction>();
	private readonly subscribedSessions = new Set<string>();
	private subscriptionMutation = Promise.resolve();
	private readonly removeSupervisorListeners: readonly (() => void)[];
	private owner?: WebContents;
	private ownerSubscribed = false;
	private ownerCleanup: readonly (() => void)[] = [];
	private disposed = false;

	constructor(options: ClientBrokerOptions) {
		this.ipcMain = options.ipcMain;
		this.supervisor = options.supervisor;
		this.selectProjectFolder = options.selectProjectFolder ?? (async () => null);
		this.selectAttachmentFiles = options.selectAttachmentFiles ?? (async () => []);
		this.registerHandlers();
		this.removeSupervisorListeners = [
			this.supervisor.onState((view) => {
				if (view.state !== "ready") {
					this.dropPendingInteractions();
					this.subscribedSessions.clear();
				}
				this.sendEvent({ type: "supervisor", view });
			}),
			this.supervisor.onMessage((message) => this.handleServerMessage(message)),
		];
	}

	attach(window: Pick<BrowserWindow, "webContents">): void {
		if (this.disposed) throw new Error("Desktop client broker is disposed");
		this.detachOwner();
		const owner = window.webContents;
		this.owner = owner;
		this.ownerSubscribed = false;

		const onDestroyed = () => {
			if (this.owner === owner) this.detachOwner();
		};
		const onRenderProcessGone = () => {
			if (this.owner === owner) this.detachOwner();
		};
		const onDidStartNavigation = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
			if (this.owner !== owner || !isMainFrame) return;
			this.ownerSubscribed = false;
			this.cancelPendingInteractions();
			this.releaseSessionSubscriptions();
		};

		owner.on("destroyed", onDestroyed);
		owner.on("render-process-gone", onRenderProcessGone);
		owner.on("did-start-navigation", onDidStartNavigation);
		this.ownerCleanup = [
			() => owner.off("destroyed", onDestroyed),
			() => owner.off("render-process-gone", onRenderProcessGone),
			() => owner.off("did-start-navigation", onDidStartNavigation),
		];
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachOwner();
		for (const remove of this.removeSupervisorListeners) remove();
		for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) this.ipcMain.removeHandler(channel);
	}

	private registerHandlers(): void {
		this.register(DESKTOP_IPC_CHANNELS.listSessions, 1, async (_event, [input]) =>
			this.clientCall("session/list", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.listSkills, 1, async (_event, [input]) =>
			this.clientCall("skill/list", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.previewProjectDelete, 1, async (_event, [input]) =>
			this.clientCall("project/deletePreview", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.deleteProject, 1, async (_event, [input]) =>
			this.clientCall("project/delete", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.createSession, 1, async (_event, [input]) =>
			this.clientCall("session/create", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.openSession, 1, async (_event, [input]) => {
			const params = this.validatedParams("session/open", input);
			return this.enqueueSubscriptionMutation(async () => {
				const previousSessionIds = [...this.subscribedSessions].filter(
					(sessionId) => sessionId !== params.sessionId,
				);
				await this.clientCall("session/open", params);
				const subscribed = await this.clientCall("session/subscribe", { sessionId: params.sessionId });
				this.subscribedSessions.add(params.sessionId);
				const previousSessions = new Set(previousSessionIds);
				this.cancelPendingInteractionsForSessions(previousSessions);
				await this.unsubscribeSessions(previousSessionIds, true);
				// A request can cross the process boundary while unsubscribe is in flight.
				this.cancelPendingInteractionsForSessions(previousSessions);
				return subscribed.snapshot;
			});
		});
		this.register(DESKTOP_IPC_CHANNELS.readItems, 1, async (_event, [input]) =>
			this.clientCall("session/readItems", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.readSubagentItems, 1, async (_event, [input]) =>
			this.clientCall("subagent/readItems", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.setThinkingSelection, 1, async (_event, [input]) =>
			this.clientCall("session/setThinkingSelection", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.setModel, 1, async (_event, [input]) =>
			this.clientCall("session/setModel", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.startTurn, 1, async (_event, [input]) => this.clientCall("turn/start", input));
		this.register(DESKTOP_IPC_CHANNELS.steerTurn, 1, async (_event, [input]) => this.clientCall("turn/steer", input));
		this.register(DESKTOP_IPC_CHANNELS.interruptTurn, 1, async (_event, [input]) =>
			this.clientCall("turn/interrupt", input),
		);
		this.register(DESKTOP_IPC_CHANNELS.respondToInteraction, 1, async (_event, [input]) => {
			this.respondToInteraction(input);
		});
		this.register(DESKTOP_IPC_CHANNELS.selectProjectFolder, 0, async () => this.selectProjectFolder());
		this.register(DESKTOP_IPC_CHANNELS.selectAttachmentFiles, 0, async () => this.selectAttachmentFiles());
		this.register(DESKTOP_IPC_CHANNELS.getServerState, 0, async () => this.supervisor.view());
		this.register(DESKTOP_IPC_CHANNELS.retryServer, 0, async () => {
			await this.supervisor.retry();
		});
		this.register(DESKTOP_IPC_CHANNELS.subscribe, 0, async () => {
			this.ownerSubscribed = true;
			this.sendEvent({ type: "supervisor", view: this.supervisor.view() });
		});
	}

	private register(
		channel: string,
		argumentCount: number,
		handler: (event: IpcMainInvokeEvent, args: readonly unknown[]) => Promise<unknown>,
	): void {
		const guarded: InvokeHandler = async (event, ...args) => {
			this.assertTrustedSender(event);
			if (args.length !== argumentCount) throw new TypeError("Invalid desktop IPC arguments");
			return await handler(event, args);
		};
		this.ipcMain.handle(channel, guarded);
	}

	private assertTrustedSender(event: IpcMainInvokeEvent): void {
		if (
			!this.owner ||
			this.owner.isDestroyed() ||
			event.sender !== this.owner ||
			event.senderFrame !== this.owner.mainFrame ||
			!isTrustedRendererUrl(event.senderFrame.url)
		) {
			throw new Error("Untrusted desktop IPC sender");
		}
	}

	private validatedParams<Method extends Exclude<ClientRpcRequest["method"], "initialize">>(
		method: Method,
		params: unknown,
	): ClientParams<Method> {
		const request = validateClientRequest({ jsonrpc: "2.0", id: randomUUID(), method, params });
		return request.params as ClientParams<Method>;
	}

	private async clientCall<Method extends Exclude<ClientRpcRequest["method"], "initialize">>(
		method: Method,
		paramsValue: unknown,
	): Promise<ClientResult<Method>> {
		const params = this.validatedParams(method, paramsValue);
		const request = validateClientRequest({ jsonrpc: "2.0", id: randomUUID(), method, params });
		const response = await this.supervisor.request(request);
		if ("error" in response) throw rpcFailure(response);
		return response.result as ClientResult<Method>;
	}

	private handleServerMessage(value: unknown): void {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new TypeError("Invalid app-server message");
		if (Object.hasOwn(value, "id")) {
			const request = validateServerRequest(value);
			const view = this.supervisor.view();
			if (view.state !== "ready" || request.params.serverEpoch !== view.serverEpoch) return;
			if (this.pendingInteractions.has(request.params.interaction.interactionId)) {
				throw new Error("App-server reused a pending interaction id");
			}
			const interaction = request.params.interaction;
			const expiresAt = interaction.expiresAt ? Date.parse(interaction.expiresAt) : Number.NaN;
			const delay = expiresAt - Date.now();
			const timer = Number.isFinite(delay)
				? setTimeout(() => this.expireInteraction(interaction.interactionId), Math.max(0, delay))
				: undefined;
			timer?.unref?.();
			this.pendingInteractions.set(interaction.interactionId, { request, ...(timer ? { timer } : {}) });
			if (!this.sendEvent({ type: "app-server", envelope: request })) this.cancelPendingInteractions();
			return;
		}
		const notification = validateServerNotification(value);
		const view = this.supervisor.view();
		if (view.state !== "ready" || notification.params.serverEpoch !== view.serverEpoch) return;
		this.sendEvent({ type: "app-server", envelope: notification });
		void this.clientCall("connection/ack", {
			serverEpoch: notification.params.serverEpoch,
			cursor: notification.params.toCursor,
		}).catch(() => undefined);
	}

	private respondToInteraction(value: unknown): void {
		const input: InteractionResponseInput = validateInteractionResponseInput(value);
		const pending = this.pendingInteractions.get(input.interactionId);
		if (!pending) throw new Error("Interaction is no longer pending");
		const response: ServerRpcSuccessResponse = { jsonrpc: "2.0", id: pending.request.id, result: input };
		this.supervisor.respondToServerRequest(pending.request, response);
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingInteractions.delete(input.interactionId);
	}

	private sendEvent(event: DesktopApiEvent): boolean {
		const owner = this.owner;
		if (!owner || !this.ownerSubscribed || owner.isDestroyed()) return false;
		try {
			owner.send(DESKTOP_EVENT_CHANNEL, structuredClone(event));
			return true;
		} catch {
			this.ownerSubscribed = false;
			return false;
		}
	}

	private cancelPendingInteractions(): void {
		const pendingInteractions = [...this.pendingInteractions.values()];
		this.pendingInteractions.clear();
		for (const pending of pendingInteractions) {
			if (pending.timer) clearTimeout(pending.timer);
			this.cancelServerInteraction(pending.request);
		}
	}

	private cancelPendingInteractionsForSessions(sessionIds: ReadonlySet<string>): void {
		for (const [interactionId, pending] of this.pendingInteractions) {
			if (!sessionIds.has(pending.request.params.interaction.sessionId)) continue;
			this.pendingInteractions.delete(interactionId);
			if (pending.timer) clearTimeout(pending.timer);
			this.cancelServerInteraction(pending.request);
		}
	}

	private dropPendingInteractions(): void {
		for (const pending of this.pendingInteractions.values()) {
			if (pending.timer) clearTimeout(pending.timer);
		}
		this.pendingInteractions.clear();
	}

	private expireInteraction(interactionId: string): void {
		const pending = this.pendingInteractions.get(interactionId);
		if (!pending) return;
		this.pendingInteractions.delete(interactionId);
		this.cancelServerInteraction(pending.request);
		this.sendEvent({ type: "interaction-cancelled", interactionId });
	}

	private cancelServerInteraction(request: ServerRpcRequest): void {
		const interaction = request.params.interaction;
		const response: RpcErrorResponse = {
			jsonrpc: "2.0",
			id: request.id,
			error: createRpcError("INTERACTION_CANCELLED", {
				interactionId: interaction.interactionId,
				sessionId: interaction.sessionId,
			}),
		};
		try {
			this.supervisor.respondToServerRequest(request, response);
		} catch {
			// A lost app-server has no interaction left to cancel.
		}
	}

	private detachOwner(): void {
		for (const cleanup of this.ownerCleanup) cleanup();
		this.ownerCleanup = [];
		this.owner = undefined;
		this.ownerSubscribed = false;
		this.cancelPendingInteractions();
		this.releaseSessionSubscriptions();
	}

	private releaseSessionSubscriptions(): void {
		void this.enqueueSubscriptionMutation(() => this.unsubscribeSessionSubscriptions(true));
	}

	private enqueueSubscriptionMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.subscriptionMutation.then(operation);
		this.subscriptionMutation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async unsubscribeSessionSubscriptions(ignoreErrors = false): Promise<void> {
		await this.unsubscribeSessions([...this.subscribedSessions], ignoreErrors);
	}

	private async unsubscribeSessions(sessionIds: readonly string[], ignoreErrors: boolean): Promise<void> {
		const errors: unknown[] = [];
		await Promise.all(
			sessionIds.map(async (sessionId) => {
				try {
					await this.clientCall("session/unsubscribe", { sessionId });
					this.subscribedSessions.delete(sessionId);
				} catch (error) {
					// A later session switch or renderer teardown retries tracked cleanup.
					if (!ignoreErrors) errors.push(error);
				}
			}),
		);
		if (errors.length > 0) throw errors[0];
	}
}
