import type {
	DomainEvent,
	InteractionResponseInput,
	InteractionView,
	ServerRequestMethod,
	ServerResult,
	ServerRpcRequest,
} from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import { SessionProjection } from "../src/projection/session-projection.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "session-protocol";
const REQUEST_A = "00000000-0000-4000-8000-000000000001";

const PRESET_SETTINGS = {
	ask: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
	auto: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
	full: { sandboxPolicy: "danger-full-access", approvalPolicy: "user" },
} as const;

class RecordingPeer implements InteractionPeer {
	readonly requests: InteractionView[] = [];
	response?: InteractionResponseInput;
	waitForever = false;

	async request(request: ServerRpcRequest, signal: AbortSignal): Promise<ServerResult<ServerRequestMethod>> {
		const interactionRequest = request as ServerRpcRequest<"interaction/request">;
		this.requests.push(interactionRequest.params.interaction);
		if (this.waitForever) {
			return await new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		if (!this.response) throw new Error("Interaction cancelled");
		return this.response;
	}
}

function approvalRequest(actionId = "action-1") {
	return {
		action: {
			actionId,
			toolName: "bash",
			provenance: "builtin" as const,
			risks: ["network" as const],
			paths: ["/tmp/work/out.txt"],
			networkTargets: [],
			command: "curl https://example.test",
		},
		args: { command: "curl https://example.test", token: "sk-secret" },
		reason: "Network destination needs approval",
		cwd: "/tmp/work",
		executionTarget: "host" as const,
	};
}

describe("permission protocol", () => {
	it("round-trips each preset with derived effective settings", () => {
		const projection = new SessionProjection({
			session: {
				sessionId: SESSION_ID,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd: "/tmp/project",
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-01T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
			},
		});
		for (const preset of ["ask", "auto", "full"] as const) {
			const event: DomainEvent = {
				type: "session/permissionPresetChanged",
				sessionId: SESSION_ID,
				permissionPreset: preset,
				effectiveSettings: PRESET_SETTINGS[preset],
				constrainedByParent: false,
				sandboxHealth: "healthy",
			};
			expect(projection.apply(event)).toEqual(event);
			const snapshot = projection.snapshot(EPOCH, 1, {
				collaborationMode: "default",
				permissionPreset: preset,
				effectiveSettings: PRESET_SETTINGS[preset],
				constrainedByParent: false,
				sandboxHealth: "healthy",
				thinkingSelection: "off",
				actualThinkingLevel: "off",
				availableThinkingSelections: ["off"],
				agents: [],
				nextAgentAfterId: null,
			});
			expect(snapshot).toMatchObject({
				permissionPreset: preset,
				effectiveSettings: PRESET_SETTINGS[preset],
				constrainedByParent: false,
				sandboxHealth: "healthy",
			});
			const serialized = JSON.stringify(snapshot);
			expect(serialized).not.toContain("permissionMode");
			expect(serialized).not.toContain("setPermissionMode");
		}
	});

	it("streams review start and completion without prompt or reasoning", () => {
		const projection = new SessionProjection({
			session: {
				sessionId: SESSION_ID,
				mode: "code",
				cwdOrigin: "user-selected",
				cwd: "/tmp/project",
				createdAt: "2026-09-01T00:00:00.000Z",
				updatedAt: "2026-09-01T00:00:00.000Z",
				state: "idle",
				archived: false,
				unread: false,
			},
		});
		const events: DomainEvent[] = [
			{
				type: "session/permissionReviewStarted",
				sessionId: SESSION_ID,
				actionId: "action-review-1",
				reviewer: "model",
				riskLevel: "high",
			},
			{
				type: "session/permissionReviewCompleted",
				sessionId: SESSION_ID,
				actionId: "action-review-1",
				reviewer: "model",
				outcome: "unavailable",
				riskLevel: "high",
			},
		];
		expect(events.map((event) => projection.apply(event))).toEqual(events);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("MODEL_PERMISSION_REVIEW_PROMPT");
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("data:application/octet-stream;base64,");
		expect(serialized).not.toMatch(/"prompt"|"reasoning"/);
		expect(Object.keys(events[0] as object).sort()).toEqual([
			"actionId",
			"reviewer",
			"riskLevel",
			"sessionId",
			"type",
		]);
	});

	it("resolves an approval once for the matching session/request/action", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "permission_approval", choice: "allow-once" };
		broker.assign(SESSION_ID, peer);
		await expect(broker.requestPermissionApproval(SESSION_ID, approvalRequest())).resolves.toEqual({
			decision: "allow",
		});
		expect(peer.requests[0]).toMatchObject({
			kind: "permission_approval",
			requestId: REQUEST_A,
			actionId: "action-1",
			toolLabel: "bash",
			executionTarget: "host",
			choices: ["allow-once", "deny-once"],
		});
		const serialized = JSON.stringify(peer.requests[0]);
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("permission:allow-once");
		expect(serialized).not.toMatch(/"presentation":"permission_approval"/);
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("rejects a second in-flight approval for the same action", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.waitForever = true;
		broker.assign(SESSION_ID, peer);
		const first = broker.requestPermissionApproval(SESSION_ID, approvalRequest("action-dup"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(broker.requestPermissionApproval(SESSION_ID, approvalRequest("action-dup"))).rejects.toThrow(
			"Approval was unavailable or cancelled",
		);
		broker.releaseSession(SESSION_ID);
		await expect(first).rejects.toThrow("Approval was unavailable or cancelled");
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("settles a pending approval as unavailable on disconnect", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.waitForever = true;
		broker.assign(SESSION_ID, peer);
		const pending = broker.requestPermissionApproval(SESSION_ID, approvalRequest("action-disconnect"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(broker.hasPending(SESSION_ID)).toBe(true);
		broker.releasePeer(peer);
		await expect(pending).rejects.toThrow("Approval was unavailable or cancelled");
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});
});
