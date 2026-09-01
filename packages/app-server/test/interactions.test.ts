import {
	type BrowserToolCall,
	type BrowserToolRequestResult,
	type InteractionResponseInput,
	type InteractionView,
	MAX_INTERACTION_CHOICES,
	MAX_NAME_UTF16_UNITS,
	MAX_PERMISSION_OPERATION_ROWS,
	MAX_PUBLIC_TEXT_UTF8_BYTES,
	PROTOCOL_VERSION,
	type ServerRequestMethod,
	type ServerResult,
	type ServerRpcRequest,
} from "@metis/app-protocol";
import {
	type AskUserInput,
	type AskUserRequest,
	createAskUserToolDefinition,
	type PermissionApprovalRequest,
} from "@metis/coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AppServerConnection } from "../src/connection.ts";
import { InteractionBroker, type InteractionPeer } from "../src/interactions.ts";
import { SessionSubscriptions } from "../src/subscriptions.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "session-1";

class FakePeer implements InteractionPeer {
	readonly requests: InteractionView[] = [];
	readonly browserRequests: ServerRpcRequest<"browser/tool">[] = [];
	response?: InteractionResponseInput;
	browserResponse?: BrowserToolRequestResult;
	browserResponseFor?: (request: ServerRpcRequest<"browser/tool">) => BrowserToolRequestResult;
	responseFor?: (interaction: InteractionView) => InteractionResponseInput;
	waitForever = false;

