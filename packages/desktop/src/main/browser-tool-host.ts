import {
	type BrowserToolResult,
	createRpcError,
	type RpcErrorResponse,
	type ServerRpcNotification,
	type ServerRpcRequest,
	type ServerRpcSuccessResponse,
} from "@metis/app-protocol";
import type { DesktopBrowserEvent, SupervisorView } from "../shared/desktop-api.ts";
import { type BrowserManager, BrowserToolError } from "./browser-manager.ts";

interface BrowserToolHostOptions {
	readonly supervisor: {
		view(): SupervisorView;
		respondToServerRequest(request: ServerRpcRequest, response: ServerRpcSuccessResponse | RpcErrorResponse): void;
	};
	readonly browserManager: Pick<BrowserManager, "executeTool" | "cancelSessionHandoffs">;
	readonly isAvailable: () => boolean;
}

interface PendingBrowserCall {
	readonly request: ServerRpcRequest<"browser/tool">;
	readonly abort: AbortController;
}

/** Owns browser RPC execution, response correlation, and scoped cancellation. */
export class BrowserToolHost {
	private readonly pending = new Map<string, PendingBrowserCall>();
	private readonly options: BrowserToolHostOptions;

	constructor(options: BrowserToolHostOptions) {
		this.options = options;
	}

	handleRequest(request: ServerRpcRequest<"browser/tool">): void {
		if (this.pending.has(request.id)) throw new Error("App-server reused a pending browser request id");
		if (!this.options.isAvailable()) {
			this.options.supervisor.respondToServerRequest(request, {
				jsonrpc: "2.0",
				id: request.id,
				error: createRpcError("OPERATION_FAILED", { sessionId: request.params.sessionId }),
			});
			return;
		}

		const pending = { request, abort: new AbortController() };
		this.pending.set(request.id, pending);
		void this.options.browserManager
			.executeTool(request.params.sessionId, request.params.call, pending.abort.signal)
			.then((result) => this.respondWithResult(pending, result))
			.catch((cause) => this.respondWithError(pending, cause))
			.finally(() => {
				if (this.pending.get(request.id) === pending) this.pending.delete(request.id);
			});
	}

	handleCancellation(notification: ServerRpcNotification<"browser/tool/cancelled">): void {
		const pending = this.pending.get(notification.params.requestId);
		if (
			!pending ||
			pending.request.params.serverEpoch !== notification.params.serverEpoch ||
			pending.request.params.sessionId !== notification.params.sessionId ||
			pending.request.params.toolCallId !== notification.params.toolCallId
		)
			return;
		pending.abort.abort();
		this.pending.delete(notification.params.requestId);
	}

	handleBrowserEvent(event: DesktopBrowserEvent): void {
		if (event.type !== "closed") return;
		for (const pending of this.pending.values()) {
			if (pending.request.params.sessionId !== event.sessionId) continue;
			const call = pending.request.params.call;
			const targetsBrowser =
				(call.tool === "browser_tabs" &&
					call.input.action === "close" &&
					call.input.browserId === event.browserId) ||
				(call.tool !== "browser_tabs" && call.input.browserId === event.browserId);
			const isClosingCall = call.tool === "browser_tabs" && call.input.action === "close";
			if (targetsBrowser && !isClosingCall) pending.abort.abort();
		}
	}

	cancelSessions(sessionIds: ReadonlySet<string>): void {
		for (const sessionId of sessionIds) this.options.browserManager.cancelSessionHandoffs(sessionId, "tab_closed");
		for (const [requestId, pending] of this.pending) {
			if (!sessionIds.has(pending.request.params.sessionId)) continue;
			this.pending.delete(requestId);
			pending.abort.abort();
		}
	}

	cancelAll(reason: "server_restarted" | "tab_closed" = "server_restarted"): void {
		const sessionIds = new Set([...this.pending.values()].map(({ request }) => request.params.sessionId));
		for (const sessionId of sessionIds) this.options.browserManager.cancelSessionHandoffs(sessionId, reason);
		const pending = [...this.pending.values()];
		if (reason === "server_restarted") this.pending.clear();
		for (const call of pending) call.abort.abort();
	}

	private current(pending: PendingBrowserCall): boolean {
		if (this.pending.get(pending.request.id) !== pending) return false;
		const view = this.options.supervisor.view();
		return view.state === "ready" && view.serverEpoch === pending.request.params.serverEpoch;
	}

	private respondWithResult(pending: PendingBrowserCall, result: BrowserToolResult): void {
		if (!this.current(pending)) return;
		this.options.supervisor.respondToServerRequest(pending.request, {
			jsonrpc: "2.0",
			id: pending.request.id,
			result: { toolCallId: pending.request.params.toolCallId, result },
		});
	}

	private respondWithError(pending: PendingBrowserCall, cause: unknown): void {
		if (!this.current(pending)) return;
		this.options.supervisor.respondToServerRequest(pending.request, {
			jsonrpc: "2.0",
			id: pending.request.id,
			error: createRpcError(cause instanceof BrowserToolError ? cause.rpcErrorName : "OPERATION_FAILED", {
				sessionId: pending.request.params.sessionId,
			}),
		});
	}
}
