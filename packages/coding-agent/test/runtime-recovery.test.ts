import { describe, expect, it } from "vitest";
import {
	type DurablePromptInput,
	deriveBatchedTurnId,
	identifyRuntimeRequest,
	identifySubmitPromptRequest,
	isRuntimeControlEntryType,
	MAX_DURABLE_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGE_BYTES,
	MAX_DURABLE_PROMPT_IMAGES,
	parseDurablePromptSubmission,
	parseRuntimeControlEntry,
	RequestIdReusedError,
	type RuntimeOperationEntry,
	type RuntimeQueueEntry,
	type RuntimeRequestIdentity,
	type RuntimeToolEntry,
	type RuntimeTurnEntry,
	reduceRuntimeJournal,
} from "../src/core/runtime-recovery.ts";

const method = "session/submitPrompt";
const timestamp = "2026-01-01T00:00:00.000Z";
const input: DurablePromptInput = { text: "hello" };
let entrySequence = 0;

function entryBase() {
	entrySequence += 1;
	return { id: `entry-${entrySequence}`, parentId: null, timestamp };
}

function identity(requestId = "request-1", params: DurablePromptInput = input): RuntimeRequestIdentity {
	return identifyRuntimeRequest(method, requestId, params);
}

function operation(
	request: RuntimeRequestIdentity,
	state: RuntimeOperationEntry["state"],
	overrides: Partial<RuntimeOperationEntry> = {},
): RuntimeOperationEntry {
	return {
		...entryBase(),
		type: "runtime_operation",
		operationId: request.operationId,
		requestId: request.requestId,
		requestHash: request.requestHash,
		kind: "turn",
		state,
		input,
		...overrides,
	};
}

function queue(
	request: RuntimeRequestIdentity,
	state: RuntimeQueueEntry["state"],
	overrides: Partial<RuntimeQueueEntry> = {},
): RuntimeQueueEntry {
	const result: RuntimeQueueEntry = {
		...entryBase(),
		type: "runtime_queue",
		operationId: request.operationId,
		queueItemId: request.queueItemId,
		queue: "follow_up",
		state,
		input,
		...overrides,
	};
	if (overrides.input === undefined && "input" in overrides) {
		const { input: _input, ...withoutInput } = result;
		return withoutInput;
	}
	return result;
}

function runtimeTurn(
	turnId: string,
	operationIds: readonly string[],
	state: RuntimeTurnEntry["state"],
	consumedQueueItemIds: readonly string[] = [],
): RuntimeTurnEntry {
	return {
		...entryBase(),
		type: "runtime_turn",
		turnId,
		operationIds,
		state,
		consumedQueueItemIds,
	};
}

function tool(
	request: RuntimeRequestIdentity,
	state: RuntimeToolEntry["state"],
	overrides: Partial<RuntimeToolEntry> = {},
): RuntimeToolEntry {
	return {
		...entryBase(),
		type: "runtime_tool",
		turnId: request.turnId,
		toolCallId: "tool-call-1",
		toolName: "write_file",
		state,
		...overrides,
	};
}

function assistantMessage(
	turnId: string,
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
	content: unknown[] = [],
) {
	return {
		...entryBase(),
		type: "message",
		turnId,
		message: {
			role: "assistant",
			content,
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason,
			timestamp: 1,
		},
	};
}

function assistantToolCall(
	turnId: string,
	toolCallId = "tool-call-1",
	toolName = "write_file",
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "toolUse",
) {
	return assistantMessage(turnId, stopReason, [
		{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path: "file.txt" } },
	]);
}

function toolResult(turnId: string, toolCallId = "tool-call-1", toolName = "write_file") {
	return {
		...entryBase(),
		type: "message",
		turnId,
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
		},
	};
}

