import { type TObjectOptions, type TProperties, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";

export type EmptySchemaContext = Record<string, never>;

export const PROTOCOL_VERSION = 3 as const;
export const MAX_ENVELOPE_UTF8_BYTES = 8 * 1024 * 1024;
export const MAX_NAME_UTF16_UNITS = 256;
export const MAX_PATH_UTF8_BYTES = 32 * 1024;
export const MAX_PROMPT_UTF8_BYTES = 2 * 1024 * 1024;
export const MAX_PUBLIC_TEXT_UTF8_BYTES = 64 * 1024;
export const MAX_DELTA_UTF8_BYTES = 256 * 1024;
export const MAX_HISTORY_ITEMS = 200;
export const MAX_EVENT_BATCH = 256;
export const MAX_INTERACTION_CHOICES = 100;
export const MAX_CAPABILITIES = 128;
export const MAX_SAFE_JSON_DEPTH = 64;
export const MAX_SAFE_JSON_NODES = 100_000;
export const MAX_SAFE_JSON_PROPERTIES = 200_000;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class ProtocolValidationError extends Error {
	readonly kind: "parse" | "invalid_request" | "method_not_found" | "invalid_params" | "invalid_response";

	constructor(kind: ProtocolValidationError["kind"], message: string) {
		super(message);
		this.name = "ProtocolValidationError";
		this.kind = kind;
	}
}

export function StrictObject<const Properties extends TProperties>(
	properties: Properties,
	options: TObjectOptions = {},
) {
	return Type.Object(properties, { ...options, additionalProperties: false });
}

/** Counts UTF-8 bytes without allocating the encoded string and stops at the limit. */
export function hasAtMostUtf8Bytes(value: string, maximum: number): boolean {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x7f) {
			bytes += 1;
		} else if (unit <= 0x7ff) {
			bytes += 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
		if (bytes > maximum) return false;
	}
	return true;
}

export function Utf8String(maximum: number, options: Record<string, unknown> = {}) {
	return Type.Refine(
		Type.String({ ...options, "x-arcmind-maxUtf8Bytes": maximum }),
		(value) => hasAtMostUtf8Bytes(value, maximum),
		`must not exceed ${maximum} UTF-8 bytes`,
	);
}

export const NameSchema = Type.Refine(
	Type.String({ minLength: 1, maxLength: MAX_NAME_UTF16_UNITS, "x-arcmind-maxUtf16Units": MAX_NAME_UTF16_UNITS }),
	(value) => value.length <= MAX_NAME_UTF16_UNITS,
	`must not exceed ${MAX_NAME_UTF16_UNITS} UTF-16 code units`,
);
export const OptionalNameSchema = Type.Refine(
	Type.String({ maxLength: MAX_NAME_UTF16_UNITS, "x-arcmind-maxUtf16Units": MAX_NAME_UTF16_UNITS }),
	(value) => value.length <= MAX_NAME_UTF16_UNITS,
	`must not exceed ${MAX_NAME_UTF16_UNITS} UTF-16 code units`,
);
export const PathSchema = Utf8String(MAX_PATH_UTF8_BYTES, { minLength: 1 });
export const PromptTextSchema = Utf8String(MAX_PROMPT_UTF8_BYTES);
export const PublicTextSchema = Utf8String(MAX_PUBLIC_TEXT_UTF8_BYTES);
export const DeltaTextSchema = Utf8String(MAX_DELTA_UTF8_BYTES);
export const CapabilitySchema = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
export const UuidSchema = Type.String({ format: "uuid" });
// Matches coding-agent's persisted/custom session-id contract. The 8 MiB
// envelope limit provides the outer bound without rejecting existing IDs.
export const SessionIdSchema = Type.String({
	minLength: 1,
	pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
});
export const OpaqueIdSchema = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});
export const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const CursorSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const TimestampSchema = Type.String({ format: "date-time", maxLength: 40 });

function failUnsafeJson(message: string): never {
	throw new ProtocolValidationError("invalid_request", message);
}

function jsonStringUtf8ByteLength(value: string, maximum: number): number {
	let bytes = 2; // surrounding quotes
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (
			unit === 0x22 ||
			unit === 0x5c ||
			unit === 0x08 ||
			unit === 0x0c ||
			unit === 0x0a ||
			unit === 0x0d ||
			unit === 0x09
		) {
			bytes += 2;
		} else if (unit < 0x20) {
			bytes += 6;
		} else if (unit <= 0x7f) {
			bytes += 1;
		} else if (unit <= 0x7ff) {
			bytes += 2;
		} else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				// Well-formed JSON.stringify escapes lone surrogates as \udxxx.
				bytes += 6;
			}
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			bytes += 6;
		} else {
			bytes += 3;
		}
		if (bytes > maximum) return bytes;
	}
	return bytes;
}

