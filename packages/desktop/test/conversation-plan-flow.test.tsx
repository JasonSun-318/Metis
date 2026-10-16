// @vitest-environment jsdom

import { type ItemView, type PlanView, RPC_ERROR_CODES } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ConversationPlanFlow,
	useConversationPlanFlow,
} from "../src/renderer/hooks/use-conversation-plan-flow.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const proposedPlan: PlanView = {
	planId: "plan-1",
	revision: 2,
	title: "Ship Plan mode",
	markdown: "# Plan\n\nShip it.",
	status: "proposed",
	createdAt: "2026-08-29T00:00:00.000Z",
};

function planItem(plan: PlanView): ItemView {
	return {
		itemId: "plan-item",
		sessionId: "session-1",
		role: "system",
		state: "completed",
		content: [{ type: "plan", plan }],
		createdAt: "2026-08-29T00:00:00.000Z",
		completedAt: "2026-08-29T00:00:00.000Z",
	};
}

afterEach(() => document.body.replaceChildren());

describe("useConversationPlanFlow", () => {
	it("rejects unavailable and concurrent submissions without letting an old task report errors in the new task", async () => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		let reject!: (error: Error) => void;
		const api = {
			startTurn: vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise((_, fail) => {
							reject = fail;
						}),
				)
				.mockResolvedValue({}),
		} as unknown as MetisDesktopApi;
		const reportError = vi.fn();
		let sessionId = "one",
			serverReady = false;
		let flow!: ConversationPlanFlow;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		function Harness() {
			flow = useConversationPlanFlow({
				api,
				sessionId,
				writableSessionId: sessionId,
				running: false,
				queuedTurnCount: 0,
				serverReady,
				syncReady: true,
				compacting: false,
				interactionPending: false,
				collaborationMode: "default",
				itemOrder: [],
				itemsById: new Map(),
				clearError: vi.fn(),
				reportError,
			});
			return null;
		}
		const input = { text: "edit", attachments: [] };
		try {
			await act(async () => root.render(<Harness />));
			await expect(flow.submit(input)).rejects.toThrow("not ready");
			expect(api.startTurn).not.toHaveBeenCalled();
			serverReady = true;
			await act(async () => root.render(<Harness />));
			const stale = flow.submit;
			const pending = flow.submit(input).catch((error) => error);
			await expect(flow.submit(input)).rejects.toThrow("already being submitted");
			sessionId = "two";
			await act(async () => root.render(<Harness />));
			await act(async () => flow.submit(input));
			reject(new Error("old task failed"));
			await expect(pending).resolves.toEqual(new Error("old task failed"));
			expect(reportError).not.toHaveBeenCalled();
			sessionId = "one";
			await act(async () => root.render(<Harness />));
			await expect(stale(input)).rejects.toThrow("not ready");
			await act(async () => flow.submit(input));
			expect(api.startTurn).toHaveBeenCalledTimes(3);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("reuses a failed submission request and routes later busy turns to the queue", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = {
			startTurn: vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({}),
			queueTurn: vi.fn().mockResolvedValue({}),
		} as unknown as MetisDesktopApi;
		let running = false;
		let flow!: ConversationPlanFlow;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const Harness = () => {
			flow = useConversationPlanFlow({
				api,
				sessionId: "session-1",
				writableSessionId: "session-1",
				running,
				queuedTurnCount: 0,
				serverReady: true,
				syncReady: true,
				compacting: false,
				interactionPending: false,
				collaborationMode: "default",
				itemOrder: [],
				itemsById: new Map(),
				clearError: vi.fn(),
				reportError: vi.fn(),
			});
			return null;
		};
		await act(async () => root.render(<Harness />));

		const input = { text: "hello", attachments: [] };
		await expect(act(async () => flow.submit(input))).rejects.toThrow("response lost");
		await act(async () => flow.submit(input));
		expect(api.startTurn).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.startTurn).mock.calls[0]?.[0].requestId).toBe(
			vi.mocked(api.startTurn).mock.calls[1]?.[0].requestId,
		);

		vi.mocked(api.startTurn)
			.mockRejectedValueOnce(Object.assign(new Error("turn rejected"), { code: RPC_ERROR_CODES.OPERATION_FAILED }))
			.mockResolvedValueOnce({ operationId: "operation-1", status: "accepted" });
		await expect(act(async () => flow.submit({ text: "known failure", attachments: [] }))).rejects.toThrow(
			"turn rejected",
		);
		await act(async () => flow.submit({ text: "known failure", attachments: [] }));
		expect(vi.mocked(api.startTurn).mock.calls[2]?.[0].requestId).not.toBe(
			vi.mocked(api.startTurn).mock.calls[3]?.[0].requestId,
		);

		running = true;
		await act(async () => root.render(<Harness />));
		await act(async () => flow.submit({ text: "next", attachments: [] }));
		expect(api.queueTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", text: "next" }));
		await act(async () => root.unmount());
	});

	it("owns exact-revision Plan actions and clears pending state after reconciliation", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const api = {
			startPlanExecution: vi.fn().mockResolvedValue({}),
			cancelPlan: vi.fn().mockResolvedValue({ collaborationMode: "default" }),
		} as unknown as MetisDesktopApi;
		let plan = proposedPlan;
		let flow!: ConversationPlanFlow;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const Harness = () => {
			flow = useConversationPlanFlow({
				api,
				sessionId: "session-1",
				writableSessionId: "session-1",
				running: false,
				queuedTurnCount: 0,
				serverReady: true,
				syncReady: true,
				compacting: false,
				interactionPending: false,
				collaborationMode: "plan",
				itemOrder: ["plan-item"],
				itemsById: new Map([["plan-item", planItem(plan)]]),
				clearError: vi.fn(),
				reportError: vi.fn(),
			});
			return null;
		};
		await act(async () => root.render(<Harness />));

		expect(flow.currentProposedPlan).toEqual(proposedPlan);
		await act(async () => flow.startPlan(proposedPlan));
		expect(api.startPlanExecution).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				planId: "plan-1",
				revision: 2,
			}),
		);
		expect(flow.planActionsBusy).toBe(true);

		plan = { ...plan, status: "accepted" };
		await act(async () => root.render(<Harness />));
		expect(flow.currentProposedPlan).toBeUndefined();
		expect(flow.planActionsBusy).toBe(false);

		plan = { ...proposedPlan, revision: 3 };
		await act(async () => root.render(<Harness />));
		await act(async () => flow.cancelPlan(plan));
		expect(api.cancelPlan).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				planId: "plan-1",
				revision: 3,
			}),
		);
		await act(async () => root.unmount());
	});
});