function materializeRecovery(records: readonly unknown[]): unknown[] {
	const recovered = reduceRuntimeJournal(records);
	const materialized = [...records];
	const appendSyntheticResult = (turnId: string, toolCallId: string, toolName: string) => {
		materialized.push({
			...entryBase(),
			type: "message",
			turnId,
			message: {
				role: "toolResult",
				toolCallId,
				toolName,
				content: [{ type: "text", text: "Tool execution was interrupted because the server restarted" }],
				isError: true,
				timestamp: 1,
			},
		});
	};

	for (const decision of recovered.decisions) {
		switch (decision.type) {
			case "complete_tool":
			case "interrupt_tool":
				materialized.push({
					...entryBase(),
					type: "runtime_tool",
					turnId: decision.turnId,
					toolCallId: decision.toolCallId,
					toolName: decision.toolName,
					state: decision.type === "complete_tool" ? "completed" : "interrupted",
				});
				if (decision.type === "interrupt_tool") {
					appendSyntheticResult(decision.turnId, decision.toolCallId, decision.toolName);
				}
				break;
			case "synthesize_tool_result":
				appendSyntheticResult(decision.turnId, decision.toolCallId, decision.toolName);
				break;
			case "complete_turn":
			case "interrupt_turn": {
				const turn = recovered.turns.find((candidate) => candidate.turnId === decision.turnId);
				if (!turn) throw new Error(`Missing recovered turn ${decision.turnId}`);
				materialized.push({
					...entryBase(),
					type: "runtime_turn",
					turnId: turn.turnId,
					operationIds: turn.operationIds,
					state: decision.type === "complete_turn" ? "completed" : "interrupted",
					consumedQueueItemIds: turn.consumedQueueItemIds,
				});
				break;
			}
			case "complete_operation":
			case "interrupt_operation": {
				const current = recovered.operations.find((candidate) => candidate.operationId === decision.operationId);
				if (!current) throw new Error(`Missing recovered operation ${decision.operationId}`);
				materialized.push({
					...entryBase(),
					type: "runtime_operation",
					operationId: current.operationId,
					requestId: current.requestId,
					requestHash: current.requestHash,
					kind: current.kind,
					state: decision.type === "complete_operation" ? "completed" : "interrupted",
					...(decision.turnId === undefined ? {} : { turnId: decision.turnId }),
					...(current.input === undefined ? {} : { input: current.input }),
				});
				break;
			}
			case "pause_queue": {
				const current = recovered.queues.find((candidate) => candidate.queueItemId === decision.queueItemId);
				if (!current?.requestId || !current.enqueueHash) {
					throw new Error(`Missing recovered queued turn ${decision.queueItemId}`);
				}
				materialized.push({
					...entryBase(),
					type: "runtime_queue",
					operationId: current.operationId,
					queueItemId: current.queueItemId,
					queue: "next_turn",
					state: "paused",
					requestId: current.requestId,
					enqueueHash: current.enqueueHash,
					...(current.deliveryRequestId === undefined ? {} : { deliveryRequestId: current.deliveryRequestId }),
					reason: decision.reason,
				});
				break;
			}
			case "cancel_queue": {
				const current = recovered.queues.find((candidate) => candidate.queueItemId === decision.queueItemId);
				if (!current) throw new Error(`Missing recovered queue item ${decision.queueItemId}`);
				materialized.push({
					...entryBase(),
					type: "runtime_queue",
					operationId: current.operationId,
					queueItemId: current.queueItemId,
					queue: current.queue,
					state: "cancelled",
					reason: decision.reason,
				});
				break;
			}
		}
	}
	return materialized;
}

