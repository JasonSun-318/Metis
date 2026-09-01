import { isIP } from "node:net";

export interface SandboxNetworkEndpoint {
	readonly hostname: string;
	readonly port: number;
}

export type SandboxErrorCode = "SANDBOX_UNAVAILABLE" | "SANDBOX_PROTOCOL" | "SANDBOX_CLOSED";

export type SandboxRequest =
	| {
			type: "init";
			cwd: string;
			workspaceRoots: string[];
			readOnlyRoots: string[];
			writeRoots: string[];
			protectedRoots: string[];
			writeProtectedRoots: string[];
			networkEndpoints: SandboxNetworkEndpoint[];
			shellPath?: string;
			workspaceReadOnly?: boolean;
	  }
	| { type: "exec"; id: string; command: string; cwd: string; timeoutMs?: number; env: Record<string, string> }
	| { type: "cancel"; id: string }
	| { type: "close" };

export type SandboxResponse =
	| { type: "ready" }
	| { type: "closed" }
	| { type: "data"; id: string; data: string }
	| { type: "result"; id: string; exitCode: number | null }
	| { type: "error"; id?: string; code: SandboxErrorCode; message: string };

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_ENV_ENTRIES = 256;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_PATHS = 128;
const MAX_PATH_LENGTH = 4096;

function parseLine(line: string): unknown {
	if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new TypeError("Sandbox message exceeds 1 MiB");
	return JSON.parse(line);
}

function strictRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Sandbox message must be an object");
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!keys.includes(key)) throw new TypeError(`Unknown sandbox field: ${key}`);
	}
	return record;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new TypeError(`Sandbox ${field} must be a non-empty string without NUL bytes`);
	}
	return value;
}

function paths(value: unknown, field: string, allowEmpty: boolean): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_PATHS) {
		throw new TypeError(`Sandbox ${field} must be a bounded array`);
	}
	return value.map((item) => {
		const path = nonEmptyString(item, field);
		if (path.length > MAX_PATH_LENGTH) throw new TypeError(`Sandbox ${field} path is too long`);
		return path;
	});
}

export function normalizeSandboxNetworkEndpoints(value: unknown): SandboxNetworkEndpoint[] {
	if (!Array.isArray(value) || value.length > MAX_PATHS) {
		throw new TypeError("Sandbox networkEndpoints must be a bounded array");
	}
	const endpoints = value.map((item) => {
		const record = strictRecord(item, ["hostname", "port"]);
		const hostname = nonEmptyString(record.hostname, "network hostname");
		if (
			/[*@/?#\\\s]/u.test(hostname) ||
			!Number.isInteger(record.port) ||
			(record.port as number) < 1 ||
			(record.port as number) > 65_535
		) {
			throw new TypeError("Sandbox network endpoint is invalid");
		}
		let authority = hostname;
		if (isIP(hostname) === 6) authority = `[${hostname}]`;
		let normalized: string;
		try {
			normalized = new URL(`https://${authority}`).hostname
				.replace(/^\[|\]$/gu, "")
				.replace(/\.$/u, "")
				.toLowerCase();
		} catch {
			throw new TypeError("Sandbox network endpoint is invalid");
		}
		if (normalized !== hostname) throw new TypeError("Sandbox network endpoint must be canonical");
		return Object.freeze({ hostname, port: record.port as number });
	});
	const unique = new Map(endpoints.map((endpoint) => [`${endpoint.hostname}\0${endpoint.port}`, endpoint]));
	if (unique.size !== endpoints.length) throw new TypeError("Sandbox network endpoints must be unique");
	return [...endpoints].sort((left, right) =>
		left.hostname === right.hostname ? left.port - right.port : left.hostname < right.hostname ? -1 : 1,
	);
}

function environment(value: unknown): Record<string, string> {
	const record = strictRecord(value, typeof value === "object" && value !== null ? Object.keys(value) : []);
	const entries = Object.entries(record);
	if (entries.length > MAX_ENV_ENTRIES) throw new TypeError("Sandbox environment has too many entries");
	let bytes = 0;
	const result: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [key, rawValue] of entries) {
		if (
			key.length === 0 ||
			key.includes("=") ||
			key.includes("\0") ||
			typeof rawValue !== "string" ||
			rawValue.includes("\0")
		) {
			throw new TypeError("Sandbox environment must contain valid strings");
		}
		bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(rawValue, "utf8");
		result[key] = rawValue;
	}
	if (bytes > MAX_ENV_BYTES) throw new TypeError("Sandbox environment exceeds 256 KiB");
	return result;
}

function timeout(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_TIMEOUT_MS) {
		throw new TypeError("Sandbox timeout is invalid");
	}
	return value as number;
}

