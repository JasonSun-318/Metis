import { ProtocolValidationError, validateClientRequest, validateResponseFor } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";

const SESSION_ID = "00000000-0000-4000-8000-000000000100";
const AGENT_ID = "00000000-0000-4000-8000-000000000101";
const REQUEST_ID = "00000000-0000-4000-8000-000000000102";
const TASK_ID = "00000000-0000-4000-8000-000000000103";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000104";
const OTHER_REQUEST_ID = "00000000-0000-4000-8000-000000000105";

type ProtocolErrorKind = ProtocolValidationError["kind"];

function request(method: "agent/send" | "agent/control", params: Record<string, unknown>, id = "request-1") {
	return { jsonrpc: "2.0" as const, id, method, params };
}

function success(id: string, result: Record<string, unknown>) {
	return { jsonrpc: "2.0" as const, id, result };
}

function expectProtocolError(run: () => unknown, kind: ProtocolErrorKind): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ProtocolValidationError);
	expect((caught as ProtocolValidationError).kind).toBe(kind);
}

const sendParams = {
	sessionId: SESSION_ID,
	agentId: AGENT_ID,
	requestId: REQUEST_ID,
	delivery: "auto",
	input: {
		text: "Please continue",
		images: [{ hash: "a".repeat(64), mediaType: "image/png", byteLength: 12 }],
		attachments: [{ path: "docs/report.pdf", name: "report.pdf" }],
		fileSelections: [
			{
				source: "workspace",
				relativePath: "src/index.ts",
				selectedText: "const value = 1;",
				basis: "source",
			},
		],
		conversationQuotes: [
			{
				sourceItemId: "item-1",
				sourceRole: "assistant",
				selectedText: "Earlier answer",
			},
		],
	},
} as const;

const sendResult = {
	agentId: AGENT_ID,
	taskId: TASK_ID,
	messageId: "message-1",
	requestId: REQUEST_ID,
	delivery: "start",
	state: "accepted",
	instructionRevision: 0,
} as const;

const controlParams = {
	sessionId: SESSION_ID,
	agentId: AGENT_ID,
	requestId: REQUEST_ID,
	action: "stop",
	scope: "self",
} as const;

const controlResult = {
	agentId: AGENT_ID,
	requestId: REQUEST_ID,
	state: "user_paused",
	scope: "self",
} as const;

const stopSubtreeParams = { ...controlParams, scope: "subtree" } as const;
const stopDefaultParams = {
	sessionId: SESSION_ID,
	agentId: AGENT_ID,
	requestId: REQUEST_ID,
	action: "stop",
} as const;
const resumeSelfParams = { ...controlParams, action: "resume", scope: "self" } as const;
const resumeDefaultParams = {
	sessionId: SESSION_ID,
	agentId: AGENT_ID,
	requestId: REQUEST_ID,
	action: "resume",
} as const;