describe("durable runtime request identity", () => {
	it("accepts only blob-backed prompt images", () => {
		const hash = "a".repeat(64);
		const size = 123;
		expect(
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: [{ type: "image_ref", hash, mimeType: "image/png", size }],
				streamingBehavior: "steer",
			}),
		).toEqual({
			requestId: "request-1",
			input: {
				text: "hello",
				images: [{ type: "image_ref", hash, mimeType: "image/png", size }],
				streamingBehavior: "steer",
			},
		});

		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: [{ type: "image", data: "base64", mimeType: "image/png" }],
			}),
		).toThrow("unknown field");
		expect(() => parseDurablePromptSubmission({ requestId: "request-1", text: "hello", extra: true })).toThrow(
			"unknown field",
		);
	});

	it("round-trips an exact Plan execution reference", () => {
		const parsed = parseDurablePromptSubmission({
			requestId: "request-1",
			text: "Execute the accepted plan.",
			planExecution: { planId: "plan-a", revision: 2 },
		});
		expect(parsed.input.planExecution).toEqual({ planId: "plan-a", revision: 2 });
	});

	it("rejects planExecution combined with steer or image inputs", () => {
		const hash = "a".repeat(64);
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "Execute",
				planExecution: { planId: "plan-a", revision: 1 },
				streamingBehavior: "steer",
			}),
		).toThrow(/cannot combine planExecution/iu);
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "Execute",
				planExecution: { planId: "plan-a", revision: 1 },
				images: [{ type: "image_ref", hash, mimeType: "image/png", size: 123 }],
			}),
		).toThrow(/cannot combine planExecution/iu);
	});

	it("changes request hash when plan revision changes under the same request ID text", () => {
		const first = identifySubmitPromptRequest("request-1", {
			text: "Execute",
			planExecution: { planId: "plan-a", revision: 1 },
		});
		const revised = identifySubmitPromptRequest("request-1", {
			text: "Execute",
			planExecution: { planId: "plan-a", revision: 2 },
		});
		expect(revised.requestHash).not.toBe(first.requestHash);
	});

	it("canonicalizes JSON and derives stable namespaced IDs from only the request ID", () => {
		const first = identifyRuntimeRequest(method, "request-1", { z: [3, 2, 1], a: { y: true, x: null } });
		const reordered = identifyRuntimeRequest(method, "request-1", { a: { x: null, y: true }, z: [3, 2, 1] });
		const changed = identifyRuntimeRequest(method, "request-1", { a: { x: null, y: false }, z: [3, 2, 1] });

		expect(reordered).toEqual(first);
		expect(changed.requestHash).not.toBe(first.requestHash);
		expect(changed).toMatchObject({
			operationId: first.operationId,
			turnId: first.turnId,
			queueItemId: first.queueItemId,
		});
		expect(first).toMatchObject({
			operationId: "operation_4e169288728c82282894a28de7326343e1680f4ea24182f36ef04020c37ad94d",
			turnId: "turn_e60a9e87d1dc834949ffd65c1f164adf1ed8fde4b5e4e00656b65eb9c91c1a9d",
			queueItemId: "queue_62129e483890fcc3edb847454482795a08cb080351cca18b5c5ee6486534b4b7",
		});
	});

	it("identifies validated prompt submissions with the stable internal method", () => {
		expect(identifySubmitPromptRequest("request-1", input)).toEqual(
			identifyRuntimeRequest(method, "request-1", input),
		);
	});

	it("derives a batched turn ID from the ordered consumed queue IDs", () => {
		const first = identity("first").queueItemId;
		const second = identity("second").queueItemId;
		expect(deriveBatchedTurnId([first, second])).toBe(
			"turn_e22f821added0c145e02b3dbcad165464b99b9d351fb3e2539fe49c2ad36f075",
		);
		expect(deriveBatchedTurnId([second, first])).not.toBe(deriveBatchedTurnId([first, second]));
	});

	it("rejects non-durable JSON without evaluating accessors", () => {
		let reads = 0;
		const params = { text: "hello" } as Record<string, unknown>;
		Object.defineProperty(params, "computed", {
			enumerable: true,
			get() {
				reads += 1;
				return "unsafe";
			},
		});

		expect(() => identifyRuntimeRequest(method, "request-1", params)).toThrow("data properties");
		expect(reads).toBe(0);
		expect(() => identifyRuntimeRequest(method, "request-1", { invalid: Number.NaN })).toThrow("finite");
		const arrayWithExtraNumericProperty: unknown[] = [];
		Object.defineProperty(arrayWithExtraNumericProperty, "4294967295", { enumerable: true, value: "hidden" });
		expect(() => identifyRuntimeRequest(method, "request-1", arrayWithExtraNumericProperty)).toThrow("extra fields");
	});

	it("bounds durable prompt and canonical request inputs before hashing", () => {
		expect(() => identifyRuntimeRequest("m".repeat(257), "request-1", {})).toThrow("256 code units");
		expect(() => identifyRuntimeRequest(method, "r".repeat(257), {})).toThrow("256 code units");
		expect(() => identifyRuntimeRequest(method, "request-1", { value: "x".repeat(8 * 1024 * 1024) })).toThrow(
			"8388608 UTF-8 bytes",
		);
		expect(() =>
			parseDurablePromptSubmission({ requestId: "request-1", text: "x".repeat(2 * 1024 * 1024 + 1) }),
		).toThrow("2097152 UTF-8 bytes");
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: Array.from({ length: MAX_DURABLE_PROMPT_IMAGES + 1 }, () => ({
					type: "image_ref",
					hash: "a".repeat(64),
					mimeType: "image/png",
					size: 1,
				})),
			}),
		).toThrow(`${MAX_DURABLE_PROMPT_IMAGES} image references`);
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: [{ type: "image_ref", hash: "a".repeat(64), mimeType: "m".repeat(257), size: 1 }],
			}),
		).toThrow("256 code units");
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: [{ type: "image_ref", hash: "a".repeat(64), mimeType: "image/png" }],
			}),
		).toThrow("size is required");
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: [
					{
						type: "image_ref",
						hash: "a".repeat(64),
						mimeType: "image/png",
						size: MAX_DURABLE_IMAGE_BYTES + 1,
					},
				],
			}),
		).toThrow(`${MAX_DURABLE_IMAGE_BYTES} bytes`);
		const totalLimitImages = Math.floor(MAX_DURABLE_PROMPT_IMAGE_BYTES / MAX_DURABLE_IMAGE_BYTES) + 1;
		expect(() =>
			parseDurablePromptSubmission({
				requestId: "request-1",
				text: "hello",
				images: Array.from({ length: totalLimitImages }, (_, index) => ({
					type: "image_ref",
					hash: index.toString(16).padStart(64, "0"),
					mimeType: "image/png",
					size: MAX_DURABLE_IMAGE_BYTES,
				})),
			}),
		).toThrow(`${MAX_DURABLE_PROMPT_IMAGE_BYTES} total bytes`);

		let deeplyNested: unknown = null;
		for (let depth = 0; depth < 101; depth += 1) deeplyNested = { child: deeplyNested };
		expect(() => identifyRuntimeRequest(method, "request-1", deeplyNested)).toThrow("nested too deeply");
	});
});

