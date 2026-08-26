import { createHash } from "node:crypto";
import type { PlanRef } from "./plan-state.ts";

const SUBMIT_PROMPT_METHOD = "session/submitPrompt";
const MAX_PLAN_ID_CODE_UNITS = 128;
const MAX_RUNTIME_METHOD_CODE_UNITS = 256;
const MAX_REQUEST_ID_CODE_UNITS = 256;
export const MAX_DURABLE_PROMPT_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_DURABLE_PROMPT_IMAGES = 20;
// 3,538,944 raw bytes encode to exactly 4.5 MiB of base64 provider payload.
export const MAX_DURABLE_IMAGE_BYTES = 3_538_944;
export const MAX_DURABLE_PROMPT_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_DURABLE_TURN_RESIDENT_PAYLOAD_BYTES =
	MAX_DURABLE_PROMPT_TEXT_BYTES + 4 * Math.ceil(MAX_DURABLE_PROMPT_IMAGE_BYTES / 3) + 4 * MAX_DURABLE_PROMPT_IMAGES;
const MAX_MIME_TYPE_CODE_UNITS = 256;
const MAX_CANONICAL_PARAMS_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 100;
const MAX_CANONICAL_NODES = 100_000;

export interface DurableImageRef {
	readonly type: "image_ref";
	readonly hash: string;
	readonly mimeType: string;
	readonly size: number;
}

export type PlanExecutionRef = PlanRef;

export interface DurablePromptInput {
	readonly text: string;
	readonly images?: readonly DurableImageRef[];
	readonly streamingBehavior?: "steer" | "followUp";
	readonly planExecution?: PlanExecutionRef;
}

export interface DurablePromptSubmission {
	readonly requestId: string;
	readonly input: DurablePromptInput;
}

export interface RuntimeRequestIdentity {
	readonly requestId: string;
	readonly requestHash: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly queueItemId: string;
}

export type RuntimeOperationKind =
	| "turn"
	| "steer"
	| "next_turn"
	| "interrupt"
	| "compact"
	| "navigate"
	| "session_create"
	| "session_close"
	| "session_archive"
	| "session_unarchive";
export type RuntimeOperationState = "accepted" | "completed" | "interrupted";
export type RuntimeQueueKind = "steer" | "follow_up" | "next_turn";
export type RuntimeQueueState = "enqueued" | "paused" | "dispatching" | "consumed" | "cancelled";
export type RuntimeTurnState = "started" | "completed" | "interrupted";
export type RuntimeToolState = "started" | "completed" | "interrupted";

interface RuntimeEntryBase {
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface RuntimeOperationEntry extends RuntimeEntryBase {
	readonly type: "runtime_operation";
	readonly operationId: string;
	readonly requestId: string;
	readonly requestHash: string;
	readonly kind: RuntimeOperationKind;
	readonly state: RuntimeOperationState;
	readonly turnId?: string;
	readonly input?: DurablePromptInput;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface RuntimeQueueEntry extends RuntimeEntryBase {
	readonly type: "runtime_queue";
	readonly operationId: string;
	readonly queueItemId: string;
	readonly queue: RuntimeQueueKind;
	readonly state: RuntimeQueueState;
	readonly input?: DurablePromptInput;
	readonly requestId?: string;
	readonly enqueueHash?: string;
	readonly deliveryRequestId?: string;
	readonly turnId?: string;
	readonly reason?: string;
}

export interface RuntimeTurnEntry extends RuntimeEntryBase {
	readonly type: "runtime_turn";
	readonly turnId: string;
	readonly operationIds: readonly string[];
	readonly state: RuntimeTurnState;
	readonly consumedQueueItemIds: readonly string[];
}

export interface RuntimeToolEntry extends RuntimeEntryBase {
	readonly type: "runtime_tool";
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly state: RuntimeToolState;
}

export type RuntimeControlEntry = RuntimeOperationEntry | RuntimeQueueEntry | RuntimeTurnEntry | RuntimeToolEntry;

export interface ReducedRuntimeOperation {
	readonly operationId: string;
	readonly requestId: string;
	readonly requestHash: string;
	readonly kind: RuntimeOperationKind;
	readonly state: "active" | "completed" | "interrupted";
	readonly turnId?: string;
	readonly input?: DurablePromptInput;
	readonly error?: { readonly code: string; readonly message: string };
}

export interface ReducedRuntimeQueueItem {
	readonly operationId: string;
	readonly queueItemId: string;
	readonly queue: RuntimeQueueKind;
	readonly state: RuntimeQueueState;
	readonly input: DurablePromptInput;
	readonly revision: string;
	readonly requestId?: string;
	readonly enqueueHash?: string;
	readonly deliveryRequestId?: string;
	readonly turnId?: string;
	readonly reason?: string;
}

export interface ReducedRuntimeTurn {
	readonly turnId: string;
	readonly operationIds: readonly string[];
	readonly state: "active" | "completed" | "interrupted";
	readonly consumedQueueItemIds: readonly string[];
}

export interface ReducedRuntimeTool {
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly state: "active" | "completed" | "interrupted";
}

export type RuntimeRecoveryDecision =
	| { readonly type: "complete_operation"; readonly operationId: string; readonly turnId?: string }
	| {
			readonly type: "interrupt_operation";
			readonly operationId: string;
			readonly turnId?: string;
			readonly reason: "server_restarted";
	  }
	| { readonly type: "complete_turn"; readonly turnId: string }
	| { readonly type: "interrupt_turn"; readonly turnId: string; readonly reason: "server_restarted" }
	| {
			readonly type: "complete_tool";
			readonly turnId: string;
			readonly toolCallId: string;
			readonly toolName: string;
	  }
	| {
			readonly type: "interrupt_tool";
			readonly turnId: string;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly reason: "server_restarted";
			readonly needsSyntheticResult: true;
	  }
	| {
			readonly type: "synthesize_tool_result";
			readonly turnId: string;
			readonly toolCallId: string;
			readonly toolName: string;
			readonly reason: "server_restarted";
	  }
	| {
			readonly type: "pause_queue";
			readonly queueItemId: string;
			readonly reason: "server_restarted";
	  }
	| {
			readonly type: "cancel_queue";
			readonly queueItemId: string;
			readonly reason: "server_restarted";
			readonly draft: DurablePromptInput;
	  };

export interface RuntimeRecoveryResult {
	readonly operations: readonly ReducedRuntimeOperation[];
	readonly queues: readonly ReducedRuntimeQueueItem[];
	readonly turns: readonly ReducedRuntimeTurn[];
	readonly tools: readonly ReducedRuntimeTool[];
	readonly decisions: readonly RuntimeRecoveryDecision[];
}

export class RequestIdReusedError extends Error {
	readonly code = "REQUEST_ID_REUSED";
	readonly requestId: string;

	constructor(requestId: string) {
		super(`Request ID was reused with different durable parameters: ${requestId}`);
		this.name = "RequestIdReusedError";
		this.requestId = requestId;
	}
}

function invalid(message: string): never {
	throw new TypeError(message);
}

function dataFields(value: unknown, label: string): Map<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);

	const fields = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid(`${label} must not contain symbol fields`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			invalid(`${label} must contain only enumerable data properties`);
		}
		fields.set(key, descriptor.value);
	}
	return fields;
}

function dataArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(`${label} must be an array`);
	const keys = Reflect.ownKeys(value);
	if (
		keys.some((key) => {
			if (key === "length") return false;
			if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return true;
			const index = Number(key);
			return !Number.isSafeInteger(index) || index >= value.length || String(index) !== key;
		})
	) {
		invalid(`${label} must not contain extra fields`);
	}
	const result: unknown[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			invalid(`${label} must be dense and contain only data properties`);
		}
		result.push(descriptor.value);
	}
	return result;
}

function assertOnlyFields(fields: ReadonlyMap<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedFields = new Set(allowed);
	const unknown = [...fields.keys()].filter((key) => !allowedFields.has(key));
	if (unknown.length > 0) invalid(`${label} has unknown field: ${unknown.sort()[0]}`);
}