	async request(request: ServerRpcRequest, signal: AbortSignal): Promise<ServerResult<ServerRequestMethod>> {
		if (request.method === "browser/tool") {
			const browserRequest = request as ServerRpcRequest<"browser/tool">;
			this.browserRequests.push(browserRequest);
			const response = this.browserResponseFor?.(browserRequest) ?? this.browserResponse;
			if (!response) throw new Error("Browser response is unavailable");
			return response;
		}
		const interactionRequest = request as ServerRpcRequest<"interaction/request">;
		this.requests.push(interactionRequest.params.interaction);
		if (this.waitForever) {
			return await new Promise<ServerResult<ServerRequestMethod>>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		const response = this.responseFor?.(interactionRequest.params.interaction) ?? this.response;
		if (!response) throw new Error("Interaction cancelled");
		return response;
	}
}

function permissionInteraction(peer: FakePeer): Extract<InteractionView, { kind: "permission_approval" }> {
	const interaction = peer.requests[0];
	if (interaction?.kind !== "permission_approval") throw new TypeError("Expected a permission_approval interaction");
	return interaction;
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
		cwd: "/tmp/work",
		executionTarget: "host",
		actor: { type: "agent", id: "agent-child-1", name: "researcher", taskId: "task-1" },
		...overrides,
	});
	const askUserRequest = (overrides: Partial<AskUserRequest> = {}): AskUserRequest => ({
		questions: [
			{
				question: "Where should task data be stored?",
				multiple: false,
				options: [
					{ label: "Local database", description: "Works offline" },
					{ label: "Cloud sync", description: "Works across devices" },
				],
			},
			{
				question: "Which clients should be supported?",
				multiple: true,
				options: [{ label: "Desktop" }, { label: "Web" }, { label: "Mobile" }],
			},
		],
		...overrides,
	});
	const askUserInput = (): AskUserInput => ({
		questions: askUserRequest().questions.map((question) => ({
			question: question.question,
			multiple: question.multiple,
			options: question.options.map((option) => ({ ...option })),
		})),
	});
	const browserTabsCall = (): BrowserToolCall => ({ tool: "browser_tabs", input: { action: "list" } });
	const browserTabsResponse = (toolCallId: string): BrowserToolRequestResult => ({
		toolCallId,
		result: {
			tool: "browser_tabs",
			details: {
				profiles: [{ profileId: "00000000-0000-4000-8000-000000000001", name: "Default", sourceId: null }],
				tabs: [],
			},
		},
	});
	const browserObservation = (
		revision: number,
		state = 'document WebArea "Fixture"\n  e4 button "Delete account"',
	) => ({
		browserId: "88888888-8888-4888-8888-888888888888",
		profileId: "00000000-0000-4000-8000-000000000001",
		documentId: "99999999-9999-4999-8999-999999999999",
		revision,
		change: "full" as const,
		url: "https://example.test/page",
		title: "Fixture",
		loading: false,
		state,
	});
	const browserObserveResponse = (toolCallId: string, revision: number): BrowserToolRequestResult => ({
		toolCallId,
		result: { tool: "browser_observe", observation: browserObservation(revision) },
	});

	it("routes an ordinary browser tool directly to the desktop owner", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-unowned", browserTabsCall(), new AbortController().signal),
		).rejects.toThrow("No interactive desktop owner");

		const firstPeer = new FakePeer();
		firstPeer.browserResponse = browserTabsResponse("browser-call-1");
		broker.assign(SESSION_ID, firstPeer);

		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-1", browserTabsCall(), new AbortController().signal),
		).resolves.toEqual(firstPeer.browserResponse.result);
		expect(firstPeer.requests).toHaveLength(0);
		expect(firstPeer.browserRequests).toHaveLength(1);
		expect(firstPeer.browserRequests[0]).toMatchObject({
			method: "browser/tool",
			params: { serverEpoch: EPOCH, sessionId: SESSION_ID, toolCallId: "browser-call-1" },
		});

		broker.release(SESSION_ID, firstPeer);
		await expect(
			broker.requestBrowserTool(
				SESSION_ID,
				"browser-call-released",
				browserTabsCall(),
				new AbortController().signal,
			),
		).rejects.toThrow("No interactive desktop owner");

		const replacementPeer = new FakePeer();
		replacementPeer.browserResponse = browserTabsResponse("browser-call-reconnected");
		broker.assign(SESSION_ID, replacementPeer);
		await expect(
			broker.requestBrowserTool(
				SESSION_ID,
				"browser-call-reconnected",
				browserTabsCall(),
				new AbortController().signal,
			),
		).resolves.toEqual(replacementPeer.browserResponse.result);
		expect(replacementPeer.browserRequests).toHaveLength(1);
	});

	it("confirms a high-risk browser action immediately before dispatch", async () => {
		const ids = [
			"00000000-0000-4000-8000-000000000401",
			"00000000-0000-4000-8000-000000000402",
			"00000000-0000-4000-8000-000000000403",
			"00000000-0000-4000-8000-000000000404",
			"00000000-0000-4000-8000-000000000405",
		];
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => ids.shift()! });
		const peer = new FakePeer();
		peer.responseFor = (interaction) => ({
			interactionId: interaction.interactionId,
			kind: "confirm",
			confirmed: true,
		});
		const actionResponse: BrowserToolRequestResult = {
			toolCallId: "browser-call-2",
			result: { tool: "browser_act", details: { status: "cancelled", reason: "user_cancelled" } },
		};
		peer.browserResponseFor = (request) =>
			request.params.call.tool === "browser_observe"
				? browserObserveResponse(request.params.toolCallId, 4)
				: actionResponse;
		broker.assign(SESSION_ID, peer);
		const call: BrowserToolCall = {
			tool: "browser_act",
			input: {
				browserId: "88888888-8888-4888-8888-888888888888",
				documentId: "99999999-9999-4999-8999-999999999999",
				snapshotRevision: 4,
				origin: "https://example.test",
				intent: "Delete the fixture record",
				risk: "destructive",
				action: { type: "click", target: { elementId: "e4" } },
			},
		};

		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-2", call, new AbortController().signal),
		).resolves.toEqual(actionResponse.result);
		expect(peer.requests).toHaveLength(1);
		expect(peer.requests[0]).toMatchObject({
			kind: "confirm",
			title: "Allow browser action?",
			message: expect.stringMatching(/Site: https:\/\/example\.test[\s\S]*Target: Delete account/u),
		});
		expect(peer.browserRequests.map((request) => request.params.call.tool)).toEqual([
			"browser_observe",
			"browser_act",
		]);
	});

	it("does not dispatch a rejected or unowned browser action", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-3", browserTabsCall(), new AbortController().signal),
		).rejects.toThrow("No interactive desktop owner");

		const peer = new FakePeer();
		peer.responseFor = (interaction) => ({
			interactionId: interaction.interactionId,
			kind: "confirm",
			confirmed: false,
		});
		peer.browserResponseFor = (request) => browserObserveResponse(request.params.toolCallId, 1);
		broker.assign(SESSION_ID, peer);
		const action: BrowserToolCall = {
			tool: "browser_act",
			input: {
				browserId: "88888888-8888-4888-8888-888888888888",
				documentId: "99999999-9999-4999-8999-999999999999",
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Submit the fixture form",
				risk: "external_side_effect",
				action: { type: "press", key: "Enter" },
			},
		};
		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-4", action, new AbortController().signal),
		).rejects.toThrow("rejected");
		expect(peer.browserRequests.map((request) => request.params.call.tool)).toEqual(["browser_observe"]);
	});

	it("distinguishes cancelled and unavailable browser confirmation from a user rejection", async () => {
		const action: BrowserToolCall = {
			tool: "browser_act",
			input: {
				browserId: "88888888-8888-4888-8888-888888888888",
				documentId: "99999999-9999-4999-8999-999999999999",
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Submit the fixture form",
				risk: "external_side_effect",
				action: { type: "press", key: "Enter" },
			},
		};
		const unavailableBroker = new InteractionBroker({ serverEpoch: EPOCH });
		const unavailablePeer = new FakePeer();
		unavailablePeer.browserResponseFor = (request) => browserObserveResponse(request.params.toolCallId, 1);
		unavailableBroker.assign(SESSION_ID, unavailablePeer);
		await expect(
			unavailableBroker.requestBrowserTool(SESSION_ID, "browser-unavailable", action, new AbortController().signal),
		).rejects.toMatchObject({ name: "BrowserPermissionDecisionUnavailableError", outcome: "unavailable" });

		const cancelledBroker = new InteractionBroker({ serverEpoch: EPOCH });
		const cancelledPeer = new FakePeer();
		cancelledPeer.browserResponseFor = (request) => browserObserveResponse(request.params.toolCallId, 1);
		cancelledBroker.assign(SESSION_ID, cancelledPeer);
		const controller = new AbortController();
		controller.abort(new Error("session cancelled"));
		await expect(
			cancelledBroker.requestBrowserTool(SESSION_ID, "browser-cancelled", action, controller.signal),
		).rejects.toMatchObject({ name: "BrowserPermissionDecisionUnavailableError", outcome: "cancelled" });
	});

	it("returns a trusted stale result before confirmation when the live target changed", async () => {
		const broker = new InteractionBroker({ serverEpoch: EPOCH });
		const peer = new FakePeer();
		peer.browserResponseFor = (request) => browserObserveResponse(request.params.toolCallId, 2);
		broker.assign(SESSION_ID, peer);
		const call: BrowserToolCall = {
			tool: "browser_act",
			input: {
				browserId: "88888888-8888-4888-8888-888888888888",
				documentId: "99999999-9999-4999-8999-999999999999",
				snapshotRevision: 1,
				origin: "https://example.test",
				intent: "Delete the fixture record",
				risk: "destructive",
				action: { type: "click", target: { elementId: "e4" } },
			},
		};

		await expect(
			broker.requestBrowserTool(SESSION_ID, "browser-call-stale", call, new AbortController().signal),
		).resolves.toMatchObject({ tool: "browser_act", details: { status: "stale", reason: "revision_changed" } });
		expect(peer.requests).toHaveLength(0);
		expect(peer.browserRequests.map((request) => request.params.call.tool)).toEqual(["browser_observe"]);
	});

	it("routes ask_user questions and maps selected IDs back to ordered option indexes", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000350";
		const now = Date.parse("2026-08-10T00:00:00.000Z");
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId, now: () => now });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = {
			interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [
				{ questionId: "question:0", choiceIds: ["choice:1"] },
				{
					questionId: "question:1",
					choiceIds: ["choice:0", "choice:2"],
					customAnswer: "Linux later",
				},
			],
		};

		await expect(broker.requestUserInput(SESSION_ID, askUserRequest())).resolves.toEqual({
			cancelled: false,
			answers: [{ selectedOptionIndexes: [1] }, { selectedOptionIndexes: [0, 2], customAnswer: "Linux later" }],
		});
		expect(peer.requests).toEqual([
			expect.objectContaining({
				kind: "ask_user",
				title: "Metis has questions",
				message: "Answer each question to continue.",
				expiresAt: "2026-08-10T00:15:00.000Z",
				questions: [
					{
						id: "question:0",
						question: "Where should task data be stored?",
						multiple: false,
						choices: [
							{ id: "choice:0", label: "Local database", description: "Works offline" },
							{ id: "choice:1", label: "Cloud sync", description: "Works across devices" },
						],
					},
					{
						id: "question:1",
						question: "Which clients should be supported?",
						multiple: true,
						choices: [
							{ id: "choice:0", label: "Desktop" },
							{ id: "choice:1", label: "Web" },
							{ id: "choice:2", label: "Mobile" },
						],
					},
				],
			}),
		]);
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("reports when a session starts and stops waiting for user input", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000353";
		const changes: Array<[string, boolean]> = [];
		const broker = new InteractionBroker({
			serverEpoch: EPOCH,
			createId: () => interactionId,
			onPendingChange: (sessionId: string, pending: boolean) => changes.push([sessionId, pending]),
		} as never);
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = {
			interactionId,
			kind: "ask_user",
			cancelled: true,
			answers: [],
		};

		await broker.requestUserInput(SESSION_ID, askUserRequest());

		expect(changes).toEqual([
			[SESSION_ID, true],
			[SESSION_ID, false],
		]);
	});

	it("resumes the waiting tool call with the user answers returned by the owner", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000352";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = {
			interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [
				{ questionId: "question:0", choiceIds: ["choice:1"] },
				{ questionId: "question:1", choiceIds: [], customAnswer: "Desktop and CLI" },
			],
		};
		const tool = createAskUserToolDefinition((request) => broker.requestUserInput(SESSION_ID, request));

		const result = await tool.execute("ask-tool-1", askUserInput(), undefined, undefined, {} as never);

		expect(result.details).toMatchObject({
			cancelled: false,
			answers: [{ selected: ["Cloud sync"] }, { selected: [], customAnswer: "Desktop and CLI" }],
		});
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("Desktop and CLI");
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("returns structured ask_user cancellation for user cancel, missing owner, and abort", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000351";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "ask_user", cancelled: true, answers: [] };
		await expect(broker.requestUserInput(SESSION_ID, askUserRequest())).resolves.toEqual({
			cancelled: true,
			answers: [],
		});

		broker.releasePeer(peer);
		await expect(broker.requestUserInput(SESSION_ID, askUserRequest())).resolves.toEqual({
			cancelled: true,
			answers: [],
		});

		broker.assign(SESSION_ID, peer);
		peer.waitForever = true;
		const controller = new AbortController();
		const pending = broker.requestUserInput(SESSION_ID, askUserRequest({ signal: controller.signal }));
		controller.abort();
		await expect(pending).resolves.toEqual({ cancelled: true, answers: [] });
		expect(broker.hasPending(SESSION_ID)).toBe(false);
	});

	it("completes 1,000 bounded ask_user round trips without polling or pending-request leaks", async () => {
		let sequence = 400;
		const broker = new InteractionBroker({
			serverEpoch: EPOCH,
			createId: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
		});
		const peer = new FakePeer();
		peer.responseFor = (interaction) => ({
			interactionId: interaction.interactionId,
			kind: "ask_user",
			cancelled: false,
			answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
		});
		broker.assign(SESSION_ID, peer);
		const request = askUserRequest({ questions: [askUserRequest().questions[0]!] });
		const startedAt = performance.now();
		for (let index = 0; index < 1_000; index += 1) {
			const result = await broker.requestUserInput(SESSION_ID, request);
			expect(result.answers[0]?.selectedOptionIndexes).toEqual([1]);
		}
		const elapsedMs = performance.now() - startedAt;

		expect(peer.requests).toHaveLength(1_000);
		expect(broker.hasPending(SESSION_ID)).toBe(false);
		expect(elapsedMs).toBeLessThan(2_000);
	});

	it("routes complete child permission details to the owning peer", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000320";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "permission_approval", choice: "allow-once" };

		await expect(broker.requestPermissionApproval(SESSION_ID, childApproval())).resolves.toEqual({
			decision: "allow",
		});
		expect(peer.requests[0]).toMatchObject({
			kind: "permission_approval",
			toolLabel: "bash",
			executionTarget: "host",
			scopeComplete: true,
			details: [
				{ label: "Agent", value: "researcher (agent-child-1)" },
				{ label: "Task", value: "task-1" },
				{ label: "Command", value: "curl https://example.test" },
				{ label: "Working directory", value: "/tmp/work" },
				{ label: "Path", value: "/tmp/work/result.txt" },
			],
			title: "Approve bash?",
			choices: ["allow-once", "deny-once"],
		});
		const serialized = JSON.stringify(peer.requests[0]);
		expect(serialized).not.toContain('"command": "curl https://example.test"');
		expect(serialized).not.toMatch(/"presentation":"permission_approval"/);
	});

	it("returns a project-scoped decision only for an eligible primary action", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000322";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "permission_approval", choice: "always-allow-exact" };

		await expect(
			broker.requestPermissionApproval(
				SESSION_ID,
				childApproval({
					actor: undefined,
					executionTarget: "sandbox",
					rememberProjectEligible: true,
				}),
			),
		).resolves.toEqual({ decision: "allow", remember: "project" });
		expect(permissionInteraction(peer)).toMatchObject({
			executionTarget: "sandbox",
			choices: ["allow-once", "always-allow-exact", "deny-once", "always-deny-exact"],
		});
		expect(JSON.stringify(peer.requests[0])).not.toContain("does not sandbox");
	});

	it("returns a project-scoped deny for Always deny", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000323";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "permission_approval", choice: "always-deny-exact" };

		await expect(
			broker.requestPermissionApproval(
				SESSION_ID,
				childApproval({
					actor: undefined,
					executionTarget: "sandbox",
					rememberProjectEligible: true,
				}),
			),
		).resolves.toEqual({ decision: "deny", remember: "project", reason: "Denied by the session owner" });
	});

	it("summarizes an edit without exposing replacement text", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000321";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "permission_approval", choice: "allow-once" };

		await broker.requestPermissionApproval(
			SESSION_ID,
			childApproval({
				action: {
					actionId: "action-2",
					toolName: "edit",
					provenance: "builtin",
					risks: ["workspace-write"],
					paths: ["/tmp/work/src/app.ts"],
					networkTargets: [],
				},
				args: {
					path: "src/app.ts",
					edits: [
						{ oldText: "before", newText: "after" },
						{ oldText: "old", newText: "new" },
					],
				},
			}),
		);

		expect(peer.requests[0]).toMatchObject({
			kind: "permission_approval",
			toolLabel: "edit",
			details: [
				{ label: "Agent", value: "researcher (agent-child-1)" },
				{ label: "Task", value: "task-1" },
				{ label: "File", value: "/tmp/work/src/app.ts" },
				{ label: "Changes", value: "2" },
			],
			scopeComplete: true,
			executionTarget: "host",
		});
		const serialized = JSON.stringify(permissionInteraction(peer));
		expect(serialized).not.toContain("before");
		expect(serialized).not.toContain("after");
	});

	it("summarizes known network, search, path, and external tool targets", async () => {
		const cases: Array<{
			request: PermissionApprovalRequest;
			details: Extract<InteractionView, { kind: "permission_approval" }>["details"];
		}> = [
			{
				request: childApproval({
					actor: undefined,
					action: {
						actionId: "web-fetch-1",
						toolName: "web_fetch",
						provenance: "builtin",
						risks: ["network"],
						paths: [],
						networkTargets: [{ host: "example.test", port: 443 }],
					},
					args: { url: "https://example.test/docs" },
				}),
				details: [{ label: "Address", value: "https://example.test/docs" }],
			},
			{
				request: childApproval({
					actor: undefined,
					action: {
						actionId: "web-search-1",
						toolName: "web_search",
						provenance: "builtin",
						risks: ["network"],
						paths: [],
						networkTargets: [{ host: "search.example", port: 443 }],
					},
					args: { query: "Metis permissions" },
				}),
				details: [
					{ label: "Query", value: "Metis permissions" },
					{ label: "Network", value: "search.example:443" },
				],
			},
			{
				request: childApproval({
					actor: undefined,
					action: {
						actionId: "grep-1",
						toolName: "grep",
						provenance: "builtin",
						risks: ["outside-read"],
						paths: ["/tmp/outside"],
						networkTargets: [],
					},
					args: { pattern: "TOKEN", path: "/tmp/outside" },
				}),
				details: [
					{ label: "Path", value: "/tmp/outside" },
					{ label: "Pattern", value: "TOKEN" },
				],
			},
			{
				request: childApproval({
					actor: undefined,
					action: {
						actionId: "mcp-1",
						toolName: "mcp__service__publish",
						provenance: "mcp",
						risks: ["custom", "external-side-effect"],
						paths: [],
						networkTargets: [],
					},
					args: { content: "private payload" },
				}),
				details: [{ label: "Details", value: "Network destination needs approval" }],
			},
		];

		for (const [index, sample] of cases.entries()) {
			const interactionId = `00000000-0000-4000-8000-${String(330 + index).padStart(12, "0")}`;
			const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
			const peer = new FakePeer();
			broker.assign(SESSION_ID, peer);
			peer.response = { interactionId, kind: "permission_approval", choice: "deny-once" };
			await broker.requestPermissionApproval(SESSION_ID, sample.request);
			const interaction = permissionInteraction(peer);
			expect(interaction.details).toEqual(sample.details);
			expect(JSON.stringify(interaction)).not.toContain("private payload");
		}
	});

	it("reports hidden permission targets instead of silently truncating them", async () => {
		const interactionId = "00000000-0000-4000-8000-000000000339";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => interactionId });
		const peer = new FakePeer();
		broker.assign(SESSION_ID, peer);
		peer.response = { interactionId, kind: "permission_approval", choice: "allow-once" };
		const paths = Array.from({ length: MAX_PERMISSION_OPERATION_ROWS + 3 }, (_, index) => `/tmp/target-${index}`);

		await expect(
			broker.requestPermissionApproval(
				SESSION_ID,
				childApproval({
					actor: undefined,
					rememberProjectEligible: true,
					action: {
						actionId: "many-paths",
						toolName: "read",
						provenance: "builtin",
						risks: ["outside-read"],
						paths,
						networkTargets: [],
					},
				}),
			),
		).resolves.toEqual({ decision: "allow" });

		const interaction = permissionInteraction(peer);
		expect(interaction.details).toHaveLength(MAX_PERMISSION_OPERATION_ROWS);
		expect(interaction.scopeComplete).toBe(true);
		expect(interaction.choices).toContain("always-allow-exact");
		const serialized = JSON.stringify(interaction);
		expect(serialized).not.toContain(`/tmp/target-${MAX_PERMISSION_OPERATION_ROWS + 2}`);
		expect(serialized).toContain("/tmp/target-0");
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
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
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

	it("notifies desktop when an in-flight browser request is aborted", async () => {
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
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});
		const request = {
			jsonrpc: "2.0",
			id: "server-browser-abort",
			method: "browser/tool",
			params: {
				serverEpoch: EPOCH,
				sessionId: SESSION_ID,
				toolCallId: "browser-call-abort",
				call: { tool: "browser_tabs", input: { action: "list" } },
			},
		} as const;
		const controller = new AbortController();
		const pending = connection.request(request, controller.signal);
		await vi.waitFor(() => expect(outbound).toContainEqual(request));
		controller.abort(new Error("turn interrupted"));
		await expect(pending).rejects.toThrow("OPERATION_FAILED");
		await vi.waitFor(() =>
			expect(outbound).toContainEqual({
				jsonrpc: "2.0",
				method: "browser/tool/cancelled",
				params: {
					serverEpoch: EPOCH,
					sessionId: SESSION_ID,
					toolCallId: "browser-call-abort",
					requestId: "server-browser-abort",
				},
			}),
		);
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
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
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

	it("rejects an in-flight browser request when its owner connection closes", async () => {
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
			id: "initialize-browser-disconnect",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});
		const requestId = "00000000-0000-4000-8000-000000000311";
		const broker = new InteractionBroker({ serverEpoch: EPOCH, createId: () => requestId });
		broker.assign(SESSION_ID, connection);

		const pending = broker.requestBrowserTool(
			SESSION_ID,
			"browser-call-disconnect",
			browserTabsCall(),
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(outbound).toContainEqual(expect.objectContaining({ id: requestId, method: "browser/tool" })),
		);

		connection.close();
		await expect(pending).rejects.toThrow("OPERATION_FAILED");
		expect(
			connection.handleServerResponse({
				jsonrpc: "2.0",
				id: requestId,
				result: browserTabsResponse("browser-call-disconnect"),
			}),
		).toBe(true);
	});
});