describe("runtime journal recovery reducer", () => {
	it("reduces editable next-turn queues and pauses them on restart", () => {
		const requestId = "00000000-0000-4000-8000-000000000001";
		const initialInput = { text: "first" };
		const queued = identifyRuntimeRequest("turn/queue", requestId, initialInput);
		const first: RuntimeQueueEntry = {
			...entryBase(),
			id: "q1-v1",
			type: "runtime_queue",
			operationId: queued.operationId,
			queueItemId: queued.queueItemId,
			queue: "next_turn",
			state: "enqueued",
			input: initialInput,
			requestId,
			enqueueHash: queued.requestHash,
		};
		const edited: RuntimeQueueEntry = {
			...first,
			id: "q1-v2",
			input: { text: "edited" },
		};

		const reduced = reduceRuntimeJournal([first, edited]);
		expect(reduced.queues).toEqual([
			expect.objectContaining({
				queue: "next_turn",
				state: "enqueued",
				input: { text: "edited" },
				revision: "q1-v2",
				requestId,
			}),
		]);
		expect(reduced.decisions).toContainEqual({
			type: "pause_queue",
			queueItemId: queued.queueItemId,
			reason: "server_restarted",
		});

		const { input: _editedInput, ...editedWithoutInput } = edited;
		const paused: RuntimeQueueEntry = { ...editedWithoutInput, id: "q1-v3", state: "paused" };
		expect(reduceRuntimeJournal([first, edited, paused]).queues[0]?.state).toBe("paused");
		const cancelled: RuntimeQueueEntry = { ...paused, id: "q1-v4", state: "cancelled" };
		expect(() => reduceRuntimeJournal([first, cancelled, edited])).toThrow(/terminal/u);
	});

	it("exposes one strict parser seam for SessionManager v5 raw records", () => {
		const request = identity("runtime-parser-seam");
		const accepted = operation(request, "accepted");
		expect(isRuntimeControlEntryType(accepted.type)).toBe(true);
		expect(isRuntimeControlEntryType("runtime_unknown")).toBe(false);
		expect(parseRuntimeControlEntry(accepted)).toEqual(accepted);
		expect(() => parseRuntimeControlEntry({ ...accepted, extra: true })).toThrow("unknown field");
		expect(() => parseRuntimeControlEntry({ ...entryBase(), type: "runtime_unknown" })).toThrow(
			"Unknown runtime control entry type",
		);
	});

	it("leaves accepted app-server mutations for deterministic server reconciliation", () => {
		const request = identifyRuntimeRequest("session/archive", "archive-request", { sessionId: "session-a" });
		const { input: _input, ...accepted } = operation(request, "accepted", { kind: "session_archive" });
		const reduced = reduceRuntimeJournal([accepted]);

		expect(reduced.operations).toMatchObject([
			{ requestId: "archive-request", kind: "session_archive", state: "active" },
		]);
		expect(reduced.decisions).toEqual([]);
	});

	it("reduces explicit completed, active, and interrupted operation prefixes", () => {
		const request = identity();
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		const active = reduceRuntimeJournal([accepted, started]);
		expect(active.operations).toMatchObject([{ operationId: request.operationId, state: "active" }]);
		expect(active.turns).toMatchObject([{ turnId: request.turnId, state: "active" }]);
		expect(active.decisions).toContainEqual({
			type: "interrupt_turn",
			turnId: request.turnId,
			reason: "server_restarted",
		});
		expect(active.decisions).toContainEqual({
			type: "interrupt_operation",
			operationId: request.operationId,
			turnId: request.turnId,
			reason: "server_restarted",
		});

		const completed = reduceRuntimeJournal([
			accepted,
			started,
			assistantMessage(request.turnId),
			runtimeTurn(request.turnId, [request.operationId], "completed"),
			operation(request, "completed", { turnId: request.turnId }),
		]);
		expect(completed.operations).toMatchObject([{ operationId: request.operationId, state: "completed" }]);
		expect(completed.turns).toMatchObject([{ turnId: request.turnId, state: "completed" }]);
		expect(completed.decisions).toEqual([]);

		const interrupted = reduceRuntimeJournal([
			accepted,
			started,
			runtimeTurn(request.turnId, [request.operationId], "interrupted"),
			operation(request, "interrupted", { turnId: request.turnId }),
		]);
		expect(interrupted.operations).toMatchObject([{ operationId: request.operationId, state: "interrupted" }]);
		expect(interrupted.turns).toMatchObject([{ turnId: request.turnId, state: "interrupted" }]);
		expect(interrupted.decisions).toEqual([]);
	});

	it("deduplicates the same request hash and rejects request ID reuse with different params", () => {
		const original = identity();
		const duplicate = reduceRuntimeJournal([
			operation(original, "accepted"),
			operation(original, "accepted", { input: { text: "hello" } }),
		]);
		expect(duplicate.operations).toHaveLength(1);

		const changedInput = { text: "different" };
		const reused = identity("request-1", changedInput);
		expect(() =>
			reduceRuntimeJournal([
				operation(original, "accepted"),
				operation(reused, "accepted", { input: changedInput }),
			]),
		).toThrow(RequestIdReusedError);
	});

	it("requires durable input on accepted prompt operations", () => {
		const request = identity("missing-input");
		const { input: _input, ...acceptedWithoutInput } = operation(request, "accepted");

		expect(() => reduceRuntimeJournal([acceptedWithoutInput])).toThrow(
			"input is required when accepting a prompt operation",
		);
	});

	it("rejects an accepted prompt whose persisted hash does not match its durable input", () => {
		const request = identity("forged-hash");
		expect(() => reduceRuntimeJournal([operation(request, "accepted", { requestHash: "0".repeat(64) })])).toThrow(
			"requestHash does not match its durable input",
		);
	});

	it("uses runtime_turn:started as the only queue-consumption commit", () => {
		const request = identity("queued-request");
		const accepted = operation(request, "accepted", { kind: "steer" });
		const enqueued = queue(request, "enqueued");
		const turnId = deriveBatchedTurnId([request.queueItemId]);
		const consumed = queue(request, "consumed", { input: undefined, turnId });
		const started = runtimeTurn(turnId, [request.operationId], "started", [request.queueItemId]);

		const orphanConsumption = reduceRuntimeJournal([accepted, enqueued, consumed]);
		expect(orphanConsumption.queues).toMatchObject([{ queueItemId: request.queueItemId, state: "enqueued" }]);
		expect(orphanConsumption.decisions).toContainEqual({
			type: "cancel_queue",
			queueItemId: request.queueItemId,
			reason: "server_restarted",
			draft: input,
		});
		const recoveredTwice = reduceRuntimeJournal([
			accepted,
			enqueued,
			consumed,
			queue(request, "consumed", { input: undefined, turnId: "non-authoritative-projection" }),
			operation(request, "interrupted", { kind: "steer" }),
			queue(request, "cancelled", { input: undefined, reason: "server_restarted" }),
		]);
		expect(recoveredTwice.queues).toMatchObject([
			{ queueItemId: request.queueItemId, state: "cancelled", reason: "server_restarted" },
		]);
		expect(recoveredTwice.decisions).toEqual([]);

		for (const records of [
			[accepted, enqueued, consumed, started],
			[
				accepted,
				enqueued,
				queue(request, "consumed", { input: undefined, turnId: "wrong-projection-turn" }),
				started,
			],
			[accepted, enqueued, started, consumed],
			[accepted, enqueued, started],
		]) {
			const recovered = reduceRuntimeJournal(records);
			expect(recovered.queues).toMatchObject([
				{ operationId: request.operationId, queueItemId: request.queueItemId, state: "consumed", turnId },
			]);
			expect(recovered.decisions.some((decision) => decision.type === "cancel_queue")).toBe(false);
		}
	});

	it("commits an all-mode queue batch in one stable turn record", () => {
		const first = identity("queued-first");
		const second = identity("queued-second");
		const queueItemIds = [first.queueItemId, second.queueItemId];
		const turnId = deriveBatchedTurnId(queueItemIds);
		const recovered = reduceRuntimeJournal([
			operation(first, "accepted", { kind: "steer" }),
			queue(first, "enqueued"),
			operation(second, "accepted", { kind: "steer" }),
			queue(second, "enqueued"),
			runtimeTurn(turnId, [first.operationId, second.operationId], "started", queueItemIds),
		]);

		expect(recovered.queues).toMatchObject([
			{ queueItemId: first.queueItemId, state: "consumed", turnId },
			{ queueItemId: second.queueItemId, state: "consumed", turnId },
		]);
		expect(recovered.operations).toMatchObject([
			{ operationId: first.operationId, state: "active", turnId },
			{ operationId: second.operationId, state: "active", turnId },
		]);
	});

	it("extends a direct active turn with ordered steering commits", () => {
		const direct = identity("direct-with-steering");
		const steering = identity("steering-after-direct");
		const prefix = [
			operation(direct, "accepted"),
			runtimeTurn(direct.turnId, [direct.operationId], "started"),
			assistantMessage(direct.turnId),
			operation(steering, "accepted", { kind: "steer" }),
			queue(steering, "enqueued"),
			runtimeTurn(direct.turnId, [direct.operationId, steering.operationId], "started", [steering.queueItemId]),
		];
		const interrupted = reduceRuntimeJournal(prefix);
		expect(interrupted.queues).toMatchObject([
			{ queueItemId: steering.queueItemId, state: "consumed", turnId: direct.turnId },
		]);
		expect(interrupted.decisions).toContainEqual({
			type: "interrupt_operation",
			operationId: steering.operationId,
			turnId: direct.turnId,
			reason: "server_restarted",
		});

		const completed = reduceRuntimeJournal([...prefix, assistantMessage(direct.turnId)]);
		expect(completed.decisions).toContainEqual({ type: "complete_turn", turnId: direct.turnId });
		expect(completed.decisions).toContainEqual({
			type: "complete_operation",
			operationId: steering.operationId,
			turnId: direct.turnId,
		});
	});

	it("extends a queued turn while preserving the first batch-derived turn ID", () => {
		const first = identity("queued-extension-first");
		const second = identity("queued-extension-second");
		const turnId = deriveBatchedTurnId([first.queueItemId]);
		const recovered = reduceRuntimeJournal([
			operation(first, "accepted", { kind: "steer" }),
			queue(first, "enqueued"),
			operation(second, "accepted", { kind: "steer" }),
			queue(second, "enqueued"),
			runtimeTurn(turnId, [first.operationId], "started", [first.queueItemId]),
			runtimeTurn(turnId, [first.operationId, second.operationId], "started", [
				first.queueItemId,
				second.queueItemId,
			]),
		]);

		expect(recovered.turns).toMatchObject([
			{
				turnId,
				operationIds: [first.operationId, second.operationId],
				consumedQueueItemIds: [first.queueItemId, second.queueItemId],
			},
		]);
		expect(recovered.queues).toMatchObject([
			{ queueItemId: first.queueItemId, state: "consumed", turnId },
			{ queueItemId: second.queueItemId, state: "consumed", turnId },
		]);
	});

	it("rejects reordered turn extensions and terminal records that omit an accumulated commit", () => {
		const direct = identity("extension-conflict-direct");
		const first = identity("extension-conflict-first");
		const second = identity("extension-conflict-second");
		const common = [
			operation(direct, "accepted"),
			operation(first, "accepted", { kind: "steer" }),
			queue(first, "enqueued"),
			operation(second, "accepted", { kind: "steer" }),
			queue(second, "enqueued"),
			runtimeTurn(direct.turnId, [direct.operationId], "started"),
			runtimeTurn(direct.turnId, [direct.operationId, first.operationId], "started", [first.queueItemId]),
		];
		expect(() =>
			reduceRuntimeJournal([
				...common,
				runtimeTurn(direct.turnId, [direct.operationId, second.operationId], "started", [second.queueItemId]),
			]),
		).toThrow("preserve ordered prefixes");
		expect(() =>
			reduceRuntimeJournal([...common, runtimeTurn(direct.turnId, [direct.operationId], "completed")]),
		).toThrow("does not match its final accumulated operations");
	});

	it("rejects a queue whose operation kind or durable input does not match", () => {
		const request = identity("mismatched-queue");
		expect(() => reduceRuntimeJournal([operation(request, "accepted"), queue(request, "enqueued")])).toThrow(
			"non-queued operation",
		);
		expect(() =>
			reduceRuntimeJournal([
				operation(request, "accepted", { kind: "steer" }),
				queue(request, "enqueued", { input: { text: "different" } }),
			]),
		).toThrow("input does not match");
	});

	it("interrupts a started tool without replay and requests a synthetic result", () => {
		const request = identity();
		const prefix = [
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
			tool(request, "started"),
		];
		const recovered = reduceRuntimeJournal(prefix);

		expect(recovered.tools).toMatchObject([{ turnId: request.turnId, toolCallId: "tool-call-1", state: "active" }]);
		expect(recovered.decisions).toContainEqual({
			type: "interrupt_tool",
			turnId: request.turnId,
			toolCallId: "tool-call-1",
			toolName: "write_file",
			reason: "server_restarted",
			needsSyntheticResult: true,
		});

		const materialized = materializeRecovery(prefix);
		const interruptedMarker = materialized.findIndex(
			(entry) =>
				(entry as { type?: string; state?: string }).type === "runtime_tool" &&
				(entry as { state?: string }).state === "interrupted",
		);
		const syntheticResult = materialized.findIndex(
			(entry) =>
				(entry as { type?: string }).type === "message" &&
				(entry as { message?: { role?: string; isError?: boolean } }).message?.role === "toolResult" &&
				(entry as { message?: { isError?: boolean } }).message?.isError === true,
		);
		expect(interruptedMarker).toBeGreaterThan(-1);
		expect(syntheticResult).toBeGreaterThan(interruptedMarker);
		expect(reduceRuntimeJournal(materialized).decisions).toEqual([]);
	});

	it("accepts legacy size-less image refs as durable tool-result evidence", () => {
		const request = identity("legacy-tool-result-image");
		const textResult = toolResult(request.turnId);
		const result = {
			...textResult,
			message: {
				...textResult.message,
				content: [{ type: "image_ref", hash: "a".repeat(64), mimeType: "image/png" }],
			},
		};
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
			tool(request, "started"),
			result,
			tool(request, "completed"),
		]);

		expect(recovered.tools).toMatchObject([{ toolCallId: "tool-call-1", state: "completed" }]);
	});

	it("synthesizes a result when the assistant tool call was durable but execution never started", () => {
		const request = identity("before-tool-start");
		const prefix = [
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
		];
		const recovered = reduceRuntimeJournal(prefix);

		expect(recovered.tools).toEqual([]);
		expect(recovered.decisions).toContainEqual({
			type: "synthesize_tool_result",
			turnId: request.turnId,
			toolCallId: "tool-call-1",
			toolName: "write_file",
			reason: "server_restarted",
		});
		expect(recovered.decisions.some((decision) => decision.type === "interrupt_tool")).toBe(false);

		const materialized = materializeRecovery(prefix);
		const syntheticResult = materialized.findIndex(
			(entry) =>
				(entry as { type?: string }).type === "message" &&
				(entry as { message?: { role?: string } }).message?.role === "toolResult",
		);
		const interruptedTurn = materialized.findIndex(
			(entry) =>
				(entry as { type?: string; state?: string }).type === "runtime_turn" &&
				(entry as { state?: string }).state === "interrupted",
		);
		expect(syntheticResult).toBeGreaterThan(-1);
		expect(interruptedTurn).toBeGreaterThan(syntheticResult);
		expect(reduceRuntimeJournal(materialized).decisions).toEqual([]);
	});

	it("does not synthesize when a non-executed tool call already has a durable result", () => {
		const request = identity("immediate-tool-result");
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
			toolResult(request.turnId),
		]);

		expect(recovered.decisions.some((decision) => decision.type === "synthesize_tool_result")).toBe(false);
	});

	it("uses a durable tool result as completion evidence without replay", () => {
		const request = identity();
		const prefix = [
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
			tool(request, "started"),
			toolResult(request.turnId),
		];
		const recovered = reduceRuntimeJournal(prefix);

		expect(recovered.tools).toMatchObject([{ toolCallId: "tool-call-1", state: "active" }]);
		expect(recovered.decisions).toContainEqual({
			type: "complete_tool",
			turnId: request.turnId,
			toolCallId: "tool-call-1",
			toolName: "write_file",
		});
		expect(recovered.decisions.some((decision) => decision.type === "interrupt_tool")).toBe(false);
		expect(reduceRuntimeJournal(materializeRecovery(prefix)).decisions).toEqual([]);
	});

	it("repairs a crash after an interrupted tool marker but before its synthetic result", () => {
		const request = identity("interrupted-tool");
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId),
			tool(request, "started"),
			tool(request, "interrupted"),
		]);

		expect(recovered.decisions).toContainEqual({
			type: "synthesize_tool_result",
			turnId: request.turnId,
			toolCallId: "tool-call-1",
			toolName: "write_file",
			reason: "server_restarted",
		});
	});

	it("rejects reversed tool marker and evidence order", () => {
		const request = identity("reversed-tool-order");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");

		expect(() => reduceRuntimeJournal([accepted, started, tool(request, "started")])).toThrow(
			"started before its assistant tool-call evidence",
		);
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				tool(request, "completed"),
				toolResult(request.turnId),
			]),
		).toThrow("completed before its durable result");

		const resolvedCall = [accepted, started, assistantToolCall(request.turnId), toolResult(request.turnId)];
		expect(() =>
			reduceRuntimeJournal([
				...resolvedCall,
				runtimeTurn(request.turnId, [request.operationId], "interrupted"),
				tool(request, "started"),
			]),
		).toThrow("inside an active turn");
	});

	it("rejects duplicate tool-call identities and conflicting cross evidence", () => {
		const request = identity("duplicate-tool-call");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		const duplicateCalls = assistantMessage(request.turnId, "toolUse", [
			{ type: "toolCall", id: "duplicate", name: "write_file", arguments: {} },
			{ type: "toolCall", id: "duplicate", name: "write_file", arguments: {} },
		]);
		expect(() => reduceRuntimeJournal([accepted, started, duplicateCalls])).toThrow("duplicated in one runtime turn");

		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				tool(request, "started"),
			]),
		).toThrow("started more than once");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started", { toolName: "different_tool" }),
			]),
		).toThrow("Conflicting tool names");
	});

	it("uses only a terminal assistant message as operation completion evidence", () => {
		const request = identity();
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		const completed = reduceRuntimeJournal([
			operation(request, "accepted"),
			started,
			assistantMessage(request.turnId, "stop"),
		]);
		expect(completed.decisions).toContainEqual({
			type: "complete_operation",
			operationId: request.operationId,
			turnId: request.turnId,
		});

		const stillActive = reduceRuntimeJournal([
			operation(request, "accepted"),
			started,
			assistantMessage(request.turnId, "toolUse"),
		]);
		expect(stillActive.decisions).toContainEqual({
			type: "interrupt_operation",
			operationId: request.operationId,
			turnId: request.turnId,
			reason: "server_restarted",
		});
	});

	it("uses the latest valid assistant outcome across automatic retries", () => {
		const request = identity("automatic-retry-evidence");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		const error = assistantMessage(request.turnId, "error");
		const stop = assistantMessage(request.turnId, "stop");

		const recoveredSuccess = reduceRuntimeJournal([accepted, started, error, stop]);
		expect(recoveredSuccess.decisions).toContainEqual({
			type: "complete_operation",
			operationId: request.operationId,
			turnId: request.turnId,
		});

		const recoveredFailure = reduceRuntimeJournal([accepted, started, stop, error]);
		expect(recoveredFailure.decisions).toContainEqual({
			type: "interrupt_operation",
			operationId: request.operationId,
			turnId: request.turnId,
			reason: "server_restarted",
		});
		expect(recoveredFailure.decisions.some((decision) => decision.type === "complete_turn")).toBe(false);
	});

	it("drops obsolete unstarted tool-call evidence after an automatic retry", () => {
		const request = identity("retry-clears-tool-call");
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantToolCall(request.turnId, "failed-attempt", "write_file", "error"),
			assistantMessage(request.turnId, "stop"),
		]);

		expect(recovered.decisions.some((decision) => decision.type === "synthesize_tool_result")).toBe(false);
		expect(recovered.decisions).toContainEqual({ type: "complete_turn", turnId: request.turnId });
	});

	it("rejects steering that starts a new provider epoch with unresolved tool-call evidence", () => {
		const direct = identity("extension-clears-tool-call");
		const steering = identity("extension-clears-tool-call-steering");
		expect(() =>
			reduceRuntimeJournal([
				operation(direct, "accepted"),
				runtimeTurn(direct.turnId, [direct.operationId], "started"),
				assistantToolCall(direct.turnId, "obsolete-call"),
				operation(steering, "accepted", { kind: "steer" }),
				queue(steering, "enqueued"),
				runtimeTurn(direct.turnId, [direct.operationId, steering.operationId], "started", [steering.queueItemId]),
			]),
		).toThrow("started a provider epoch with unresolved tool calls");
	});

	it("does not complete a turn from truncated tool calls or failed assistant messages", () => {
		const request = identity("conservative-assistant-evidence");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");

		for (const message of [
			assistantMessage(request.turnId, "length", [
				{ type: "toolCall", id: "truncated-tool", name: "write_file", arguments: {} },
			]),
			assistantMessage(request.turnId, "error"),
			assistantMessage(request.turnId, "aborted"),
		]) {
			const recovered = reduceRuntimeJournal([accepted, started, message]);
			expect(recovered.decisions).toContainEqual({
				type: "interrupt_operation",
				operationId: request.operationId,
				turnId: request.turnId,
				reason: "server_restarted",
			});
		}
	});

	it("does not complete a turn while a tool result is still unresolved", () => {
		const request = identity("unresolved-tool");
		expect(() =>
			reduceRuntimeJournal([
				operation(request, "accepted"),
				runtimeTurn(request.turnId, [request.operationId], "started"),
				assistantToolCall(request.turnId),
				tool(request, "started"),
				assistantMessage(request.turnId),
			]),
		).toThrow("advanced with an unresolved started tool");
	});

	it("rejects schema-invalid tagged assistant and tool-result evidence", () => {
		const request = identity("malformed-evidence");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		const assistant = assistantMessage(request.turnId);
		const { content: _assistantContent, ...assistantWithoutContent } = assistant.message;
		expect(() =>
			reduceRuntimeJournal([accepted, started, { ...assistant, message: assistantWithoutContent }]),
		).toThrow("content must be an array");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantMessage(request.turnId, "toolUse", [
					{ type: "toolCall", id: "invalid-arguments", name: "write_file", arguments: [] },
				]),
			]),
		).toThrow("arguments must be an object");

		const result = toolResult(request.turnId);
		const { isError: _isError, ...resultWithoutErrorFlag } = result.message;
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				{ ...result, message: resultWithoutErrorFlag },
			]),
		).toThrow("isError must be a boolean");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				{ ...result, message: { ...result.message, toolName: "different_tool" } },
			]),
		).toThrow("conflicting tool name");
	});

	it("fails closed on contradictory completed prompt, turn, and tool states", () => {
		const request = identity("contradictory-completion");
		const accepted = operation(request, "accepted");
		const started = runtimeTurn(request.turnId, [request.operationId], "started");
		expect(() =>
			reduceRuntimeJournal([accepted, operation(request, "completed", { turnId: request.turnId })]),
		).toThrow("no provably completed turn");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				runtimeTurn(request.turnId, [request.operationId], "completed"),
				operation(request, "completed", { turnId: request.turnId }),
			]),
		).toThrow("no completed terminal evidence");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantMessage(request.turnId),
				runtimeTurn(request.turnId, [request.operationId], "started"),
				runtimeTurn(request.turnId, [request.operationId], "completed"),
				operation(request, "completed", { turnId: request.turnId }),
			]),
		).toThrow("no completed terminal evidence");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				runtimeTurn(request.turnId, [request.operationId], "completed"),
			]),
		).toThrow("became terminal with unresolved tool calls");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantToolCall(request.turnId),
				tool(request, "started"),
				tool(request, "interrupted"),
				toolResult(request.turnId),
				assistantMessage(request.turnId),
				runtimeTurn(request.turnId, [request.operationId], "completed"),
			]),
		).toThrow("unresolved or interrupted tool");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantMessage(request.turnId, "error"),
				runtimeTurn(request.turnId, [request.operationId], "completed"),
			]),
		).toThrow("interrupted assistant evidence");
		expect(() =>
			reduceRuntimeJournal([
				accepted,
				started,
				assistantMessage(request.turnId),
				operation(request, "interrupted", { turnId: request.turnId }),
				runtimeTurn(request.turnId, [request.operationId], "completed"),
			]),
		).toThrow("belongs to a completed turn");
	});

	it("repairs a missing turn finish when a completed prompt has valid terminal evidence", () => {
		const request = identity("completed-operation-evidence");
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			assistantMessage(request.turnId),
			operation(request, "completed", { turnId: request.turnId }),
		]);
		expect(recovered.decisions).toEqual([{ type: "complete_turn", turnId: request.turnId }]);
	});

	it("rejects unknown runtime control entry types", () => {
		expect(() => reduceRuntimeJournal([{ ...entryBase(), type: "runtime_operatoin" }])).toThrow(
			"Unknown runtime journal entry type",
		);
	});

	it("attributes assistant evidence only to its turn and leaves an unconsumed queue item as a draft", () => {
		const direct = identity("direct-request");
		const queued = identity("queued-request");
		const recovered = reduceRuntimeJournal([
			operation(direct, "accepted"),
			runtimeTurn(direct.turnId, [direct.operationId], "started"),
			operation(queued, "accepted", { kind: "steer" }),
			queue(queued, "enqueued"),
			assistantMessage(direct.turnId),
		]);

		expect(recovered.decisions).toContainEqual({
			type: "complete_operation",
			operationId: direct.operationId,
			turnId: direct.turnId,
		});
		expect(recovered.decisions).toContainEqual({
			type: "cancel_queue",
			queueItemId: queued.queueItemId,
			reason: "server_restarted",
			draft: input,
		});
		expect(recovered.decisions).not.toContainEqual({
			type: "complete_operation",
			operationId: queued.operationId,
		});
	});

	it("does not treat an untagged assistant message as turn completion evidence", () => {
		const request = identity("untagged");
		const recovered = reduceRuntimeJournal([
			operation(request, "accepted"),
			runtimeTurn(request.turnId, [request.operationId], "started"),
			{ ...entryBase(), type: "message", message: { role: "assistant", stopReason: "stop" } },
		]);
		expect(recovered.decisions).toContainEqual({
			type: "interrupt_turn",
			turnId: request.turnId,
			reason: "server_restarted",
		});
	});
});