function requiredString(fields: ReadonlyMap<string, unknown>, key: string, label: string): string {
	const value = fields.get(key);
	if (typeof value !== "string" || value.length === 0) invalid(`${label}.${key} must be a non-empty string`);
	return value;
}

function boundedCodeUnits(value: string, maximum: number, label: string): string {
	if (value.length > maximum) invalid(`${label} must not exceed ${maximum} code units`);
	return value;
}

function finiteNumber(fields: ReadonlyMap<string, unknown>, key: string, label: string): number {
	const value = fields.get(key);
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label}.${key} must be a finite number`);
	return value;
}

function optionalString(fields: ReadonlyMap<string, unknown>, key: string, label: string): string | undefined {
	if (!fields.has(key)) return undefined;
	return requiredString(fields, key, label);
}

interface ParsedImageRef {
	readonly type: "image_ref";
	readonly hash: string;
	readonly mimeType: string;
	readonly size?: number;
}

function parseImageRef(value: unknown, label: string, requireSize: boolean): ParsedImageRef {
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["type", "hash", "mimeType", "size"], label);
	if (fields.get("type") !== "image_ref") invalid(`${label}.type must be image_ref`);
	const hash = requiredString(fields, "hash", label);
	if (!/^[a-f0-9]{64}$/.test(hash)) invalid(`${label}.hash must be a lowercase SHA-256 hash`);
	const mimeType = boundedCodeUnits(
		requiredString(fields, "mimeType", label),
		MAX_MIME_TYPE_CODE_UNITS,
		`${label}.mimeType`,
	);
	const size = fields.get("size");
	if (size === undefined) {
		if (requireSize) invalid(`${label}.size is required`);
		return { type: "image_ref", hash, mimeType };
	}
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
		invalid(`${label}.size must be a positive safe integer`);
	}
	return { type: "image_ref", hash, mimeType, size };
}

function parseDurableImageRef(value: unknown, label: string): DurableImageRef {
	const reference = parseImageRef(value, label, true);
	if (reference.size === undefined) invalid(`${label}.size is required`);
	if (reference.size > MAX_DURABLE_IMAGE_BYTES) {
		invalid(`${label}.size must not exceed ${MAX_DURABLE_IMAGE_BYTES} bytes`);
	}
	return { ...reference, size: reference.size };
}

function parsePlanExecutionRef(value: unknown, label: string): PlanExecutionRef {
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["planId", "revision"], label);
	const planId = boundedCodeUnits(requiredString(fields, "planId", label), MAX_PLAN_ID_CODE_UNITS, `${label}.planId`);
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(planId)) invalid(`${label}.planId contains control characters`);
	const revision = fields.get("revision");
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
		invalid(`${label}.revision must be a positive safe integer`);
	}
	return { planId, revision };
}

function parseDurablePromptInput(value: unknown, label: string): DurablePromptInput {
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["text", "images", "streamingBehavior", "planExecution"], label);
	const text = fields.get("text");
	if (typeof text !== "string") invalid(`${label}.text must be a string`);
	if (Buffer.byteLength(text, "utf8") > MAX_DURABLE_PROMPT_TEXT_BYTES) {
		invalid(`${label}.text must not exceed ${MAX_DURABLE_PROMPT_TEXT_BYTES} UTF-8 bytes`);
	}

	let images: readonly DurableImageRef[] | undefined;
	if (fields.has("images")) {
		const imageValues = dataArray(fields.get("images"), `${label}.images`);
		if (imageValues.length > MAX_DURABLE_PROMPT_IMAGES) {
			invalid(`${label}.images must not contain more than ${MAX_DURABLE_PROMPT_IMAGES} image references`);
		}
		images = imageValues.map((image, index) => parseDurableImageRef(image, `${label}.images[${index}]`));
		const totalImageBytes = images.reduce((total, image) => total + image.size, 0);
		if (totalImageBytes > MAX_DURABLE_PROMPT_IMAGE_BYTES) {
			invalid(`${label}.images must not exceed ${MAX_DURABLE_PROMPT_IMAGE_BYTES} total bytes`);
		}
	}

	let streamingBehavior: DurablePromptInput["streamingBehavior"];
	if (fields.has("streamingBehavior")) {
		const value = fields.get("streamingBehavior");
		if (value !== "steer" && value !== "followUp") {
			invalid(`${label}.streamingBehavior must be steer or followUp`);
		}
		streamingBehavior = value;
	}

	let planExecution: PlanExecutionRef | undefined;
	if (fields.has("planExecution")) {
		planExecution = parsePlanExecutionRef(fields.get("planExecution"), `${label}.planExecution`);
	}
	if (planExecution && (images !== undefined || streamingBehavior !== undefined)) {
		invalid(`${label} cannot combine planExecution with images or streamingBehavior`);
	}

	return {
		text,
		...(images === undefined ? {} : { images }),
		...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		...(planExecution === undefined ? {} : { planExecution }),
	};
}

export function parseDurablePromptSubmission(value: unknown): DurablePromptSubmission {
	const fields = dataFields(value, "durable prompt submission");
	assertOnlyFields(
		fields,
		["requestId", "text", "images", "streamingBehavior", "planExecution"],
		"durable prompt submission",
	);
	const inputFields = new Map(fields);
	inputFields.delete("requestId");
	return {
		requestId: boundedCodeUnits(
			requiredString(fields, "requestId", "durable prompt submission"),
			MAX_REQUEST_ID_CODE_UNITS,
			"durable prompt submission.requestId",
		),
		input: parseDurablePromptInput(Object.fromEntries(inputFields), "durable prompt submission"),
	};
}

interface CanonicalJsonState {
	readonly seen: WeakSet<object>;
	nodes: number;
}

function canonicalJson(
	value: unknown,
	state: CanonicalJsonState = { seen: new WeakSet<object>(), nodes: 0 },
	depth = 0,
): string {
	state.nodes += 1;
	if (state.nodes > MAX_CANONICAL_NODES) invalid("durable request parameters contain too many JSON values");
	if (depth > MAX_CANONICAL_DEPTH) invalid("durable request parameters are nested too deeply");
	if (value === null || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") > MAX_CANONICAL_PARAMS_BYTES) {
			invalid(`durable JSON string must not exceed ${MAX_CANONICAL_PARAMS_BYTES} UTF-8 bytes`);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid("durable JSON numbers must be finite");
		return JSON.stringify(value);
	}
	if (typeof value !== "object") invalid("durable request parameters must contain only JSON values");
	if (state.seen.has(value)) invalid("durable request parameters must not be cyclic");
	state.seen.add(value);
	try {
		if (Array.isArray(value)) {
			return `[${dataArray(value, "durable JSON array")
				.map((item) => canonicalJson(item, state, depth + 1))
				.join(",")}]`;
		}
		const fields = [...dataFields(value, "durable JSON object")].sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		);
		return `{${fields
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, state, depth + 1)}`)
			.join(",")}}`;
	} finally {
		state.seen.delete(value);
	}
}

function deriveId(namespace: "operation" | "turn" | "queue", requestId: string): string {
	const digest = createHash("sha256").update(`arcmind.runtime.v1\0${namespace}\0${requestId}`).digest("hex");
	return `${namespace}_${digest}`;
}

export function deriveBatchedTurnId(consumedQueueItemIds: readonly string[]): string {
	const ids = dataArray(consumedQueueItemIds, "consumed queue item IDs").map((value, index) => {
		if (typeof value !== "string" || value.length === 0) {
			invalid(`consumed queue item IDs[${index}] must be a non-empty string`);
		}
		boundedCodeUnits(value, MAX_REQUEST_ID_CODE_UNITS, `consumed queue item IDs[${index}]`);
		return value;
	});
	if (ids.length === 0) invalid("a batched turn must consume at least one queue item");
	if (new Set(ids).size !== ids.length) invalid("consumed queue item IDs must not contain duplicates");
	const digest = createHash("sha256")
		.update(`arcmind.runtime.v1\0batched-turn\0${canonicalJson(ids)}`)
		.digest("hex");
	return `turn_${digest}`;
}

