import { isAbsolute } from "node:path";
import { assertWellFormedAction, canonicalJson } from "./normalize.ts";
import type { PermissionReviewRequest, TrustedUserMessage } from "./reviewer.ts";
import type { GrantRequest, NetworkEndpoint, NormalizedPermissionAction, RiskLevel } from "./types.ts";

const MAX_REVIEW_INPUT_BYTES = 48 * 1024;
const MAX_REDACTED_ARGUMENT_BYTES = 16 * 1024;
const MAX_TRUSTED_MESSAGES = 20;
const MAX_COLLECTION_ITEMS = 256;
const MAX_DEPTH = 20;
const MAX_DISPLAY_STRING_BYTES = 4 * 1024;
const SECRET_KEY_PATTERN =
	/(?:authorization|cookie|credential|password|privatekey|secret|session|token|(?:api|access|auth)?key)/i;

export interface ModelReviewInput {
	readonly schemaVersion: 2;
	readonly action: NormalizedPermissionAction;
	readonly policy: {
		readonly riskLevel: RiskLevel;
		readonly minimumReviewer: "model" | "user";
		readonly reason: string;
		readonly grant: GrantRequest;
	};
	readonly trustedUserMessages: readonly TrustedUserMessage[];
	readonly redactedArguments: unknown;
}

function normalizedKey(key: string): string {
	return key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
}

function binaryMetadata(value: string, key: string): Readonly<Record<string, unknown>> | undefined {
	const dataUrl = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/isu.exec(value);
	if (dataUrl) {
		return Object.freeze({
			kind: "binary",
			mediaType: dataUrl[1] || "application/octet-stream",
			encodedBytes: Buffer.byteLength(dataUrl[2] ?? "", "utf8"),
		});
	}
	if (
		/(?:base64|binary|blob|bytes|data|image)/i.test(normalizedKey(key)) &&
		value.length > 1024 &&
		/^[a-z0-9+/=\r\n]+$/iu.test(value)
	) {
		return Object.freeze({ kind: "binary", encodedBytes: Buffer.byteLength(value, "utf8") });
	}
	return undefined;
}

function truncateUtf8(value: string, maximum: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximum) return value;
	const truncated = Buffer.from(value)
		.subarray(0, maximum - 3)
		.toString("utf8")
		.replace(/�$/u, "");
	return `${truncated}…`;
}

function redactValue(value: unknown, ancestors: Set<object>, depth: number, key = ""): unknown {
	if (SECRET_KEY_PATTERN.test(normalizedKey(key))) return "<redacted>";
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Reviewer arguments contain a non-finite number");
		return value;
	}
	if (typeof value === "string") {
		const binary = binaryMetadata(value, key);
		if (binary) return binary;
		return truncateUtf8(value, MAX_DISPLAY_STRING_BYTES);
	}
	if (typeof value !== "object") throw new TypeError(`Reviewer arguments contain unsupported ${typeof value}`);
	if (depth >= MAX_DEPTH) throw new TypeError("Reviewer arguments exceed the maximum depth");
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
		return Object.freeze({ kind: "binary", bytes: value.byteLength });
	}
	if (ancestors.has(value)) throw new TypeError("Reviewer arguments contain a cycle");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_COLLECTION_ITEMS) throw new TypeError("Reviewer arguments contain too many items");
			for (const property of Reflect.ownKeys(value)) {
				if (typeof property === "symbol" || (property !== "length" && !/^(0|[1-9]\d*)$/.test(property))) {
					throw new TypeError("Reviewer arguments contain invalid array properties");
				}
			}
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new TypeError("Reviewer arguments contain a sparse or accessor array");
				}
				result.push(redactValue(descriptor.value, ancestors, depth + 1));
			}
			return Object.freeze(result);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Reviewer arguments must contain only plain objects");
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.length > MAX_COLLECTION_ITEMS || keys.some((entry) => typeof entry === "symbol")) {
			throw new TypeError("Reviewer arguments contain invalid object keys");
		}
		const result: Record<string, unknown> = Object.create(null);
		for (const entry of (keys as string[]).sort()) {
			const descriptor = descriptors[entry];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new TypeError("Reviewer arguments contain an accessor or hidden property");
			}
			result[entry] = redactValue(descriptor.value, ancestors, depth + 1, entry);
		}
		return Object.freeze(result);
	} finally {
		ancestors.delete(value);
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameEndpoints(left: readonly NetworkEndpoint[], right: readonly NetworkEndpoint[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(endpoint, index) => endpoint.hostname === right[index]?.hostname && endpoint.port === right[index]?.port,
		)
	);
}

