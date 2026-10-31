import type {
	DomainEvent,
	InteractionResponseInput,
	InteractionView,
	ServerRequestMethod,
	ServerResult,
	ServerRpcRequest,
} from "@metis/app-protocol";
import { ProtocolValidationError, validateClientRequest, validateResponseFor } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import { opaqueId } from "../src/item-projection.ts";
import { SessionProjection } from "../src/projection/session-projection.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "session-protocol";
const REQUEST_A = "00000000-0000-4000-8000-000000000001";

const PRESET_SETTINGS = {
	ask: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
	auto: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
	full: { sandboxPolicy: "danger-full-access", approvalPolicy: "never" },
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
		scopeComplete: true,
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
				useMemory: true,
				contributeMemory: true,
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
			expect(serialized).toContain(`"permissionPreset":"${preset}"`);
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
				useMemory: true,
				contributeMemory: true,
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
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-once" };
		broker.assign(SESSION_ID, peer);
		await expect(broker.requestPermissionApproval(SESSION_ID, approvalRequest())).resolves.toEqual({
			decision: "allow",
		});
		expect(peer.requests[0]).toMatchObject({
			kind: "session_permission_approval",
			requestId: REQUEST_A,
			actionId: "action-1",
			toolLabel: "bash",
			executionTarget: "host",
			choices: ["allow-once", "deny-once"],
		});
		const serialized = JSON.stringify(peer.requests[0]);
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("permission:allow-once");
		expect(serialized).not.toMatch(/"presentation":"session_permission_approval"/);
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it.each(["call_01|fc_02", `call_${"x".repeat(150)}`])(
		"delivers approval for provider ID %s without changing its original identity",
		async (actionId) => {
			for (const choice of ["allow-once", "deny-once"] as const) {
				const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
				const peer = new RecordingPeer();
				peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice };
				broker.assign(SESSION_ID, peer);
				const approval = approvalRequest(actionId);
				await expect(broker.requestPermissionApproval(SESSION_ID, approval)).resolves.toMatchObject({
					decision: choice === "allow-once" ? "allow" : "deny",
				});
				expect(peer.requests).toHaveLength(1);
				expect(peer.requests[0]).toMatchObject({ actionId: opaqueId(actionId, "tool") });
				expect(approval.action.actionId).toBe(actionId);
				expect(broker.hasPending(SESSION_ID)).toBe(false);
			}
		},
	);

	it.each(["action-dup", "call_dup|fc_dup"])("rejects duplicate approval %s", async (actionId) => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.waitForever = true;
		broker.assign(SESSION_ID, peer);
		const first = broker.requestPermissionApproval(SESSION_ID, approvalRequest(actionId));
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(broker.requestPermissionApproval(SESSION_ID, approvalRequest(actionId))).rejects.toThrow(
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

	it("round-trips a session-exact remember choice with the full redacted command", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-session-exact" };
		broker.assign(SESSION_ID, peer);
		const approval = {
			...approvalRequest(),
			action: {
				...approvalRequest().action,
				command: 'curl -H "Authorization: Bearer sk-secret" https://example.test',
			},
			rememberSessionEligible: true,
		};
		await expect(broker.requestPermissionApproval(SESSION_ID, approval)).resolves.toEqual({
			decision: "allow",
			remember: "session",
		});
		const interaction = peer.requests[0] as Extract<InteractionView, { kind: "session_permission_approval" }>;
		expect(interaction.choices).toEqual(["allow-once", "allow-session-exact", "deny-once"]);
		expect(interaction.rememberSessionEligible).toBe(true);
		expect(interaction.command).toBe('curl -H "Authorization: <redacted>" https://example.test');
		const serialized = JSON.stringify(interaction);
		expect(serialized).not.toContain("sk-secret");
	});

	it("never offers a session-exact choice without session eligibility", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-session-exact" };
		broker.assign(SESSION_ID, peer);
		await expect(
			broker.requestPermissionApproval(SESSION_ID, { ...approvalRequest(), rememberSessionEligible: true }),
		).resolves.toEqual({ decision: "allow", remember: "session" });
		const ineligible = { ...approvalRequest(), scopeComplete: false, rememberSessionEligible: true };
		peer.response = {
			interactionId: REQUEST_A,
			kind: "session_permission_approval",
			choice: "allow-session-exact",
		};
		// The unoffered choice is rejected before it can become a decision.
		await expect(broker.requestPermissionApproval(SESSION_ID, ineligible)).rejects.toThrow(
			"Approval was unavailable or cancelled",
		);
	});

	it("displays an exactly 32 KiB redacted command in full without truncation", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "deny-once" };
		broker.assign(SESSION_ID, peer);
		const command = `curl ${"a".repeat(32_768 - 5)}`;
		expect(Buffer.byteLength(command, "utf8")).toBe(32_768);
		await expect(
			broker.requestPermissionApproval(SESSION_ID, {
				...approvalRequest(),
				action: { ...approvalRequest().action, command },
			}),
		).resolves.toEqual({
			decision: "deny",
			reason: "Denied by the session owner",
		});
		const interaction = peer.requests[0] as Extract<InteractionView, { kind: "session_permission_approval" }>;
		expect(interaction.command).toBe(command);
		expect(Buffer.byteLength(interaction.command ?? "", "utf8")).toBe(32_768);
	});

	it("never generates an approvable interaction for a command over 32 KiB", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-once" };
		broker.assign(SESSION_ID, peer);
		const oversized = {
			...approvalRequest(),
			action: { ...approvalRequest().action, command: `curl ${"a".repeat(32_768)}` },
		};
		await expect(broker.requestPermissionApproval(SESSION_ID, oversized)).rejects.toThrow(
			"split it into smaller commands and retry",
		);
		expect(peer.requests).toHaveLength(0);
		// No pending approval state leaks: the same action may be retried.
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "deny-once" };
		await expect(broker.requestPermissionApproval(SESSION_ID, approvalRequest())).resolves.toMatchObject({
			decision: "deny",
		});
	});

	it("rejects an oversized original even when redaction would shrink it", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-once" };
		broker.assign(SESSION_ID, peer);
		const request = {
			...approvalRequest(),
			action: { ...approvalRequest().action, command: `TOKEN=${"x".repeat(33_000)} curl https://example.test` },
		};
		await expect(broker.requestPermissionApproval(SESSION_ID, request)).rejects.toThrow(
			"split it into smaller commands and retry",
		);
		expect(peer.requests).toHaveLength(0);
	});

	it("never truncates a command whose redaction expands it past 32 KiB", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => REQUEST_A });
		const peer = new RecordingPeer();
		peer.response = { interactionId: REQUEST_A, kind: "session_permission_approval", choice: "allow-once" };
		broker.assign(SESSION_ID, peer);
		// Each short secret assignment expands by 8 bytes under redaction; the
		// original stays inside the bound while the redacted form exceeds it.
		const command = `env ${"TOKEN=aa ".repeat(1928)}`;
		expect(Buffer.byteLength(command, "utf8")).toBeLessThanOrEqual(32_768);
		const oversized = { ...approvalRequest(), action: { ...approvalRequest().action, command } };
		await expect(broker.requestPermissionApproval(SESSION_ID, oversized)).rejects.toThrow(
			"split it into smaller commands and retry",
		);
		expect(peer.requests).toHaveLength(0);
	});

	it("keeps project scope as the default and accepts explicit session scope", () => {
		const list = (scope?: string) => ({
			jsonrpc: "2.0",
			id: "rules-list",
			method: "permission/rules/list",
			params: scope === undefined ? { sessionId: SESSION_ID } : { sessionId: SESSION_ID, scope },
		});
		expect(validateClientRequest(list())).toEqual(list());
		expect(validateClientRequest(list("project"))).toEqual(list("project"));
		expect(validateClientRequest(list("session"))).toEqual(list("session"));
		expect(() => validateClientRequest(list("owner"))).toThrow(ProtocolValidationError);
	});

	it("validates global Auto command allowlist envelopes", () => {
		const get = {
			jsonrpc: "2.0",
			id: "auto-get",
			method: "permission/auto/get",
			params: {},
		};
		expect(validateClientRequest(get)).toEqual(get);
		const update = {
			jsonrpc: "2.0",
			id: "auto-update",
			method: "permission/auto/update",
			params: {
				requestId: REQUEST_A,
				rules: [{ command: "git status", allowNetwork: false }],
			},
		};
		expect(validateClientRequest(update)).toEqual(update);
		const view = {
			jsonrpc: "2.0",
			id: "auto-update",
			result: {
				rules: [{ command: "git status", allowNetwork: false }],
				suggestions: ["ls", "git status"],
				permissionRules: [],
				permissionRuleDefaults: [],
				reviewerEnabled: false,
			},
		};
		expect(validateResponseFor("client", update, view)).toEqual(view);
		expect(() =>
			validateClientRequest({
				...update,
				params: { ...update.params, extra: true },
			}),
		).toThrow(ProtocolValidationError);
	});
});