export function parseSandboxRequest(line: string): SandboxRequest {
	const value = strictRecord(parseLine(line), [
		"type",
		"cwd",
		"workspaceRoots",
		"readOnlyRoots",
		"writeRoots",
		"protectedRoots",
		"writeProtectedRoots",
		"networkEndpoints",
		"shellPath",
		"workspaceReadOnly",
		"id",
		"command",
		"timeoutMs",
		"env",
	]);
	const type = nonEmptyString(value.type, "request type");
	switch (type) {
		case "init": {
			const record = strictRecord(value, [
				"type",
				"cwd",
				"workspaceRoots",
				"readOnlyRoots",
				"writeRoots",
				"protectedRoots",
				"writeProtectedRoots",
				"networkEndpoints",
				"shellPath",
				"workspaceReadOnly",
			]);
			const workspaceReadOnly = record.workspaceReadOnly;
			if (workspaceReadOnly !== undefined && typeof workspaceReadOnly !== "boolean") {
				throw new TypeError("Sandbox workspaceReadOnly must be a boolean");
			}
			return {
				type,
				cwd: nonEmptyString(record.cwd, "cwd"),
				workspaceRoots: paths(record.workspaceRoots, "workspaceRoots", false),
				readOnlyRoots: paths(record.readOnlyRoots, "readOnlyRoots", true),
				writeRoots: paths(record.writeRoots, "writeRoots", true),
				protectedRoots: paths(record.protectedRoots, "protectedRoots", true),
				writeProtectedRoots: paths(record.writeProtectedRoots, "writeProtectedRoots", true),
				networkEndpoints: normalizeSandboxNetworkEndpoints(record.networkEndpoints),
				...(record.shellPath === undefined ? {} : { shellPath: nonEmptyString(record.shellPath, "shellPath") }),
				...(workspaceReadOnly === undefined ? {} : { workspaceReadOnly }),
			};
		}
		case "exec": {
			const record = strictRecord(value, ["type", "id", "command", "cwd", "timeoutMs", "env"]);
			const command = nonEmptyString(record.command, "command");
			if (Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES) {
				throw new TypeError("Sandbox command exceeds 256 KiB");
			}
			const timeoutMs = timeout(record.timeoutMs);
			return {
				type,
				id: nonEmptyString(record.id, "request id"),
				command,
				cwd: nonEmptyString(record.cwd, "cwd"),
				...(timeoutMs === undefined ? {} : { timeoutMs }),
				env: environment(record.env),
			};
		}
		case "cancel": {
			const record = strictRecord(value, ["type", "id"]);
			return { type, id: nonEmptyString(record.id, "request id") };
		}
		case "close":
			strictRecord(value, ["type"]);
			return { type };
		default:
			throw new TypeError(`Unknown sandbox request type: ${type}`);
	}
}

export function parseSandboxResponse(line: string): SandboxResponse {
	const value = strictRecord(parseLine(line), ["type", "id", "data", "exitCode", "code", "message"]);
	const type = nonEmptyString(value.type, "response type");
	switch (type) {
		case "ready":
		case "closed":
			strictRecord(value, ["type"]);
			return { type };
		case "data": {
			const record = strictRecord(value, ["type", "id", "data"]);
			const data = nonEmptyString(record.data, "data");
			if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
				throw new TypeError("Sandbox data must be base64");
			}
			return {
				type,
				id: nonEmptyString(record.id, "request id"),
				data,
			};
		}
		case "result": {
			const record = strictRecord(value, ["type", "id", "exitCode"]);
			if (
				record.exitCode !== null &&
				(!Number.isInteger(record.exitCode) ||
					(record.exitCode as number) < 0 ||
					(record.exitCode as number) > MAX_TIMEOUT_MS)
			) {
				throw new TypeError("Sandbox exitCode is invalid");
			}
			return {
				type,
				id: nonEmptyString(record.id, "request id"),
				exitCode: record.exitCode as number | null,
			};
		}
		case "error": {
			const record = strictRecord(value, ["type", "id", "code", "message"]);
			if (!new Set(["SANDBOX_UNAVAILABLE", "SANDBOX_PROTOCOL", "SANDBOX_CLOSED"]).has(String(record.code))) {
				throw new TypeError("Sandbox error code is invalid");
			}
			return {
				type,
				...(record.id === undefined ? {} : { id: nonEmptyString(record.id, "request id") }),
				code: record.code as SandboxErrorCode,
				message: nonEmptyString(record.message, "error message"),
			};
		}
		default:
			throw new TypeError(`Unknown sandbox response type: ${type}`);
	}
}