function hashRuntimeRequest(method: string, params: unknown): string {
	const canonicalParams = canonicalJson(params);
	if (Buffer.byteLength(canonicalParams, "utf8") > MAX_CANONICAL_PARAMS_BYTES) {
		invalid(`canonical runtime request parameters must not exceed ${MAX_CANONICAL_PARAMS_BYTES} UTF-8 bytes`);
	}
	// `method` sorts before `params`, preserving the existing canonical hash format.
	const canonicalRequest = `{"method":${JSON.stringify(method)},"params":${canonicalParams}}`;
	return createHash("sha256").update(canonicalRequest).digest("hex");
}

export function identifyRuntimeRequest(method: string, requestId: string, params: unknown): RuntimeRequestIdentity {
	if (typeof method !== "string" || method.length === 0) invalid("runtime method must be a non-empty string");
	if (typeof requestId !== "string" || requestId.length === 0) invalid("requestId must be a non-empty string");
	boundedCodeUnits(method, MAX_RUNTIME_METHOD_CODE_UNITS, "runtime method");
	boundedCodeUnits(requestId, MAX_REQUEST_ID_CODE_UNITS, "requestId");
	const requestHash = hashRuntimeRequest(method, params);
	return {
		requestId,
		requestHash,
		operationId: deriveId("operation", requestId),
		turnId: deriveId("turn", requestId),
		queueItemId: deriveId("queue", requestId),
	};
}

export function identifySubmitPromptRequest(requestId: string, input: unknown): RuntimeRequestIdentity {
	return identifyRuntimeRequest(
		SUBMIT_PROMPT_METHOD,
		requestId,
		parseDurablePromptInput(input, "durable prompt input"),
	);
}

const operationKinds = new Set<RuntimeOperationKind>([
	"turn",
	"steer",
	"next_turn",
	"interrupt",
	"compact",
	"navigate",
	"session_create",
	"session_close",
	"session_archive",
	"session_unarchive",
]);
const appServerOperationKinds = new Set<RuntimeOperationKind>([
	"session_create",
	"session_close",
	"session_archive",
	"session_unarchive",
]);
const operationStates = new Set<RuntimeOperationState>(["accepted", "completed", "interrupted"]);
const queueKinds = new Set<RuntimeQueueKind>(["steer", "follow_up", "next_turn"]);
const queueStates = new Set<RuntimeQueueState>(["enqueued", "paused", "dispatching", "consumed", "cancelled"]);
const turnStates = new Set<RuntimeTurnState>(["started", "completed", "interrupted"]);
const toolStates = new Set<RuntimeToolState>(["started", "completed", "interrupted"]);
const runtimeControlEntryTypes = new Set<RuntimeControlEntry["type"]>([
	"runtime_operation",
	"runtime_queue",
	"runtime_turn",
	"runtime_tool",
]);

export function isRuntimeControlEntryType(type: unknown): type is RuntimeControlEntry["type"] {
	return typeof type === "string" && runtimeControlEntryTypes.has(type as RuntimeControlEntry["type"]);
}

function enumValue<T extends string>(
	fields: ReadonlyMap<string, unknown>,
	key: string,
	values: ReadonlySet<T>,
	label: string,
): T {
	const value = fields.get(key);
	if (typeof value !== "string" || !values.has(value as T)) invalid(`${label}.${key} is invalid`);
	return value as T;
}

function parseEntryBase(fields: ReadonlyMap<string, unknown>, label: string): RuntimeEntryBase {
	const parentId = fields.get("parentId");
	if (parentId !== null && (typeof parentId !== "string" || parentId.length === 0)) {
		invalid(`${label}.parentId must be null or a non-empty string`);
	}
	return {
		id: requiredString(fields, "id", label),
		parentId,
		timestamp: requiredString(fields, "timestamp", label),
	};
}

function optionalInput(fields: ReadonlyMap<string, unknown>, label: string): DurablePromptInput | undefined {
	return fields.has("input") ? parseDurablePromptInput(fields.get("input"), `${label}.input`) : undefined;
}

function optionalStringArray(fields: ReadonlyMap<string, unknown>, key: string, label: string): string[] | undefined {
	if (!fields.has(key)) return undefined;
	const values = dataArray(fields.get(key), `${label}.${key}`).map((value, index) => {
		if (typeof value !== "string" || value.length === 0) invalid(`${label}.${key}[${index}] must be a string`);
		return value;
	});
	if (new Set(values).size !== values.length) invalid(`${label}.${key} must not contain duplicates`);
	return values;
}

function parseOperation(value: unknown): RuntimeOperationEntry {
	const label = "runtime operation";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		[
			"type",
			"id",
			"parentId",
			"timestamp",
			"operationId",
			"requestId",
			"requestHash",
			"kind",
			"state",
			"turnId",
			"input",
			"error",
		],
		label,
	);
	const requestId = boundedCodeUnits(
		requiredString(fields, "requestId", label),
		MAX_REQUEST_ID_CODE_UNITS,
		`${label}.requestId`,
	);
	const operationId = requiredString(fields, "operationId", label);
	if (operationId !== deriveId("operation", requestId)) invalid(`${label}.operationId is not derived from requestId`);
	const requestHash = requiredString(fields, "requestHash", label);
	if (!/^[a-f0-9]{64}$/.test(requestHash)) invalid(`${label}.requestHash must be a lowercase SHA-256 hash`);
	const kind = enumValue(fields, "kind", operationKinds, label);
	const state = enumValue(fields, "state", operationStates, label);
	const turnId = optionalString(fields, "turnId", label);
	const input = optionalInput(fields, label);
	if (state === "accepted" && (kind === "turn" || kind === "steer" || kind === "next_turn") && input === undefined) {
		invalid(`${label}.input is required when accepting a prompt operation`);
	}
	if (
		state === "accepted" &&
		(kind === "turn" || kind === "steer" || kind === "next_turn") &&
		requestHash !== hashRuntimeRequest(SUBMIT_PROMPT_METHOD, input)
	) {
		invalid(`${label}.requestHash does not match its durable input`);
	}
	if (kind === "turn" && turnId !== undefined && turnId !== deriveId("turn", requestId)) {
		invalid(`${label}.turnId is not derived from requestId`);
	}
	let error: RuntimeOperationEntry["error"];
	if (fields.has("error")) {
		const errorFields = dataFields(fields.get("error"), `${label}.error`);
		assertOnlyFields(errorFields, ["code", "message"], `${label}.error`);
		error = {
			code: requiredString(errorFields, "code", `${label}.error`),
			message: requiredString(errorFields, "message", `${label}.error`),
		};
	}

	return {
		...parseEntryBase(fields, label),
		type: "runtime_operation",
		operationId,
		requestId,
		requestHash,
		kind,
		state,
		...(turnId === undefined ? {} : { turnId }),
		...(input === undefined ? {} : { input }),
		...(error === undefined ? {} : { error }),
	};
}