describe("agent conversation protocol", () => {
	it("accepts only the documented agent/send input fields", () => {
		const sendRequest = request("agent/send", sendParams);
		expect(validateClientRequest(sendRequest)).toEqual(sendRequest);

		expectProtocolError(
			() => validateClientRequest(request("agent/send", { ...sendParams, origin: { kind: "user" } })),
			"invalid_params",
		);
		expectProtocolError(
			() =>
				validateClientRequest(
					request("agent/send", {
						...sendParams,
						input: { ...sendParams.input, origin: { kind: "user" } },
					}),
				),
			"invalid_params",
		);
		expectProtocolError(
			() =>
				validateClientRequest(
					request("agent/send", {
						...sendParams,
						input: { ...sendParams.input, role: "user" },
					}),
				),
			"invalid_params",
		);
		expectProtocolError(
			() =>
				validateClientRequest(
					request("agent/send", {
						...sendParams,
						input: {
							...sendParams.input,
							images: [{ ...sendParams.input.images[0], path: "/tmp/forged.png" }],
						},
					}),
				),
			"invalid_params",
		);
		expectProtocolError(
			() => validateClientRequest(request("agent/send", { ...sendParams, delivery: "follow_up" })),
			"invalid_params",
		);
		expectProtocolError(
			() => validateClientRequest(request("agent/send", { ...sendParams, requestId: "not-a-uuid" })),
			"invalid_params",
		);
	});

	it("validates send receipts without accepting request-only or unknown fields", () => {
		const sendRequest = request("agent/send", sendParams);
		expect(() => validateResponseFor("client", sendRequest, success("request-1", sendResult))).not.toThrow();
		for (const delivery of ["steer", "start", "queue"] as const) {
			for (const state of ["accepted", "queued", "delivered", "cancelled", "failed"] as const) {
				expect(() =>
					validateResponseFor(
						"client",
						sendRequest,
						success("request-1", { ...sendResult, delivery, state, instructionRevision: 1 }),
					),
				).not.toThrow();
			}
		}

		expectProtocolError(
			() => validateResponseFor("client", sendRequest, success("request-1", { ...sendResult, delivery: "auto" })),
			"invalid_response",
		);
		expectProtocolError(
			() => validateResponseFor("client", sendRequest, success("request-1", { ...sendResult, state: "started" })),
			"invalid_response",
		);
		expectProtocolError(
			() =>
				validateResponseFor(
					"client",
					sendRequest,
					success("request-1", { ...sendResult, instructionRevision: -1 }),
				),
			"invalid_response",
		);
		expectProtocolError(
			() =>
				validateResponseFor(
					"client",
					sendRequest,
					success("request-1", { ...sendResult, origin: { kind: "user" } }),
				),
			"invalid_response",
		);
		const { taskId: _taskId, ...receiptWithoutTaskId } = sendResult;
		expectProtocolError(
			() => validateResponseFor("client", sendRequest, success("request-1", receiptWithoutTaskId)),
			"invalid_response",
		);
	});

	it("bounds agent/control actions and scopes on requests and receipts", () => {
		const controlRequest = request("agent/control", controlParams);
		const stopSubtreeRequest = request("agent/control", stopSubtreeParams);
		const stopDefaultRequest = request("agent/control", stopDefaultParams);
		const resumeSelfRequest = request("agent/control", resumeSelfParams);
		const resumeDefaultRequest = request("agent/control", resumeDefaultParams);
		expect(validateClientRequest(controlRequest)).toEqual(controlRequest);
		for (const pending of [stopSubtreeRequest, stopDefaultRequest, resumeSelfRequest, resumeDefaultRequest]) {
			expect(() => validateClientRequest(pending)).not.toThrow();
		}
		expectProtocolError(
			() => validateClientRequest(request("agent/control", { ...resumeDefaultParams, scope: "subtree" })),
			"invalid_params",
		);

		expectProtocolError(
			() => validateClientRequest(request("agent/control", { ...controlParams, origin: { kind: "user" } })),
			"invalid_params",
		);
		expectProtocolError(
			() => validateClientRequest(request("agent/control", { ...controlParams, action: "pause" })),
			"invalid_params",
		);
		expectProtocolError(
			() => validateClientRequest(request("agent/control", { ...controlParams, scope: "all" })),
			"invalid_params",
		);
		expectProtocolError(
			() => validateClientRequest(request("agent/control", { ...controlParams, unexpected: true })),
			"invalid_params",
		);

		expect(() => validateResponseFor("client", controlRequest, success("request-1", controlResult))).not.toThrow();
		expect(() =>
			validateResponseFor(
				"client",
				controlRequest,
				success("request-1", { ...controlResult, state: "interrupted" }),
			),
		).not.toThrow();
		expect(() =>
			validateResponseFor(
				"client",
				stopSubtreeRequest,
				success("request-1", { ...controlResult, scope: "subtree" }),
			),
		).not.toThrow();
		expect(() =>
			validateResponseFor(
				"client",
				stopDefaultRequest,
				success("request-1", { ...controlResult, scope: "subtree" }),
			),
		).not.toThrow();
		expect(() =>
			validateResponseFor(
				"client",
				resumeSelfRequest,
				success("request-1", { ...controlResult, state: "enabled", scope: "self" }),
			),
		).not.toThrow();
		expect(() =>
			validateResponseFor(
				"client",
				resumeDefaultRequest,
				success("request-1", { ...controlResult, state: "enabled", scope: "self" }),
			),
		).not.toThrow();
		expectProtocolError(
			() =>
				validateResponseFor("client", controlRequest, success("request-1", { ...controlResult, state: "stopped" })),
			"invalid_response",
		);
		expectProtocolError(
			() => validateResponseFor("client", controlRequest, success("request-1", { ...controlResult, scope: "all" })),
			"invalid_response",
		);
		expectProtocolError(
			() =>
				validateResponseFor(
					"client",
					controlRequest,
					success("request-1", { ...controlResult, origin: { kind: "user" } }),
				),
			"invalid_response",
		);
	});

	it.each([
		["agent/send agentId", request("agent/send", sendParams), { ...sendResult, agentId: OTHER_AGENT_ID }],
		["agent/send requestId", request("agent/send", sendParams), { ...sendResult, requestId: OTHER_REQUEST_ID }],
		["agent/control agentId", request("agent/control", controlParams), { ...controlResult, agentId: OTHER_AGENT_ID }],
		[
			"agent/control requestId",
			request("agent/control", controlParams),
			{ ...controlResult, requestId: OTHER_REQUEST_ID },
		],
		["agent/control explicit scope", request("agent/control", controlParams), { ...controlResult, scope: "subtree" }],
		[
			"agent/control stop default scope",
			request("agent/control", stopDefaultParams),
			{ ...controlResult, scope: "self" },
		],
		[
			"agent/control resume default scope",
			request("agent/control", resumeDefaultParams),
			{ ...controlResult, state: "enabled", scope: "subtree" },
		],
		[
			"agent/control resume explicit scope",
			request("agent/control", resumeSelfParams),
			{ ...controlResult, state: "enabled", scope: "subtree" },
		],
	] as const)("%s receipt must echo the request identity", (_label, pending, result) => {
		expectProtocolError(
			() => validateResponseFor("client", pending, success("request-1", result)),
			"invalid_response",
		);
	});
});
