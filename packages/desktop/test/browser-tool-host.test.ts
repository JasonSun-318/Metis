import type { BrowserToolCall, BrowserToolResult, ServerRpcNotification, ServerRpcRequest } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { BrowserToolError } from "../src/main/browser-manager.ts";
import { BrowserToolHost } from "../src/main/browser-tool-host.ts";
import type { SupervisorView } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const NEXT_EPOCH = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "20000000-0000-4000-8000-000000000090";
const OTHER_SESSION_ID = "20000000-0000-4000-8000-000000000091";
const BROWSER_ID = "10000000-0000-4000-8000-000000000090";
const OTHER_BROWSER_ID = "10000000-0000-4000-8000-000000000091";

const tabsResult = (): BrowserToolResult => ({
	tool: "browser_tabs",
	details: { profiles: [], tabs: [] },
});

function browserRequest(
	overrides: {
		readonly id?: string;
		readonly sessionId?: string;
		readonly toolCallId?: string;
		readonly call?: BrowserToolCall;
	} = {},
): ServerRpcRequest<"browser/tool"> {
	return {
		jsonrpc: "2.0",
		id: overrides.id ?? "browser-rpc-1",
		method: "browser/tool",
		params: {
			serverEpoch: EPOCH,
			sessionId: overrides.sessionId ?? SESSION_ID,
			toolCallId: overrides.toolCallId ?? "browser-call-1",
			call:
				overrides.call ?? ({ tool: "browser_observe", input: { browserId: BROWSER_ID } } satisfies BrowserToolCall),
		},
	};
}

function cancellation(
	request: ServerRpcRequest<"browser/tool">,
	overrides: Partial<ServerRpcNotification<"browser/tool/cancelled">["params"]> = {},
): ServerRpcNotification<"browser/tool/cancelled"> {
	return {
		jsonrpc: "2.0",
		method: "browser/tool/cancelled",
		params: {
			serverEpoch: request.params.serverEpoch,
			sessionId: request.params.sessionId,
			requestId: request.id,
			toolCallId: request.params.toolCallId,
			...overrides,
		},
	};
}