function isNormalizedPathSet(paths: readonly string[]): boolean {
	return (
		paths.length <= 4_096 &&
		paths.every(
			(path, index) =>
				typeof path === "string" &&
				isAbsolute(path) &&
				!path.includes("\0") &&
				(index === 0 || (paths[index - 1] ?? "") < path),
		)
	);
}

function freezeGrant(action: NormalizedPermissionAction, grant: GrantRequest): GrantRequest {
	if (
		!grant ||
		Object.keys(grant).sort().join(",") !==
			"executionTarget,networkEndpoints,protectedRoots,readRoots,writeRoots".split(",").sort().join(",") ||
		!(["sandbox", "host", "external"] as const).includes(grant.executionTarget) ||
		!Array.isArray(grant.readRoots) ||
		!Array.isArray(grant.writeRoots) ||
		!Array.isArray(grant.protectedRoots) ||
		!Array.isArray(grant.networkEndpoints) ||
		!isNormalizedPathSet(grant.protectedRoots) ||
		!sameStrings(action.readPaths, grant.readRoots) ||
		!sameStrings(action.writePaths, grant.writeRoots) ||
		!sameEndpoints(action.networkEndpoints, grant.networkEndpoints)
	) {
		throw new TypeError("Permission review grant does not match the normalized action");
	}
	return Object.freeze({
		executionTarget: grant.executionTarget,
		readRoots: Object.freeze([...grant.readRoots]),
		writeRoots: Object.freeze([...grant.writeRoots]),
		protectedRoots: Object.freeze([...grant.protectedRoots]),
		networkEndpoints: Object.freeze(
			grant.networkEndpoints.map((endpoint) => Object.freeze({ hostname: endpoint.hostname, port: endpoint.port })),
		),
	});
}

function trustedMessages(messages: readonly TrustedUserMessage[]): readonly TrustedUserMessage[] {
	if (!Array.isArray(messages)) throw new TypeError("trustedUserMessages must be an array");
	const recent = Array.prototype.slice.call(messages, -MAX_TRUSTED_MESSAGES) as TrustedUserMessage[];
	const seen = new Set<string>();
	const normalized: TrustedUserMessage[] = [];
	for (const message of recent.reverse()) {
		if (!message || typeof message !== "object") {
			throw new TypeError("Trusted user message is invalid");
		}
		const prototype = Object.getPrototypeOf(message);
		const descriptors = Object.getOwnPropertyDescriptors(message);
		if (
			(prototype !== Object.prototype && prototype !== null) ||
			Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol") ||
			Object.keys(descriptors).sort().join(",") !== "messageId,text" ||
			Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)
		) {
			throw new TypeError("Trusted user message is invalid");
		}
		const messageIdValue = descriptors.messageId?.value;
		const textValue = descriptors.text?.value;
		if (typeof messageIdValue !== "string" || typeof textValue !== "string") {
			throw new TypeError("Trusted user message is invalid");
		}
		const messageId = messageIdValue.trim();
		const text = textValue.trim();
		if (!messageId || messageId.length > 256 || !text || messageId.includes("\0") || text.includes("\0")) {
			throw new TypeError("Trusted user message is invalid");
		}
		if (!seen.has(messageId)) {
			seen.add(messageId);
			normalized.push(Object.freeze({ messageId, text }));
		}
	}
	return Object.freeze(normalized.reverse());
}

export function buildModelReviewInput(request: PermissionReviewRequest): ModelReviewInput {
	assertWellFormedAction(request.action);
	const grant = freezeGrant(request.action, request.decision.grant);
	const redactedArguments = redactPermissionArguments(request.redactedArguments);
	const input: ModelReviewInput = Object.freeze({
		schemaVersion: 2,
		action: request.action,
		policy: Object.freeze({
			riskLevel: request.decision.riskLevel,
			minimumReviewer: request.decision.minimumReviewer,
			reason: request.decision.reason,
			grant,
		}),
		trustedUserMessages: trustedMessages(request.trustedUserMessages),
		redactedArguments,
	});
	if (Buffer.byteLength(canonicalJson(input), "utf8") > MAX_REVIEW_INPUT_BYTES) {
		throw new TypeError("Permission reviewer input exceeds 48 KiB");
	}
	return input;
}

export function redactPermissionArguments(value: unknown): unknown {
	const redactedArguments = redactValue(value, new Set(), 0);
	if (Buffer.byteLength(canonicalJson(redactedArguments), "utf8") > MAX_REDACTED_ARGUMENT_BYTES) {
		throw new TypeError("Redacted reviewer arguments exceed 16 KiB");
	}
	return redactedArguments;
}
