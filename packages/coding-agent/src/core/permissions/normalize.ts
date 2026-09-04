import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { canonicalizeActionPath } from "../../utils/paths.ts";
import type {
	NetworkEndpoint,
	NormalizedPermissionAction,
	NormalizePermissionActionInput,
	PermissionEffect,
	ToolProvenance,
} from "./types.ts";

const MAX_CANONICAL_BYTES = 256 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_PATH_ENTRIES = 4_096;
const MAX_NETWORK_ENDPOINTS = 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVENANCES: readonly ToolProvenance[] = ["builtin", "host", "extension", "sdk", "mcp"];
const EFFECTS: readonly PermissionEffect[] = [
	"sensitive-read",
	"external-side-effect",
	"destructive",
	"elevation",
	"security-weakening",
	"payment",
	"production-mutation",
	"unknown",
];

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Permission action contains a non-finite number");
		return value;
	}
	if (typeof value !== "object") throw new TypeError(`Permission action contains unsupported ${typeof value}`);
	if (ancestors.has(value)) throw new TypeError("Permission action contains a cycle");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index)) throw new TypeError("Permission action contains a sparse array");
				const descriptor = Object.getOwnPropertyDescriptor(value, index);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
					throw new TypeError("Permission action array contains an accessor or hidden item");
				}
			}
			for (const key of Reflect.ownKeys(value)) {
				if (typeof key === "symbol" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) {
					throw new TypeError("Permission action array contains unsupported properties");
				}
			}
			return value.map((item) => canonicalValue(item, ancestors));
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Permission action must contain only plain objects");
		}

		const descriptors = Object.getOwnPropertyDescriptors(value);
		const result: Record<string, unknown> = Object.create(null);
		const keys = Reflect.ownKeys(descriptors);
		if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Permission action contains a symbol key");
		for (const key of (keys as string[]).sort()) {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new TypeError("Permission action contains an accessor or hidden property");
			}
			result[key] = canonicalValue(descriptor.value, ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	const canonical = JSON.stringify(canonicalValue(value, new Set()));
	if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) {
		throw new TypeError("Permission action exceeds 256 KiB");
	}
	return canonical;
}

export function digestCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requiredString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
	const normalized = value.trim();
	if (normalized.length === 0) throw new TypeError(`${field} must not be empty`);
	if (normalized.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
	if (normalized.length > maxLength) throw new TypeError(`${field} is too long`);
	return normalized;
}

function normalizePathSet(value: readonly string[], cwd: string, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
	if (value.length > MAX_PATH_ENTRIES) throw new TypeError(`${field} has too many entries`);
	const normalized = value.map((path) => {
		const checked = requiredString(path, field, 32_768);
		return canonicalizeActionPath(checked, cwd);
	});
	return Object.freeze([...new Set(normalized)].sort());
}

function normalizeHostname(value: unknown): string {
	const raw = requiredString(value, "network hostname", 253);
	if (/[*@/?#\\\s]/.test(raw)) throw new TypeError("Network hostname must be exact and credential-free");

	let authority = raw;
	if (raw.startsWith("[") || raw.endsWith("]")) {
		if (!(raw.startsWith("[") && raw.endsWith("]")) || isIP(raw.slice(1, -1)) !== 6) {
			throw new TypeError("Network hostname contains invalid IPv6 brackets");
		}
	} else if (isIP(raw) === 6) {
		authority = `[${raw}]`;
	} else if (raw.includes(":")) {
		throw new TypeError("Network hostname must not include a port");
	}

	let parsed: URL;
	try {
		parsed = new URL(`https://${authority}`);
	} catch {
		throw new TypeError("Network hostname is invalid");
	}
	if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
		throw new TypeError("Network hostname must contain only a hostname");
	}

	if (parsed.hostname.endsWith("..")) throw new TypeError("Network hostname is invalid");
	const normalized = parsed.hostname
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "")
		.toLowerCase();
	if (normalized.length === 0 || normalized.length > 253 || normalized.includes("*")) {
		throw new TypeError("Network hostname is invalid");
	}
	return normalized;
}

function normalizeEndpoint(endpoint: NetworkEndpoint): Readonly<NetworkEndpoint> {
	if (!endpoint || typeof endpoint !== "object") throw new TypeError("Network endpoint must be an object");
	if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
		throw new TypeError("Network endpoint port must be an integer from 1 to 65535");
	}
	return Object.freeze({ hostname: normalizeHostname(endpoint.hostname), port: endpoint.port });
}

function normalizeEndpoints(value: readonly NetworkEndpoint[]): readonly Readonly<NetworkEndpoint>[] {
	if (!Array.isArray(value)) throw new TypeError("networkEndpoints must be an array");
	if (value.length > MAX_NETWORK_ENDPOINTS) throw new TypeError("networkEndpoints has too many entries");
	const endpoints = value.map(normalizeEndpoint);
	const unique = new Map(endpoints.map((endpoint) => [JSON.stringify([endpoint.hostname, endpoint.port]), endpoint]));
	return Object.freeze(
		[...unique.values()].sort((left, right) =>
			left.hostname === right.hostname ? left.port - right.port : left.hostname < right.hostname ? -1 : 1,
		),
	);
}

function normalizeEffects(value: readonly PermissionEffect[]): readonly PermissionEffect[] {
	if (!Array.isArray(value)) throw new TypeError("effects must be an array");
	const unique = new Set<PermissionEffect>();
	for (const effect of value) {
		if (!EFFECTS.includes(effect)) throw new TypeError(`Unknown permission effect: ${String(effect)}`);
		unique.add(effect);
	}
	return Object.freeze(EFFECTS.filter((effect) => unique.has(effect)));
}