function parseQueue(value: unknown): RuntimeQueueEntry {
	const label = "runtime queue entry";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		[
			"type",
			"id",
			"parentId",
			"timestamp",
			"operationId",
			"queueItemId",
			"queue",
			"state",
			"input",
			"requestId",
			"enqueueHash",
			"deliveryRequestId",
			"turnId",
			"reason",
		],
		label,
	);
	const queue = enumValue(fields, "queue", queueKinds, label);
	const state = enumValue(fields, "state", queueStates, label);
	const input = optionalInput(fields, label);
	if (state === "enqueued" && input === undefined) invalid(`${label}.input is required when enqueued`);
	if (queue !== "next_turn" && (state === "paused" || state === "dispatching")) {
		invalid(`${label}.${state} is only valid for next_turn`);
	}
	const turnId = optionalString(fields, "turnId", label);
	if (state === "consumed" && turnId === undefined) invalid(`${label}.turnId is required when consumed`);
	let requestId: string | undefined;
	let enqueueHash: string | undefined;
	let deliveryRequestId: string | undefined;
	const operationId = requiredString(fields, "operationId", label);
	const queueItemId = requiredString(fields, "queueItemId", label);
	if (queue === "next_turn") {
		requestId = requiredString(fields, "requestId", label);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
			invalid(`${label}.requestId must be a UUID`);
		}
		enqueueHash = requiredString(fields, "enqueueHash", label);
		if (!/^[a-f0-9]{64}$/.test(enqueueHash)) invalid(`${label}.enqueueHash must be a lowercase SHA-256 hash`);
		deliveryRequestId = optionalString(fields, "deliveryRequestId", label);
		if (
			deliveryRequestId !== undefined &&
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryRequestId)
		) {
			invalid(`${label}.deliveryRequestId must be a UUID`);
		}
		if (state === "dispatching" && deliveryRequestId === undefined) {
			invalid(`${label}.deliveryRequestId is required when dispatching`);
		}
		const identity = identifyRuntimeRequest("turn/queue", deliveryRequestId ?? requestId, input ?? {});
		if (operationId !== identity.operationId) invalid(`${label}.operationId is not derived from requestId`);
		const queueIdentity = identifyRuntimeRequest("turn/queue", requestId, input ?? {});
		if (queueItemId !== queueIdentity.queueItemId) invalid(`${label}.queueItemId is not derived from requestId`);
	} else if (fields.has("requestId") || fields.has("enqueueHash") || fields.has("deliveryRequestId")) {
		invalid(`${label}.requestId, enqueueHash, and deliveryRequestId are only valid for next_turn`);
	}
	return {
		...parseEntryBase(fields, label),
		type: "runtime_queue",
		operationId,
		queueItemId,
		queue,
		state,
		...(input === undefined ? {} : { input }),
		...(requestId === undefined ? {} : { requestId }),
		...(enqueueHash === undefined ? {} : { enqueueHash }),
		...(deliveryRequestId === undefined ? {} : { deliveryRequestId }),
		...(turnId === undefined ? {} : { turnId }),
		...(fields.has("reason") ? { reason: requiredString(fields, "reason", label) } : {}),
	};
}

function parseTurn(value: unknown): RuntimeTurnEntry {
	const label = "runtime turn entry";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		["type", "id", "parentId", "timestamp", "turnId", "operationIds", "state", "consumedQueueItemIds"],
		label,
	);
	const operationIds = optionalStringArray(fields, "operationIds", label);
	if (!operationIds || operationIds.length === 0) invalid(`${label}.operationIds must not be empty`);
	const consumedQueueItemIds = optionalStringArray(fields, "consumedQueueItemIds", label);
	if (!consumedQueueItemIds) invalid(`${label}.consumedQueueItemIds is required`);
	return {
		...parseEntryBase(fields, label),
		type: "runtime_turn",
		turnId: requiredString(fields, "turnId", label),
		operationIds,
		state: enumValue(fields, "state", turnStates, label),
		consumedQueueItemIds,
	};
}

function parseTool(value: unknown): RuntimeToolEntry {
	const label = "runtime tool entry";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		["type", "id", "parentId", "timestamp", "turnId", "toolCallId", "toolName", "state"],
		label,
	);
	return {
		...parseEntryBase(fields, label),
		type: "runtime_tool",
		turnId: requiredString(fields, "turnId", label),
		toolCallId: requiredString(fields, "toolCallId", label),
		toolName: requiredString(fields, "toolName", label),
		state: enumValue(fields, "state", toolStates, label),
	};
}

