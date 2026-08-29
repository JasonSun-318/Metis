// @vitest-environment jsdom

import type { ItemView, PlanView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ConversationPlanFlow, useConversationPlanFlow } from "../src/renderer/hooks/use-conversation-plan-flow.ts";
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
		expect(vi.mocked(api.startTurn).mock.calls[0]?.[0].requestId)
			.toBe(vi.mocked(api.startTurn).mock.calls[1]?.[0].requestId);

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
		expect(api.startPlanExecution).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "session-1",
			planId: "plan-1",
			revision: 2,
		}));
		expect(flow.planActionsBusy).toBe(true);

		plan = { ...plan, status: "accepted" };
		await act(async () => root.render(<Harness />));
		expect(flow.currentProposedPlan).toBeUndefined();
		expect(flow.planActionsBusy).toBe(false);

		plan = { ...proposedPlan, revision: 3 };
		await act(async () => root.render(<Harness />));
		await act(async () => flow.cancelPlan(plan));
		expect(api.cancelPlan).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "session-1",
			planId: "plan-1",
			revision: 3,
		}));
		await act(async () => root.unmount());
	});
});