function deferred<Result>() {
	let resolve!: (result: Result) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function harness() {
	let view: SupervisorView = {
		state: "ready",
		serverEpoch: EPOCH,
		restartAttempt: 0,
		failure: null,
	};
	let available = true;
	const supervisor = {
		view: () => view,
		respondToServerRequest: vi.fn(),
	};
	const browserManager = {
		executeTool: vi.fn(),
		cancelSessionHandoffs: vi.fn(),
	};
	const host = new BrowserToolHost({
		supervisor,
		browserManager: browserManager as never,
		isAvailable: () => available,
	});
	return {
		host,
		supervisor,
		browserManager,
		setAvailable: (next: boolean) => {
			available = next;
		},
		setView: (next: Partial<SupervisorView>) => {
			view = { ...view, ...next };
		},
	};
}

describe("BrowserToolHost", () => {
	it("rejects unavailable owners without starting browser work", () => {
		const { host, supervisor, browserManager, setAvailable } = harness();
		setAvailable(false);
		const request = browserRequest();

		host.handleRequest(request);

		expect(browserManager.executeTool).not.toHaveBeenCalled();
		expect(supervisor.respondToServerRequest.mock.calls[0]).toEqual([
			request,
			expect.objectContaining({ id: request.id }),
		]);
		expect(supervisor.respondToServerRequest.mock.calls[0]?.[1]).toMatchObject({
			error: { data: { name: "OPERATION_FAILED" } },
		});
	});

	it("correlates successes and maps browser and generic failures", async () => {
		const { host, supervisor, browserManager } = harness();
		const success = browserRequest({ call: { tool: "browser_tabs", input: { action: "list" } } });
		browserManager.executeTool.mockResolvedValueOnce(tabsResult());
		host.handleRequest(success);
		await vi.waitFor(() => expect(supervisor.respondToServerRequest).toHaveBeenCalledOnce());
		expect(supervisor.respondToServerRequest).toHaveBeenLastCalledWith(success, {
			jsonrpc: "2.0",
			id: success.id,
			result: { toolCallId: success.params.toolCallId, result: tabsResult() },
		});

		const browserFailure = browserRequest({ id: "browser-rpc-2", toolCallId: "browser-call-2" });
		browserManager.executeTool.mockRejectedValueOnce(new BrowserToolError("OVERLOADED", "Too many tabs"));
		host.handleRequest(browserFailure);
		await vi.waitFor(() => expect(supervisor.respondToServerRequest).toHaveBeenCalledTimes(2));
		expect(supervisor.respondToServerRequest.mock.calls[1]?.[1]).toMatchObject({
			error: { data: { name: "OVERLOADED" } },
		});

		const genericFailure = browserRequest({ id: "browser-rpc-3", toolCallId: "browser-call-3" });
		browserManager.executeTool.mockRejectedValueOnce(new Error("private diagnostic"));
		host.handleRequest(genericFailure);
		await vi.waitFor(() => expect(supervisor.respondToServerRequest).toHaveBeenCalledTimes(3));
		expect(supervisor.respondToServerRequest.mock.calls[2]?.[1]).toMatchObject({
			error: { data: { name: "OPERATION_FAILED" } },
		});
	});

	it("rejects duplicate request ids while the first call is pending", () => {
		const { host, browserManager } = harness();
		browserManager.executeTool.mockReturnValue(deferred<BrowserToolResult>().promise);
		const request = browserRequest();
		host.handleRequest(request);

		expect(() => host.handleRequest(request)).toThrow("reused a pending browser request id");
		expect(browserManager.executeTool).toHaveBeenCalledOnce();
	});

	it("requires the exact cancellation tuple and ignores late settlement", async () => {
		const { host, supervisor, browserManager } = harness();
		const operation = deferred<BrowserToolResult>();
		browserManager.executeTool.mockReturnValue(operation.promise);
		const request = browserRequest();
		host.handleRequest(request);
		const signal = browserManager.executeTool.mock.calls[0]?.[2] as AbortSignal;

		host.handleCancellation(cancellation(request, { toolCallId: "wrong-call" }));
		expect(signal.aborted).toBe(false);

		host.handleCancellation(cancellation(request));
		expect(signal.aborted).toBe(true);
		operation.resolve(tabsResult());
		await operation.promise;
		await Promise.resolve();
		expect(supervisor.respondToServerRequest).not.toHaveBeenCalled();
	});

	it("suppresses a response after the supervisor leaves the request epoch", async () => {
		const { host, supervisor, browserManager, setView } = harness();
		const operation = deferred<BrowserToolResult>();
		browserManager.executeTool.mockReturnValue(operation.promise);
		host.handleRequest(browserRequest());

		setView({ state: "ready", serverEpoch: NEXT_EPOCH });
		operation.resolve(tabsResult());
		await operation.promise;
		await Promise.resolve();
		expect(supervisor.respondToServerRequest).not.toHaveBeenCalled();
	});

	it("cancels only work targeting a closed browser tab", () => {
		const { host, browserManager } = harness();
		browserManager.executeTool.mockImplementation(() => deferred<BrowserToolResult>().promise);
		const target = browserRequest({ id: "target", toolCallId: "target-call" });
		const other = browserRequest({
			id: "other",
			toolCallId: "other-call",
			call: { tool: "browser_observe", input: { browserId: OTHER_BROWSER_ID } },
		});
		const closing = browserRequest({
			id: "closing",
			toolCallId: "closing-call",
			call: { tool: "browser_tabs", input: { action: "close", browserId: BROWSER_ID } },
		});
		host.handleRequest(target);
		host.handleRequest(other);
		host.handleRequest(closing);
		const signals = browserManager.executeTool.mock.calls.map((call) => call[2] as AbortSignal);

		host.handleBrowserEvent({ type: "closed", sessionId: SESSION_ID, browserId: BROWSER_ID });

		expect(signals.map((signal) => signal.aborted)).toEqual([true, false, false]);
	});

	it("cancels only selected sessions and their handoffs", () => {
		const { host, supervisor, browserManager } = harness();
		browserManager.executeTool.mockImplementation(() => deferred<BrowserToolResult>().promise);
		host.handleRequest(browserRequest());
		host.handleRequest(browserRequest({ id: "other", sessionId: OTHER_SESSION_ID, toolCallId: "other-call" }));
		const signals = browserManager.executeTool.mock.calls.map((call) => call[2] as AbortSignal);

		host.cancelSessions(new Set([SESSION_ID]));

		expect(browserManager.cancelSessionHandoffs).toHaveBeenCalledWith(SESSION_ID, "tab_closed");
		expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
		expect(supervisor.respondToServerRequest).not.toHaveBeenCalled();
	});

	it("settles tab-close handoffs but drops old-epoch work on server restart", async () => {
		const { host, supervisor, browserManager } = harness();
		browserManager.executeTool.mockImplementation(
			(_sessionId: string, call: BrowserToolCall, signal: AbortSignal) =>
				new Promise<BrowserToolResult>((resolve) => {
					signal.addEventListener(
						"abort",
						() => {
							if (call.tool === "browser_handoff") {
								resolve({
									tool: "browser_handoff",
									details: { status: "cancelled", reason: "tab_closed" },
								});
							}
						},
						{ once: true },
					);
				}),
		);
		const handoff = browserRequest({
			call: { tool: "browser_handoff", input: { browserId: BROWSER_ID, reason: "login" } },
		});
		host.handleRequest(handoff);
		host.cancelAll("tab_closed");
		await vi.waitFor(() => expect(supervisor.respondToServerRequest).toHaveBeenCalledOnce());
		expect(supervisor.respondToServerRequest.mock.calls[0]?.[1]).toMatchObject({
			result: {
				result: { tool: "browser_handoff", details: { status: "cancelled", reason: "tab_closed" } },
			},
		});
		expect(browserManager.cancelSessionHandoffs).toHaveBeenCalledWith(SESSION_ID, "tab_closed");

		supervisor.respondToServerRequest.mockClear();
		browserManager.executeTool.mockImplementationOnce(() => deferred<BrowserToolResult>().promise);
		host.handleRequest(browserRequest({ id: "old-epoch", toolCallId: "old-call" }));
		const restartSignal = browserManager.executeTool.mock.calls.at(-1)?.[2] as AbortSignal;
		host.cancelAll("server_restarted");
		expect(restartSignal.aborted).toBe(true);
		expect(browserManager.cancelSessionHandoffs).toHaveBeenCalledWith(SESSION_ID, "server_restarted");
		expect(supervisor.respondToServerRequest).not.toHaveBeenCalled();
	});
});
