import {
	type InteractionResponseInput,
	type InteractionView,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
	type ServerRpcRequest,
} from "@arcmind/app-protocol";
import type { PermissionApprovalRequest } from "@arcmind/coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/connection.ts";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import { SessionSubscriptions } from "../src/subscriptions.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "session-1";

class FakePeer implements InteractionPeer {
	readonly requests: InteractionView[] = [];
	response?: InteractionResponseInput;
	waitForever = false;

	async request(request: ServerRpcRequest, signal: AbortSignal): Promise<InteractionResponseInput> {
		this.requests.push(request.params.interaction);
		if (this.waitForever) {
			return await new Promise<InteractionResponseInput>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		if (!this.response) throw new Error("Interaction cancelled");
		return this.response;
	}
}

describe("InteractionBroker", () => {
	const childApproval = (overrides: Partial<PermissionApprovalRequest> = {}): PermissionApprovalRequest => ({
		action: {
			actionId: "action-1",
			toolName: "bash",
			provenance: "builtin",
			risks: ["network"],
			paths: ["/tmp/work/result.txt"],
			networkTargets: [],
			command: "curl https://example.test",
		},
		args: { command: "curl https://example.test" },
		reason: "Network destination needs approval",
		actor: { type: "subagent", id: "agent-child-1", name: "researcher" },
		...overrides,
	});

	it("routes complete child permission details to the owning peer", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000320";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "select", choiceId: "choice:0" };

		await expect(broker.requestPermissionApproval(SESSION_ID, childApproval())).resolves.toEqual({
			decision: "allow",
		});
		expect(peer.requests[0]).toMatchObject({
			kind: "select",
			title: "Approve bash?",
			choices: [
				{ id: "choice:0", label: "Allow once" },
				{ id: "choice:1", label: "Deny" },
			],
		});
		expect(peer.requests[0]?.message).toContain("Subagent: researcher (agent-child-1)");
		expect(peer.requests[0]?.message).toContain("Risk: network");
		expect(peer.requests[0]?.message).toContain('"command": "curl https://example.test"');
		expect(peer.requests[0]?.message).toContain("Path: /tmp/work/result.txt");
		expect(peer.requests[0]?.message).toContain("ArcMind does not sandbox this action");
	});

	it("fails a child permission request closed without an owning peer", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		await expect(broker.requestPermissionApproval(SESSION_ID, childApproval())).rejects.toThrow(
			"Approval was unavailable or cancelled",
		);
	});