/**
 * Validate structured-clone ingress before any schema check or JSON.stringify.
 * This intentionally rejects object aliases as well as cycles so serialization
 * cannot expand a compact graph into an unexpectedly large JSON tree.
 * Callers pass values produced by JSON.parse or a structured-clone transport;
 * proxies cannot cross either boundary and are not detected portably here.
 */
export function assertSafeJsonTree(value: unknown): void {
	const seen = new WeakSet<object>();
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	let properties = 0;
	let serializedBytes = 0;
	const addSerializedBytes = (count: number) => {
		serializedBytes += count;
		if (serializedBytes > MAX_ENVELOPE_UTF8_BYTES) {
			failUnsafeJson("Protocol envelope exceeds the 8 MiB limit");
		}
	};

	while (pending.length > 0) {
		const current = pending.pop()!;
		nodes += 1;
		if (nodes > MAX_SAFE_JSON_NODES) failUnsafeJson("Protocol value exceeds the JSON node limit");
		if (current.depth > MAX_SAFE_JSON_DEPTH) failUnsafeJson("Protocol value exceeds the JSON depth limit");

		const item = current.value;
		if (item === null) {
			addSerializedBytes(4);
			continue;
		}
		if (typeof item === "boolean") {
			addSerializedBytes(item ? 4 : 5);
			continue;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item)) failUnsafeJson("Protocol numbers must be finite");
			addSerializedBytes(String(item).length);
			continue;
		}
		if (typeof item === "string") {
			addSerializedBytes(jsonStringUtf8ByteLength(item, MAX_ENVELOPE_UTF8_BYTES - serializedBytes));
			continue;
		}
		if (typeof item !== "object") failUnsafeJson("Protocol values must be JSON-compatible");
		if (seen.has(item)) failUnsafeJson("Protocol values cannot contain cycles or repeated object references");
		seen.add(item);

		if (Array.isArray(item)) {
			if (Object.getPrototypeOf(item) !== Array.prototype) {
				failUnsafeJson("Protocol arrays must have the built-in array prototype");
			}
			const keys = Reflect.ownKeys(item);
			addSerializedBytes(2 + Math.max(0, item.length - 1));
			properties += item.length;
			if (properties > MAX_SAFE_JSON_PROPERTIES) failUnsafeJson("Protocol value exceeds the property limit");
			for (let index = 0; index < item.length; index += 1) {
				if (!Object.hasOwn(item, index)) failUnsafeJson("Protocol arrays cannot be sparse");
			}
			for (const key of keys) {
				if (typeof key === "symbol") failUnsafeJson("Protocol values cannot contain symbol keys");
				if (key === "length") continue;
				if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length) {
					failUnsafeJson("Protocol arrays cannot contain custom properties");
				}
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					failUnsafeJson("Protocol values must use enumerable data properties");
				}
				pending.push({ value: descriptor.value, depth: current.depth + 1 });
			}
			continue;
		}

		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== null) {
			failUnsafeJson("Protocol objects must have a plain or null prototype");
		}
		const keys = Reflect.ownKeys(item);
		addSerializedBytes(2 + Math.max(0, keys.length - 1));
		properties += keys.length;
		if (properties > MAX_SAFE_JSON_PROPERTIES) failUnsafeJson("Protocol value exceeds the property limit");
		for (const key of keys) {
			if (typeof key === "symbol") failUnsafeJson("Protocol values cannot contain symbol keys");
			if (DANGEROUS_KEYS.has(key)) failUnsafeJson("Protocol values contain a forbidden property name");
			addSerializedBytes(jsonStringUtf8ByteLength(key, MAX_ENVELOPE_UTF8_BYTES - serializedBytes) + 1);
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				failUnsafeJson("Protocol values must use enumerable data properties");
			}
			pending.push({ value: descriptor.value, depth: current.depth + 1 });
		}
	}
}

export function assertEnvelopeByteLimit(value: unknown): void {
	assertSafeJsonTree(value);
}

export function compileSchema<Schema extends TSchema>(schema: Schema): Validator<EmptySchemaContext, Schema> {
	return Compile(schema);
}

export function assertSchema(
	validator: Validator<EmptySchemaContext, TSchema>,
	value: unknown,
	kind: ProtocolValidationError["kind"],
	label: string,
): void {
	if (!validator.Check(value)) throw new ProtocolValidationError(kind, `Invalid ${label}`);
}