export function parseRuntimeControlEntry(value: unknown): RuntimeControlEntry {
	const type = dataFields(value, "runtime control entry").get("type");
	switch (type) {
		case "runtime_operation":
			return parseOperation(value);
		case "runtime_queue":
			return parseQueue(value);
		case "runtime_turn":
			return parseTurn(value);
		case "runtime_tool":
			return parseTool(value);
		default:
			return invalid(`Unknown runtime control entry type: ${String(type)}`);
	}
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type OperationAccumulator = Omit<Mutable<ReducedRuntimeOperation>, "state"> & {
	state: RuntimeOperationState;
};

interface QueueAccumulator {
	operationId: string;
	queueItemId: string;
	queue: RuntimeQueueKind;
	input: DurablePromptInput;
	journalState: RuntimeQueueState;
	revision: string;
	requestId?: string;
	enqueueHash?: string;
	deliveryRequestId?: string;
	reason?: string;
}

interface TurnAccumulator {
	turnId: string;
	operationIds: readonly string[];
	state: RuntimeTurnState;
	consumedQueueItemIds: readonly string[];
	initialOperationIds: readonly string[];
	initialConsumedQueueItemIds: readonly string[];
	terminalEvidence?: "completed" | "interrupted";
	readonly pendingToolCallKeys: Set<string>;
}

type ToolAccumulator = Omit<Mutable<ReducedRuntimeTool>, "state"> & {
	state: RuntimeToolState;
};

interface ToolCallAccumulator {
	readonly turnId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	resultEvidence: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function mergeOperation(current: OperationAccumulator, entry: RuntimeOperationEntry): void {
	if (
		current.requestId !== entry.requestId ||
		current.requestHash !== entry.requestHash ||
		current.kind !== entry.kind
	) {
		invalid(`Conflicting immutable fields for runtime operation ${entry.operationId}`);
	}
	if (current.turnId && entry.turnId && current.turnId !== entry.turnId) {
		invalid(`Conflicting turn IDs for runtime operation ${entry.operationId}`);
	}
	if (current.input && entry.input && !sameJson(current.input, entry.input)) {
		invalid(`Conflicting input for runtime operation ${entry.operationId}`);
	}
	if (!current.turnId && entry.turnId) current.turnId = entry.turnId;
	if (!current.input && entry.input) current.input = entry.input;
	if (entry.error) current.error = entry.error;
	if (entry.state === "accepted") return;
	if (current.state !== "accepted" && current.state !== entry.state) {
		invalid(`Conflicting terminal states for runtime operation ${entry.operationId}`);
	}
	current.state = entry.state;
}

function mergeQueue(current: QueueAccumulator, entry: RuntimeQueueEntry): void {
	if (current.queue !== entry.queue || (current.queue !== "next_turn" && current.operationId !== entry.operationId)) {
		invalid(`Conflicting immutable fields for queue item ${entry.queueItemId}`);
	}
	if (current.queue === "next_turn") {
		if (entry.requestId !== current.requestId) invalid(`Queued turn ${entry.queueItemId} changed requestId`);
		if (entry.enqueueHash !== current.enqueueHash) invalid(`Queued turn ${entry.queueItemId} changed enqueueHash`);
		if (current.journalState === "consumed" || current.journalState === "cancelled") {
			invalid(`Queued turn ${entry.queueItemId} is terminal`);
		}
		if (entry.operationId !== current.operationId) {
			if (entry.state !== "dispatching" || !entry.deliveryRequestId) {
				invalid(`Queued turn ${entry.queueItemId} changed operation outside dispatch`);
			}
			current.operationId = entry.operationId;
		}
		if (entry.deliveryRequestId !== current.deliveryRequestId) {
			if (entry.state !== "dispatching" || !entry.deliveryRequestId) {
				invalid(`Queued turn ${entry.queueItemId} changed delivery request outside dispatch`);
			}
			current.deliveryRequestId = entry.deliveryRequestId;
		}
		if (entry.state === "enqueued" && !entry.input) {
			invalid(`Queued turn ${entry.queueItemId} edit is missing input`);
		}
		if ((entry.state === "enqueued" || entry.state === "paused") && entry.input) current.input = entry.input;
		current.journalState = entry.state;
		current.revision = entry.id;
		current.reason = entry.reason;
		return;
	}
	if (entry.input && !sameJson(current.input, entry.input))
		invalid(`Conflicting queue input for ${entry.queueItemId}`);
	if (entry.state === "enqueued") return;
	// `consumed` is only a projection of runtime_turn:started. A recovery
	// cancellation must be able to supersede an orphan projection idempotently.
	if (entry.state === "cancelled" || current.journalState !== "cancelled") current.journalState = entry.state;
	if (entry.reason) current.reason = entry.reason;
	current.revision = entry.id;
}

function isOrderedPrefix(prefix: readonly string[], value: readonly string[]): boolean {
	return prefix.length <= value.length && prefix.every((item, index) => item === value[index]);
}

function mergeTurn(current: TurnAccumulator, entry: RuntimeTurnEntry): boolean {
	if (entry.state === "started") {
		if (current.state !== "started") invalid(`Runtime turn ${entry.turnId} restarted after becoming terminal`);
		if (
			!isOrderedPrefix(current.operationIds, entry.operationIds) ||
			!isOrderedPrefix(current.consumedQueueItemIds, entry.consumedQueueItemIds)
		) {
			invalid(`Runtime turn ${entry.turnId} extension must preserve ordered prefixes`);
		}
		const extended =
			current.operationIds.length !== entry.operationIds.length ||
			current.consumedQueueItemIds.length !== entry.consumedQueueItemIds.length;
		current.operationIds = entry.operationIds;
		current.consumedQueueItemIds = entry.consumedQueueItemIds;
		current.terminalEvidence = undefined;
		return extended;
	}
	if (
		!sameJson(current.operationIds, entry.operationIds) ||
		!sameJson(current.consumedQueueItemIds, entry.consumedQueueItemIds)
	) {
		invalid(`Terminal runtime turn ${entry.turnId} does not match its final accumulated operations and queue items`);
	}
	if (current.state !== "started" && current.state !== entry.state) {
		invalid(`Conflicting terminal states for runtime turn ${entry.turnId}`);
	}
	current.state = entry.state;
	return false;
}

function mergeTool(current: ToolAccumulator, entry: RuntimeToolEntry): void {
	if (current.toolName !== entry.toolName) invalid(`Conflicting tool names for ${entry.toolCallId}`);
	if (entry.state === "started") invalid(`Runtime tool ${entry.toolCallId} started more than once in one turn`);
	if (current.state !== "started" && current.state !== entry.state) {
		invalid(`Conflicting terminal tool states for ${entry.toolCallId}`);
	}
	current.state = entry.state;
}

export interface RuntimeToolCallEvidence {
	readonly toolCallId: string;
	readonly toolName: string;
}

export interface RuntimeAssistantMessageEvidence {
	readonly outcome: "completed" | "interrupted" | undefined;
	readonly toolCalls: readonly RuntimeToolCallEvidence[];
}

interface AssistantEvidence extends RuntimeAssistantMessageEvidence {
	readonly turnId: string;
}

function optionalStringField(fields: ReadonlyMap<string, unknown>, key: string, label: string): void {
	if (fields.has(key) && typeof fields.get(key) !== "string") invalid(`${label}.${key} must be a string`);
}

function parseAssistantCompletionContent(value: unknown): RuntimeToolCallEvidence[] {
	const toolCalls: RuntimeToolCallEvidence[] = [];
	for (const [index, block] of dataArray(value, "assistant completion evidence content").entries()) {
		const label = `assistant completion evidence content[${index}]`;
		const fields = dataFields(block, label);
		const type = fields.get("type");
		if (type === "text") {
			assertOnlyFields(fields, ["type", "text", "textSignature"], label);
			if (typeof fields.get("text") !== "string") {
				invalid(`${label}.text must be a string`);
			}
			optionalStringField(fields, "textSignature", label);
		} else if (type === "thinking") {
			assertOnlyFields(fields, ["type", "thinking", "thinkingSignature", "redacted"], label);
			if (typeof fields.get("thinking") !== "string") {
				invalid(`${label}.thinking must be a string`);
			}
			optionalStringField(fields, "thinkingSignature", label);
			if (fields.has("redacted") && typeof fields.get("redacted") !== "boolean") {
				invalid(`${label}.redacted must be a boolean`);
			}
		} else if (type === "toolCall") {
			assertOnlyFields(fields, ["type", "id", "name", "arguments", "thoughtSignature"], label);
			const toolCallId = boundedCodeUnits(
				requiredString(fields, "id", label),
				MAX_REQUEST_ID_CODE_UNITS,
				`${label}.id`,
			);
			const toolName = boundedCodeUnits(
				requiredString(fields, "name", label),
				MAX_REQUEST_ID_CODE_UNITS,
				`${label}.name`,
			);
			dataFields(fields.get("arguments"), `${label}.arguments`);
			const canonicalArguments = canonicalJson(fields.get("arguments"));
			if (Buffer.byteLength(canonicalArguments, "utf8") > MAX_CANONICAL_PARAMS_BYTES) {
				invalid(`${label}.arguments must not exceed ${MAX_CANONICAL_PARAMS_BYTES} UTF-8 bytes`);
			}
			optionalStringField(fields, "thoughtSignature", label);
			toolCalls.push({ toolCallId, toolName });
		} else {
			invalid(`${label}.type is invalid`);
		}
	}
	return toolCalls;
}

function validateAssistantUsage(value: unknown): void {
	const usage = dataFields(value, "assistant completion evidence usage");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
		finiteNumber(usage, key, "assistant completion evidence usage");
	}
	const cost = dataFields(usage.get("cost"), "assistant completion evidence usage.cost");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		finiteNumber(cost, key, "assistant completion evidence usage.cost");
	}
}

export function validateRuntimeAssistantMessageEvidence(value: unknown): RuntimeAssistantMessageEvidence {
	const message = dataFields(value, "assistant completion evidence");
	if (message.get("role") !== "assistant") invalid("assistant completion evidence.role must be assistant");
	const stopReason = message.get("stopReason");
	if (stopReason !== "stop" && stopReason !== "length" && stopReason !== "error" && stopReason !== "aborted") {
		if (stopReason !== "toolUse") invalid("assistant completion evidence.stopReason is invalid");
	}
	requiredString(message, "api", "assistant completion evidence");
	requiredString(message, "provider", "assistant completion evidence");
	requiredString(message, "model", "assistant completion evidence");
	validateAssistantUsage(message.get("usage"));
	finiteNumber(message, "timestamp", "assistant completion evidence");
	const toolCalls = parseAssistantCompletionContent(message.get("content"));
	const outcome =
		stopReason === "error" || stopReason === "aborted"
			? "interrupted"
			: (stopReason === "stop" || stopReason === "length") && toolCalls.length === 0
				? "completed"
				: undefined;
	return { outcome, toolCalls };
}

function assistantEvidence(fields: ReadonlyMap<string, unknown>): AssistantEvidence | undefined {
	if (fields.get("type") !== "message") return undefined;
	const message = dataFields(fields.get("message"), "session message evidence");
	if (message.get("role") !== "assistant") return undefined;
	const turnId = fields.get("turnId");
	if (typeof turnId !== "string" || turnId.length === 0) return undefined;
	return { turnId, ...validateRuntimeAssistantMessageEvidence(fields.get("message")) };
}

function validateToolResultContent(value: unknown): void {
	for (const [index, block] of dataArray(value, "tool result evidence content").entries()) {
		const fields = dataFields(block, `tool result evidence content[${index}]`);
		const type = fields.get("type");
		if (type === "text") {
			assertOnlyFields(fields, ["type", "text", "textSignature"], `tool result evidence content[${index}]`);
			if (typeof fields.get("text") !== "string")
				invalid(`tool result evidence content[${index}].text must be a string`);
			optionalStringField(fields, "textSignature", `tool result evidence content[${index}]`);
		} else if (type === "image") {
			assertOnlyFields(fields, ["type", "data", "mimeType"], `tool result evidence content[${index}]`);
			if (typeof fields.get("data") !== "string" || typeof fields.get("mimeType") !== "string") {
				invalid(`tool result evidence content[${index}] must contain image data and mimeType`);
			}
		} else if (type === "image_ref") {
			// Historical session image refs did not record size. They remain valid
			// evidence; SessionManager applies the bounded compatibility read budget.
			parseImageRef(block, `tool result evidence content[${index}]`, false);
		} else {
			invalid(`tool result evidence content[${index}].type is invalid`);
		}
	}
}