	it("denies project trust when no interaction owner is connected", async () => {
		const broker = new InteractionBroker({
			serverEpoch: EPOCH,
			createId: () => "00000000-0000-4000-8000-000000000301",
		});
		const selected = await broker.requestProjectTrust(SESSION_ID, "/tmp/project", [
			{ label: "Trust", trusted: true, updates: [] },
			{ label: "Do not trust", trusted: false, updates: [] },
		]);

		expect(selected).toBeUndefined();
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("returns only a choice from the exact project-trust request", async () => {
		const broker = new InteractionBroker({
			serverEpoch: EPOCH,
			createId: () => "00000000-0000-4000-8000-000000000301",
		});
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = {
			interactionId: "00000000-0000-4000-8000-000000000301",
			kind: "project_trust",
			choiceId: "choice:1",
		};
		const options = [
			{ label: "Trust parent", trusted: true, updates: [{ path: "/tmp", decision: true }] },
			{ label: "Do not trust this session", trusted: false, updates: [] },
		];

		const selected = await broker.requestProjectTrust(SESSION_ID, "/tmp/project", options);
		expect(peer.requests).toHaveLength(1);
		expect(peer.requests[0]).toMatchObject({
			kind: "project_trust",
			projectPath: "/tmp/project",
			choices: [{ id: "choice:0" }, { id: "choice:1" }],
		});
		expect(selected).toBe(options[1]);
	});

	it("cancels a timed-out dialog and rejects a stale owner", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH, defaultTimeoutMs: 10 });
		const peer = new FakePeer();
		peer.waitForever = true;
		broker.assign(SESSION_ID, peer);
		const ui = broker.createExtensionUIContext(SESSION_ID, () => undefined);

		await expect(ui.confirm("Continue?", "This should time out.")).resolves.toBe(false);
		expect(broker.hasPending(SESSION_ID)).toBe(false);
		broker.releasePeer(peer);
		await expect(ui.input("Value")).resolves.toBeUndefined();
	});

	it("bridges select, input, and notify without exposing other UI capabilities", async () => {
		const ids = [
			"00000000-0000-4000-8000-000000000302",
			"00000000-0000-4000-8000-000000000305",
			"00000000-0000-4000-8000-000000000303",
			"00000000-0000-4000-8000-000000000306",
			"00000000-0000-4000-8000-000000000304",
		];
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => ids.shift()! });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		const notifications = vi.fn();
		const ui = broker.createExtensionUIContext(SESSION_ID, notifications);

		peer.response = {
			interactionId: "00000000-0000-4000-8000-000000000302",
			kind: "select",
			choiceId: "choice:0",
		};
		expect(await ui.select("Choose", ["First", "Second"])).toBe("First");

		peer.response = {
			interactionId: "00000000-0000-4000-8000-000000000303",
			kind: "input",
			value: "answer",
		};
		expect(await ui.input("Value", "placeholder")).toBe("answer");

		ui.notify("Ready", "warning");
		expect(notifications).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "interaction/notify",
				notificationId: "00000000-0000-4000-8000-000000000304",
				sessionId: SESSION_ID,
				level: "warning",
				message: "Ready",
			}),
		);
		expect(Object.hasOwn(ui, "custom")).toBe(true);
	});

	it("bounds extension-controlled interaction content at the protocol boundary", async () => {
		const ids = [
			"00000000-0000-4000-8000-000000000311",
			"00000000-0000-4000-8000-000000000312",
			"00000000-0000-4000-8000-000000000313",
		];
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => ids.shift()! });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		const notifications = vi.fn();
		const ui = broker.createExtensionUIContext(SESSION_ID, notifications);
		peer.response = {
			interactionId: "00000000-0000-4000-8000-000000000311",
			kind: "select",
			choiceId: "choice:0",
		};

		const options = Array.from({ length: MAX_INTERACTION_CHOICES + 1 }, (_, index) =>
			index === 0 ? "" : "😀".repeat(MAX_NAME_UTF16_UNITS),
		);
		await expect(ui.select("T".repeat(MAX_NAME_UTF16_UNITS + 1), options)).resolves.toBe("");
		const request = peer.requests[0];
		expect(request?.title).toHaveLength(MAX_NAME_UTF16_UNITS);
		expect(request?.kind === "select" ? request.choices : []).toHaveLength(MAX_INTERACTION_CHOICES);
		expect(request?.kind === "select" ? request.choices[0]?.label : undefined).toBe("Option 1");
		expect(request?.kind === "select" ? request.choices[1]?.label.length : 0).toBeLessThanOrEqual(
			MAX_NAME_UTF16_UNITS,
		);

		ui.notify("界".repeat(MAX_PUBLIC_TEXT_UTF8_BYTES), "info");
		const notification = notifications.mock.calls[0]?.[0];
		expect(Buffer.byteLength(notification.message, "utf8")).toBeLessThanOrEqual(MAX_PUBLIC_TEXT_UTF8_BYTES);
	});

	it("does not publish a dialog for an already-aborted extension request", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		const ui = broker.createExtensionUIContext(SESSION_ID, () => undefined);
		const controller = new AbortController();
		controller.abort();

		await expect(ui.confirm("Continue?", "Cancelled", { signal: controller.signal })).resolves.toBe(false);
		expect(peer.requests).toHaveLength(0);
	});

	it("round-trips a typed server request through the owning app-server connection", async () => {
		const connection = new AppServerConnection({
			dispatcher: { dispatch: vi.fn() } as never,
			serverEpoch: EPOCH,
			serverVersion: "test",
			subscriptionHub: new SessionSubscriptions(EPOCH),
		});
		const outbound: unknown[] = [];
		connection.onMessage((envelope) => {
			outbound.push(envelope);
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "initialize",
			method: "initialize",
			params: { protocolVersion: 3, client: { name: "test", version: "1" }, capabilities: [] },
		});
		const ids = ["00000000-0000-4000-8000-000000000307", "00000000-0000-4000-8000-000000000308"];
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => ids.shift()! });
		broker.assign(SESSION_ID, connection);
		const ui = broker.createExtensionUIContext(SESSION_ID, () => undefined);

		const confirmed = ui.confirm("Continue?", "Confirm this action.");
		await vi.waitFor(() => expect(outbound).toHaveLength(1));
		const request = outbound[0] as ServerRpcRequest;
		expect(request).toMatchObject({ method: "interaction/request", params: { serverEpoch: EPOCH } });
		expect(
			connection.handleServerResponse({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					interactionId: "00000000-0000-4000-8000-000000000307",
					kind: "confirm",
					confirmed: true,
				},
			}),
		).toBe(true);
		await expect(confirmed).resolves.toBe(true);
		connection.close();
	});

	it("cancels connection-owned requests on disconnect and ignores stale responses", async () => {
		const connection = new AppServerConnection({
			dispatcher: { dispatch: vi.fn() } as never,
			serverEpoch: EPOCH,
			serverVersion: "test",
			subscriptionHub: new SessionSubscriptions(EPOCH),
		});
		connection.onMessage(() => undefined);
		await connection.handle({
			jsonrpc: "2.0",
			id: "initialize",
			method: "initialize",
			params: { protocolVersion: 3, client: { name: "test", version: "1" }, capabilities: [] },
		});
		const ids = ["00000000-0000-4000-8000-000000000309", "00000000-0000-4000-8000-000000000310"];
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => ids.shift()! });
		broker.assign(SESSION_ID, connection);
		const ui = broker.createExtensionUIContext(SESSION_ID, () => undefined);

		const confirmed = ui.confirm("Continue?", "Disconnect first.");
		connection.close();
		await expect(confirmed).resolves.toBe(false);
		expect(
			connection.handleServerResponse({
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000999",
				result: {
					interactionId: "00000000-0000-4000-8000-000000000998",
					kind: "confirm",
					confirmed: true,
				},
			}),
		).toBe(true);
	});
});