export function normalizePermissionAction(input: NormalizePermissionActionInput): NormalizedPermissionAction {
	if (!input || typeof input !== "object") throw new TypeError("Permission action must be an object");
	if (!PROVENANCES.includes(input.provenance)) throw new TypeError("Permission action provenance is invalid");

	const cwd = canonicalizeActionPath(requiredString(input.cwd, "cwd", 32_768), process.cwd());
	const command =
		input.command === undefined ? undefined : requiredString(input.command, "command", MAX_COMMAND_BYTES);
	if (command !== undefined && Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
		throw new TypeError("command exceeds 64 KiB");
	}

	const action: NormalizedPermissionAction = {
		actionId: requiredString(input.actionId, "actionId", 1_024),
		toolName: requiredString(input.toolName, "toolName", 256),
		provenance: input.provenance,
		toolIdentity: requiredString(input.toolIdentity, "toolIdentity", 4_096),
		argsDigest: digestCanonical(input.args),
		cwd,
		workspaceRoots: normalizePathSet(input.workspaceRoots, cwd, "workspaceRoots"),
		readPaths: normalizePathSet(input.readPaths, cwd, "readPaths"),
		writePaths: normalizePathSet(input.writePaths, cwd, "writePaths"),
		networkEndpoints: normalizeEndpoints(input.networkEndpoints),
		...(command === undefined ? {} : { command }),
		effects: normalizeEffects(input.effects),
	};
	canonicalJson(action);
	return Object.freeze(action);
}

export function assertWellFormedAction(action: NormalizedPermissionAction): void {
	const expectedKeys = [
		"actionId",
		"toolName",
		"provenance",
		"toolIdentity",
		"argsDigest",
		"cwd",
		"workspaceRoots",
		"readPaths",
		"writePaths",
		"networkEndpoints",
		...(action?.command === undefined ? [] : ["command"]),
		"effects",
	].sort();
	const actualKeys = action && typeof action === "object" ? Object.keys(action).sort() : [];
	const normalizedEffects = EFFECTS.filter((effect) => action?.effects?.includes(effect));
	const pathSets = action ? [action.workspaceRoots, action.readPaths, action.writePaths] : [];
	let canonicalIsBounded = false;
	let scalarFieldsAreNormalized = false;
	try {
		canonicalJson(action);
		canonicalIsBounded = true;
	} catch {
		canonicalIsBounded = false;
	}
	try {
		scalarFieldsAreNormalized =
			requiredString(action.actionId, "actionId", 1_024) === action.actionId &&
			requiredString(action.toolName, "toolName", 256) === action.toolName &&
			requiredString(action.toolIdentity, "toolIdentity", 4_096) === action.toolIdentity &&
			requiredString(action.cwd, "cwd", 32_768) === action.cwd &&
			(action.command === undefined ||
				(requiredString(action.command, "command", MAX_COMMAND_BYTES) === action.command &&
					Buffer.byteLength(action.command, "utf8") <= MAX_COMMAND_BYTES));
	} catch {
		scalarFieldsAreNormalized = false;
	}
	const complete =
		Boolean(action?.actionId) &&
		Object.isFrozen(action) &&
		actualKeys.length === expectedKeys.length &&
		actualKeys.every((key, index) => key === expectedKeys[index]) &&
		PROVENANCES.includes(action.provenance) &&
		Boolean(action.toolName) &&
		Boolean(action.toolIdentity) &&
		SHA256_PATTERN.test(action.argsDigest) &&
		isAbsolute(action.cwd) &&
		Array.isArray(action.workspaceRoots) &&
		Array.isArray(action.readPaths) &&
		Array.isArray(action.writePaths) &&
		Array.isArray(action.networkEndpoints) &&
		Array.isArray(action.effects) &&
		Object.isFrozen(action.workspaceRoots) &&
		Object.isFrozen(action.readPaths) &&
		Object.isFrozen(action.writePaths) &&
		Object.isFrozen(action.networkEndpoints) &&
		Object.isFrozen(action.effects) &&
		action.networkEndpoints.every(Object.isFrozen) &&
		pathSets.every(
			(paths) =>
				new Set(paths).size === paths.length &&
				paths.every(
					(path, index) =>
						typeof path === "string" &&
						isAbsolute(path) &&
						!path.includes("\0") &&
						(index === 0 || (paths[index - 1] ?? "") < path),
				),
		) &&
		action.networkEndpoints.every((endpoint, index) => {
			const previous = action.networkEndpoints[index - 1];
			return (
				!previous ||
				previous.hostname < endpoint.hostname ||
				(previous.hostname === endpoint.hostname && previous.port < endpoint.port)
			);
		}) &&
		action.networkEndpoints.every((endpoint) => {
			try {
				const normalized = normalizeEndpoint(endpoint);
				return normalized.hostname === endpoint.hostname && normalized.port === endpoint.port;
			} catch {
				return false;
			}
		}) &&
		action.effects.length === normalizedEffects.length &&
		action.effects.every((effect, index) => effect === normalizedEffects[index]) &&
		(!action.effects.includes("sensitive-read") || action.readPaths.length > 0) &&
		(!action.effects.includes("destructive") ||
			action.writePaths.length > 0 ||
			action.effects.includes("external-side-effect")) &&
		scalarFieldsAreNormalized &&
		canonicalIsBounded;
	if (!complete) throw new TypeError("Permission action scope is incomplete");
}

export function assertCompleteAction(action: NormalizedPermissionAction): void {
	assertWellFormedAction(action);
	if (action.effects.includes("unknown")) throw new TypeError("Permission action scope is incomplete");
}

export function digestPermissionAction(action: NormalizedPermissionAction): string {
	assertWellFormedAction(action);
	const { actionId: _actionId, ...stableAction } = action;
	return digestCanonical(stableAction);
}