export interface RuntimeToolResultMessageEvidence {
	readonly toolCallId: string;
	readonly toolName: string;
}

export function validateRuntimeToolResultMessageEvidence(value: unknown): RuntimeToolResultMessageEvidence {
	const message = dataFields(value, "tool result evidence");
	assertOnlyFields(
		message,
		["role", "toolCallId", "toolName", "content", "details", "addedToolNames", "isError", "timestamp"],
		"tool result evidence",
	);
	if (message.get("role") !== "toolResult") invalid("tool result evidence.role must be toolResult");
	const toolCallId = requiredString(message, "toolCallId", "tool result evidence");
	const toolName = requiredString(message, "toolName", "tool result evidence");
	validateToolResultContent(message.get("content"));
	if (typeof message.get("isError") !== "boolean") invalid("tool result evidence.isError must be a boolean");
	if (message.has("addedToolNames")) {
		const names = dataArray(message.get("addedToolNames"), "tool result evidence.addedToolNames");
		if (names.length > 1024) invalid("tool result evidence.addedToolNames must not contain more than 1024 names");
		const unique = new Set<string>();
		for (const [index, value] of names.entries()) {
			if (typeof value !== "string" || value.length === 0) {
				invalid(`tool result evidence.addedToolNames[${index}] must be a non-empty string`);
			}
			const name = boundedCodeUnits(value, 256, `tool result evidence.addedToolNames[${index}]`);
			if (unique.has(name)) invalid("tool result evidence.addedToolNames must contain unique names");
			unique.add(name);
		}
	}
	finiteNumber(message, "timestamp", "tool result evidence");
	return { toolCallId, toolName };
}

function toolResultEvidence(
	fields: ReadonlyMap<string, unknown>,
): { turnId: string; toolCallId: string; toolName: string } | undefined {
	if (fields.get("type") !== "message") return undefined;
	const message = dataFields(fields.get("message"), "session message evidence");
	if (message.get("role") !== "toolResult") return undefined;
	const turnId = fields.get("turnId");
	if (typeof turnId !== "string" || turnId.length === 0) return undefined;
	return { turnId, ...validateRuntimeToolResultMessageEvidence(fields.get("message")) };
}

function userMessageTurnEvidence(fields: ReadonlyMap<string, unknown>): string | undefined {
	if (fields.get("type") !== "message") return undefined;
	const message = dataFields(fields.get("message"), "session message evidence");
	if (message.get("role") !== "user") return undefined;
	const turnId = fields.get("turnId");
	return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}

export function reduceRuntimeJournal(entries: readonly unknown[]): RuntimeRecoveryResult {
	const operations = new Map<string, OperationAccumulator>();
	const requestHashes = new Map<string, string>();
	const queues = new Map<string, QueueAccumulator>();
	const turns = new Map<string, TurnAccumulator>();
	const tools = new Map<string, ToolAccumulator>();
	const toolsByTurn = new Map<string, ToolAccumulator[]>();
	const toolCalls = new Map<string, ToolCallAccumulator>();
	const activeToolsByCallId = new Map<string, ToolAccumulator>();

	for (const rawEntry of entries) {
		const fields = dataFields(rawEntry, "session journal entry");
		const type = fields.get("type");
		if (type === "runtime_operation") {
			const entry = parseOperation(rawEntry);
			const knownHash = requestHashes.get(entry.requestId);
			if (knownHash && knownHash !== entry.requestHash) throw new RequestIdReusedError(entry.requestId);
			requestHashes.set(entry.requestId, entry.requestHash);

			let operation = operations.get(entry.operationId);
			if (!operation) {
				if (entry.state !== "accepted")
					invalid(`Runtime operation ${entry.operationId} is terminal before acceptance`);
				operation = {
					operationId: entry.operationId,
					requestId: entry.requestId,
					requestHash: entry.requestHash,
					kind: entry.kind,
					state: entry.state,
					...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
					...(entry.input === undefined ? {} : { input: entry.input }),
					...(entry.error === undefined ? {} : { error: entry.error }),
				};
				operations.set(entry.operationId, operation);
			} else {
				mergeOperation(operation, entry);
			}
			continue;
		}

		if (type === "runtime_queue") {
			const entry = parseQueue(rawEntry);
			const current = queues.get(entry.queueItemId);
			if (!current) {
				const canStartQueuedTurn = entry.queue === "next_turn" && entry.state === "paused";
				if ((entry.state !== "enqueued" && !canStartQueuedTurn) || !entry.input) {
					invalid(`Runtime queue item ${entry.queueItemId} changed state before enqueue`);
				}
				if (entry.queue === "next_turn" && entry.enqueueHash !== hashRuntimeRequest("turn/queue", entry.input)) {
					invalid(`Queued turn ${entry.queueItemId} enqueueHash does not match its initial input`);
				}
				queues.set(entry.queueItemId, {
					operationId: entry.operationId,
					queueItemId: entry.queueItemId,
					queue: entry.queue,
					input: entry.input,
					journalState: entry.state,
					revision: entry.id,
					...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
					...(entry.enqueueHash === undefined ? {} : { enqueueHash: entry.enqueueHash }),
					...(entry.deliveryRequestId === undefined ? {} : { deliveryRequestId: entry.deliveryRequestId }),
				});
			} else {
				mergeQueue(current, entry);
			}
			continue;
		}

		if (type === "runtime_turn") {
			const entry = parseTurn(rawEntry);
			let turn = turns.get(entry.turnId);
			if (!turn) {
				if (entry.state !== "started") invalid(`Runtime turn ${entry.turnId} is terminal before start`);
				turn = {
					turnId: entry.turnId,
					operationIds: entry.operationIds,
					state: entry.state,
					consumedQueueItemIds: entry.consumedQueueItemIds,
					initialOperationIds: entry.operationIds,
					initialConsumedQueueItemIds: entry.consumedQueueItemIds,
					pendingToolCallKeys: new Set(),
				};
				turns.set(entry.turnId, turn);
			} else {
				if (entry.state === "started") {
					if (turn.pendingToolCallKeys.size > 0) {
						invalid(`Runtime turn ${entry.turnId} started a provider epoch with unresolved tool calls`);
					}
					if (toolsByTurn.get(entry.turnId)?.some((tool) => tool.state === "started")) {
						invalid(`Runtime turn ${entry.turnId} started a provider epoch with an active tool`);
					}
				} else {
					if (turn.pendingToolCallKeys.size > 0) {
						invalid(`Runtime turn ${entry.turnId} became terminal with unresolved tool calls`);
					}
					if (toolsByTurn.get(entry.turnId)?.some((tool) => tool.state === "started")) {
						invalid(`Runtime turn ${entry.turnId} became terminal with an active tool`);
					}
				}
				mergeTurn(turn, entry);
			}
			continue;
		}

		if (type === "runtime_tool") {
			const entry = parseTool(rawEntry);
			const key = `${entry.turnId}\0${entry.toolCallId}`;
			const turn = turns.get(entry.turnId);
			if (!turn || turn.state !== "started") {
				invalid(`Runtime tool ${entry.toolCallId} must be recorded inside an active turn`);
			}
			const call = toolCalls.get(key);
			if (!call) invalid(`Runtime tool ${entry.toolCallId} started before its assistant tool-call evidence`);
			if (call.toolName !== entry.toolName) invalid(`Conflicting tool names for ${entry.toolCallId}`);
			let tool = tools.get(key);
			if (!tool) {
				if (entry.state !== "started") invalid(`Runtime tool ${entry.toolCallId} is terminal before start`);
				if (call.resultEvidence || !turn.pendingToolCallKeys.has(key)) {
					invalid(`Runtime tool ${entry.toolCallId} started after its tool result`);
				}
				const otherActive = activeToolsByCallId.get(entry.toolCallId);
				if (otherActive) invalid(`Tool call ID ${entry.toolCallId} is active in more than one turn`);
				tool = {
					turnId: entry.turnId,
					toolCallId: entry.toolCallId,
					toolName: entry.toolName,
					state: entry.state,
				};
				tools.set(key, tool);
				const turnTools = toolsByTurn.get(entry.turnId) ?? [];
				turnTools.push(tool);
				toolsByTurn.set(entry.turnId, turnTools);
				activeToolsByCallId.set(entry.toolCallId, tool);
			} else {
				if (entry.state === "completed" && !call.resultEvidence) {
					invalid(`Runtime tool ${entry.toolCallId} completed before its durable result`);
				}
				if (entry.state === "interrupted" && call.resultEvidence) {
					invalid(`Runtime tool ${entry.toolCallId} was interrupted after its durable result`);
				}
				mergeTool(tool, entry);
				if (tool.state !== "started" && activeToolsByCallId.get(entry.toolCallId) === tool) {
					activeToolsByCallId.delete(entry.toolCallId);
				}
			}
			continue;
		}
		if (typeof type === "string" && type.startsWith("runtime_")) {
			invalid(`Unknown runtime journal entry type: ${type}`);
		}

		const userTurnId = userMessageTurnEvidence(fields);
		if (userTurnId) {
			const turn = turns.get(userTurnId);
			if (!turn || turn.state !== "started") {
				invalid(`User evidence for ${userTurnId} must belong to an active runtime turn`);
			}
			if (turn.pendingToolCallKeys.size > 0) {
				invalid(`Runtime turn ${userTurnId} advanced with unresolved tool calls`);
			}
			if (toolsByTurn.get(userTurnId)?.some((tool) => tool.state === "started")) {
				invalid(`Runtime turn ${userTurnId} advanced with an active tool`);
			}
			turn.terminalEvidence = undefined;
		}
		const assistant = assistantEvidence(fields);
		if (assistant) {
			const turn = turns.get(assistant.turnId);
			if (!turn || turn.state !== "started") {
				invalid(`Assistant evidence for ${assistant.turnId} must belong to an active runtime turn`);
			}
			for (const key of turn.pendingToolCallKeys) {
				if (tools.get(key)?.state === "started") {
					invalid(`Runtime turn ${assistant.turnId} advanced with an unresolved started tool`);
				}
			}
			turn.pendingToolCallKeys.clear();
			turn.terminalEvidence = assistant.outcome;
			for (const call of assistant.toolCalls) {
				const key = `${assistant.turnId}\0${call.toolCallId}`;
				const current = toolCalls.get(key);
				if (current) {
					if (current.toolName !== call.toolName) {
						invalid(`Tool call ${call.toolCallId} has conflicting names in one runtime turn`);
					}
					invalid(`Tool call ID ${call.toolCallId} is duplicated in one runtime turn`);
				}
				toolCalls.set(key, {
					turnId: assistant.turnId,
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					resultEvidence: false,
				});
				turn.pendingToolCallKeys.add(key);
			}
		}
		const result = toolResultEvidence(fields);
		if (result) {
			const turn = turns.get(result.turnId);
			if (!turn || turn.state !== "started") {
				invalid(`Tool result ${result.toolCallId} must belong to an active runtime turn`);
			}
			const key = `${result.turnId}\0${result.toolCallId}`;
			const call = toolCalls.get(key);
			if (!call) invalid(`Tool result ${result.toolCallId} has no assistant tool-call evidence`);
			if (call.toolName !== result.toolName) {
				invalid(`Tool result ${result.toolCallId} has a conflicting tool name`);
			}
			if (call.resultEvidence || !turn.pendingToolCallKeys.has(key)) {
				invalid(`Tool result ${result.toolCallId} is duplicated or arrived after the turn advanced`);
			}
			call.resultEvidence = true;
			turn.pendingToolCallKeys.delete(key);
		}
	}

	const claimedQueues = new Map<string, TurnAccumulator>();
	const operationTurns = new Map<string, TurnAccumulator>();
	for (const turn of turns.values()) {
		for (const operationId of turn.operationIds) {
			const operation = operations.get(operationId);
			if (!operation) invalid(`Runtime turn ${turn.turnId} references unknown operation ${operationId}`);
			const knownTurn = operationTurns.get(operationId);
			if (knownTurn && knownTurn !== turn) invalid(`Operation ${operationId} belongs to two runtime turns`);
			if (operation.turnId && operation.turnId !== turn.turnId) {
				invalid(`Operation ${operationId} has a conflicting turn ID`);
			}
			operationTurns.set(operationId, turn);
		}
		const consumedOperationIds = turn.consumedQueueItemIds.map((queueItemId) => {
			const queue = queues.get(queueItemId);
			if (!queue) invalid(`Runtime turn ${turn.turnId} consumed unknown queue item ${queueItemId}`);
			const knownTurn = claimedQueues.get(queueItemId);
			if (knownTurn && knownTurn !== turn) invalid(`Queue item ${queueItemId} was consumed by two runtime turns`);
			claimedQueues.set(queueItemId, turn);
			return queue.operationId;
		});

		if (turn.initialConsumedQueueItemIds.length === 0) {
			const initialOperation = operations.get(turn.initialOperationIds[0] ?? "");
			if (turn.initialOperationIds.length !== 1 || initialOperation?.kind !== "turn") {
				invalid(`Direct runtime turn ${turn.turnId} must name one turn operation`);
			}
			if (turn.turnId !== deriveId("turn", initialOperation.requestId)) {
				invalid(`Direct runtime turn ${turn.turnId} is not derived from requestId`);
			}
			if (!sameJson(turn.operationIds, [initialOperation.operationId, ...consumedOperationIds])) {
				invalid(`Direct runtime turn ${turn.turnId} operation IDs do not match its consumed queue items`);
			}
		} else {
			if (turn.turnId !== deriveBatchedTurnId(turn.initialConsumedQueueItemIds)) {
				invalid(`Batched runtime turn ${turn.turnId} is not derived from its initial consumed queue item IDs`);
			}
			if (
				!sameJson(turn.initialOperationIds, consumedOperationIds.slice(0, turn.initialConsumedQueueItemIds.length))
			) {
				invalid(`Batched runtime turn ${turn.turnId} initial operation IDs do not match its queue items`);
			}
			if (sameJson(turn.operationIds, consumedOperationIds)) continue;
			invalid(`Runtime turn ${turn.turnId} operation IDs do not match its consumed queue items`);
		}
	}

	for (const queue of queues.values()) {
		const operation = operations.get(queue.operationId);
		if (queue.queue === "next_turn") {
			const claimedTurn = claimedQueues.get(queue.queueItemId);
			if (claimedTurn && !operation) {
				invalid(`Queued turn ${queue.queueItemId} was consumed without a runtime operation`);
			}
			if (!operation) continue;
			if (operation.kind !== "steer" && operation.kind !== "next_turn") {
				invalid(`Queued turn ${queue.queueItemId} references a non-delivery operation`);
			}
			if (!operation.input || !sameJson(operation.input, queue.input)) {
				invalid(`Queued turn ${queue.queueItemId} input does not match its operation`);
			}
			if (operation.requestId !== (queue.deliveryRequestId ?? queue.requestId)) {
				invalid(`Queued turn ${queue.queueItemId} operation requestId does not match`);
			}
			continue;
		}
		if (!operation) invalid(`Queue item ${queue.queueItemId} references unknown operation ${queue.operationId}`);
		if (operation.kind !== "steer") invalid(`Queue item ${queue.queueItemId} references a non-queued operation`);
		if (!operation.input || !sameJson(operation.input, queue.input)) {
			invalid(`Queue item ${queue.queueItemId} input does not match its operation`);
		}
		if (queue.queueItemId !== deriveId("queue", operation.requestId)) {
			invalid(`Queue item ${queue.queueItemId} is not derived from its operation requestId`);
		}
	}
	for (const tool of tools.values()) {
		if (!turns.has(tool.turnId)) invalid(`Tool ${tool.toolCallId} references unknown runtime turn ${tool.turnId}`);
		const call = toolCalls.get(`${tool.turnId}\0${tool.toolCallId}`);
		if (!call) invalid(`Tool ${tool.toolCallId} is missing assistant tool-call evidence`);
		if (tool.state === "completed" && !call.resultEvidence) {
			invalid(`Completed tool ${tool.toolCallId} is missing its durable result`);
		}
	}
	const turnToolsAreResolved = (turn: TurnAccumulator): boolean =>
		turn.pendingToolCallKeys.size === 0 &&
		(toolsByTurn.get(turn.turnId) ?? []).every((tool) => {
			const call = toolCalls.get(`${tool.turnId}\0${tool.toolCallId}`);
			return tool.state !== "interrupted" && call?.resultEvidence === true;
		});
	const turnOperationsAllowCompletion = (turn: TurnAccumulator): boolean =>
		turn.operationIds.every((operationId) => operations.get(operationId)?.state !== "interrupted");
	const turnCanComplete = (turn: TurnAccumulator): boolean =>
		turn.terminalEvidence === "completed" && turnToolsAreResolved(turn) && turnOperationsAllowCompletion(turn);
	const turnIsProvablyCompleted = (turn: TurnAccumulator): boolean =>
		turn.state !== "interrupted" && turnCanComplete(turn);
	for (const turn of turns.values()) {
		if (turn.state === "completed") {
			if (turn.terminalEvidence === "interrupted") {
				invalid(`Completed runtime turn ${turn.turnId} has interrupted assistant evidence`);
			}
			if (turn.terminalEvidence !== "completed") {
				invalid(`Completed runtime turn ${turn.turnId} has no completed terminal evidence`);
			}
			if (!turnToolsAreResolved(turn)) {
				invalid(`Completed runtime turn ${turn.turnId} has an unresolved or interrupted tool`);
			}
			const interruptedOperationId = turn.operationIds.find(
				(operationId) => operations.get(operationId)?.state === "interrupted",
			);
			if (interruptedOperationId) {
				invalid(`Interrupted prompt operation ${interruptedOperationId} belongs to a completed turn`);
			}
		}
		if (turn.state === "interrupted" && turnCanComplete(turn)) {
			invalid(`Interrupted runtime turn ${turn.turnId} has completed terminal evidence`);
		}
	}
	for (const operation of operations.values()) {
		if (operation.kind !== "turn" && operation.kind !== "steer" && operation.kind !== "next_turn") continue;
		const turn = operationTurns.get(operation.operationId);
		if (operation.state === "completed" && (!turn || !turnIsProvablyCompleted(turn))) {
			invalid(`Completed prompt operation ${operation.operationId} has no provably completed turn`);
		}
		if (operation.state === "interrupted" && turn && turnIsProvablyCompleted(turn)) {
			invalid(`Interrupted prompt operation ${operation.operationId} belongs to a completed turn`);
		}
	}

	const reducedQueues: ReducedRuntimeQueueItem[] = [];
	for (const queue of queues.values()) {
		const claimedTurn = claimedQueues.get(queue.queueItemId);
		if (claimedTurn && queue.journalState === "cancelled")
			invalid(`Cancelled queue item ${queue.queueItemId} was consumed`);
		const state =
			queue.queue === "next_turn"
				? claimedTurn
					? "consumed"
					: queue.journalState
				: queue.journalState === "cancelled"
					? "cancelled"
					: claimedTurn
						? "consumed"
						: "enqueued";
		reducedQueues.push({
			operationId: queue.operationId,
			queueItemId: queue.queueItemId,
			queue: queue.queue,
			state,
			input: queue.input,
			revision: queue.revision,
			...(queue.requestId === undefined ? {} : { requestId: queue.requestId }),
			...(queue.enqueueHash === undefined ? {} : { enqueueHash: queue.enqueueHash }),
			...(queue.deliveryRequestId === undefined ? {} : { deliveryRequestId: queue.deliveryRequestId }),
			...(claimedTurn === undefined ? {} : { turnId: claimedTurn.turnId }),
			...(queue.reason === undefined ? {} : { reason: queue.reason }),
		});
	}
	const reducedTurns: ReducedRuntimeTurn[] = [...turns.values()].map((turn) => ({
		turnId: turn.turnId,
		operationIds: turn.operationIds,
		state: turn.state === "started" ? "active" : turn.state,
		consumedQueueItemIds: turn.consumedQueueItemIds,
	}));
	const reducedTools: ReducedRuntimeTool[] = [...tools.values()].map((tool) => ({
		turnId: tool.turnId,
		toolCallId: tool.toolCallId,
		toolName: tool.toolName,
		state: tool.state === "started" ? "active" : tool.state,
	}));
	const reducedOperations: ReducedRuntimeOperation[] = [...operations.values()].map((operation) => {
		const turnId = operationTurns.get(operation.operationId)?.turnId ?? operation.turnId;
		return {
			operationId: operation.operationId,
			requestId: operation.requestId,
			requestHash: operation.requestHash,
			kind: operation.kind,
			state: operation.state === "accepted" ? "active" : operation.state,
			...(turnId === undefined ? {} : { turnId }),
			...(operation.input === undefined ? {} : { input: operation.input }),
			...(operation.error === undefined ? {} : { error: operation.error }),
		};
	});

	const decisions: RuntimeRecoveryDecision[] = [];
	for (const tool of tools.values()) {
		const call = toolCalls.get(`${tool.turnId}\0${tool.toolCallId}`);
		if (!call) invalid(`Tool ${tool.toolCallId} is missing assistant tool-call evidence`);
		if (tool.state === "started") {
			decisions.push(
				call.resultEvidence
					? {
							type: "complete_tool",
							turnId: tool.turnId,
							toolCallId: tool.toolCallId,
							toolName: tool.toolName,
						}
					: {
							type: "interrupt_tool",
							turnId: tool.turnId,
							toolCallId: tool.toolCallId,
							toolName: tool.toolName,
							reason: "server_restarted",
							needsSyntheticResult: true,
						},
			);
		} else if (tool.state === "interrupted" && !call.resultEvidence) {
			decisions.push({
				type: "synthesize_tool_result",
				turnId: tool.turnId,
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				reason: "server_restarted",
			});
		}
	}
	for (const turn of turns.values()) {
		for (const key of turn.pendingToolCallKeys) {
			if (tools.has(key)) continue;
			const call = toolCalls.get(key);
			if (!call) invalid(`Runtime turn ${turn.turnId} has unknown pending tool-call evidence`);
			decisions.push({
				type: "synthesize_tool_result",
				turnId: call.turnId,
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				reason: "server_restarted",
			});
		}
	}
	for (const turn of turns.values()) {
		if (turn.state !== "started") continue;
		decisions.push(
			turnCanComplete(turn)
				? { type: "complete_turn", turnId: turn.turnId }
				: { type: "interrupt_turn", turnId: turn.turnId, reason: "server_restarted" },
		);
	}
	for (const operation of operations.values()) {
		if (operation.state !== "accepted" || appServerOperationKinds.has(operation.kind)) continue;
		const turn = operationTurns.get(operation.operationId);
		const turnId = turn?.turnId ?? operation.turnId;
		const completed = turn !== undefined && turnIsProvablyCompleted(turn);
		decisions.push(
			completed
				? {
						type: "complete_operation",
						operationId: operation.operationId,
						...(turnId === undefined ? {} : { turnId }),
					}
				: {
						type: "interrupt_operation",
						operationId: operation.operationId,
						...(turnId === undefined ? {} : { turnId }),
						reason: "server_restarted",
					},
		);
	}
	for (const queue of reducedQueues) {
		if (queue.state !== "enqueued" && queue.state !== "dispatching") continue;
		if (queue.queue === "next_turn") {
			decisions.push({
				type: "pause_queue",
				queueItemId: queue.queueItemId,
				reason: "server_restarted",
			});
			continue;
		}
		decisions.push({
			type: "cancel_queue",
			queueItemId: queue.queueItemId,
			reason: "server_restarted",
			draft: queue.input,
		});
	}

	return { operations: reducedOperations, queues: reducedQueues, turns: reducedTurns, tools: reducedTools, decisions };
}
