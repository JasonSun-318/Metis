import { createHash } from "node:crypto";
import type { ClientParams, ClientResult, McpCredentialInput } from "@metis/app-protocol";
import { getNodeValue, type Node, type ParseError, parseTree } from "jsonc-parser";
import { inputMcpServer } from "./mcp-projection.ts";

const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_SERVERS = 128;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type McpServerInput = ClientParams<"mcp/upsert">["server"];

export interface McpImportSource {
	readonly scope: "user" | "project";
	readonly cwd: string;
	readonly text: string;
}

export interface McpImportSelection {
	readonly id: string;
	readonly expectedRevision: string | null;
}

export interface ResolvedMcpImportEntry {
	readonly id: string;
	readonly name: string;
	readonly server: McpServerInput;
	readonly credential?: McpCredentialInput;
	readonly expectedRevision: string | null;
}

export interface ResolvedMcpImport {
	readonly sourceRevision: string;
	readonly entries: readonly ResolvedMcpImportEntry[];
}

interface NormalizedCandidate {
	readonly id: string;
	readonly name: string;
	readonly server: McpServerInput;
	readonly credential?: McpCredentialInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceRevision(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function stringArray(value: unknown, field: string, maximum = 128): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item)) {
		throw new Error(`MCP ${field} must contain non-empty strings`);
	}
	return [...new Set(value)];
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.keys(value).length > 128 ||
		Object.entries(value).some(([name, item]) => !name || UNSAFE_KEYS.has(name) || typeof item !== "string" || !item)
	) {
		throw new Error(`MCP ${field} must contain non-empty string values`);
	}
	return Object.fromEntries(Object.entries(value) as Array<[string, string]>);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`MCP ${field} must be a boolean`);
	return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number") throw new Error(`MCP ${field} must be a number`);
	return value;
}

function optionalDescription(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("MCP description must be a string");
	const description = value.trim();
	if (!description) return undefined;
	if (Buffer.byteLength(description, "utf8") > 4096) throw new Error("MCP description is too long");
	return description;
}

function commonFields(raw: Record<string, unknown>) {
	const description = optionalDescription(raw.description);
	const enabled = optionalBoolean(raw.enabled, "enabled");
	const required = optionalBoolean(raw.required, "required");
	const startupTimeoutSec = optionalNumber(raw.startupTimeoutSec, "startupTimeoutSec");
	const toolTimeoutSec = optionalNumber(raw.toolTimeoutSec, "toolTimeoutSec");
	const enabledTools = stringArray(raw.enabledTools, "enabledTools", 512);
	const disabledTools = stringArray(raw.disabledTools, "disabledTools", 512);
	return {
		...(description === undefined ? {} : { description }),
		...(enabled === undefined ? {} : { enabled }),
		...(required === undefined ? {} : { required }),
		...(startupTimeoutSec === undefined ? {} : { startupTimeoutSec }),
		...(toolTimeoutSec === undefined ? {} : { toolTimeoutSec }),
		...(enabledTools === undefined ? {} : { enabledTools }),
		...(disabledTools === undefined ? {} : { disabledTools }),
	};
}

function referenceName(value: string): string | undefined {
	const match = ENVIRONMENT_REFERENCE.exec(value);
	return match?.[1] ?? match?.[2];
}

function headerEnvironmentName(serverName: string, header: string): string {
	const server =
		serverName
			.toUpperCase()
			.replace(/[^A-Z0-9_]/gu, "_")
			.replace(/^[^A-Z_]+/u, "")
			.slice(0, 200) || "SERVER";
	const hash = createHash("sha256").update(header.toLowerCase()).digest("hex").slice(0, 8).toUpperCase();
	return `METIS_MCP_${server}_${hash}`;
}

function credential(environment: Record<string, string>, bearerToken?: string): McpCredentialInput | undefined {
	const entries = Object.entries(environment);
	if (entries.length > 128) throw new Error("MCP import contains too many credential values");
	if (!bearerToken && entries.length === 0) return undefined;
	return {
		...(bearerToken ? { bearerToken } : {}),
		...(entries.length
			? { environment: Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) }
			: {}),
	};
}

function normalizeCandidate(name: string, raw: unknown, cwd: string): NormalizedCandidate {
	if (!name || name.length > 256 || UNSAFE_KEYS.has(name)) throw new Error("MCP server name is invalid");
	if (!isRecord(raw)) throw new Error(`MCP server "${name}" must be an object`);
	const transport = raw.type ?? raw.transport;
	if (transport === "sse") throw new Error("SSE MCP imports are not supported");
	const hasCommand = raw.command !== undefined;
	const hasUrl = raw.url !== undefined;
	if (hasCommand === hasUrl) throw new Error(`MCP server "${name}" must define exactly one of command or url`);
	const common = commonFields(raw);
	const secretEnvironment: Record<string, string> = {};
	let server: McpServerInput;
	let bearerToken: string | undefined;

	if (hasCommand) {
		if (transport !== undefined && transport !== "stdio")
			throw new Error(`MCP server "${name}" has an invalid transport`);
		if (typeof raw.command !== "string" || !raw.command) throw new Error("MCP command must be a non-empty string");
		const envVars = new Set(stringArray(raw.envVars, "envVars") ?? []);
		for (const [environmentName, value] of Object.entries(stringMap(raw.env, "env") ?? {})) {
			if (!ENVIRONMENT_NAME.test(environmentName)) throw new Error("MCP environment name is invalid");
			const reference = referenceName(value);
			if (reference) envVars.add(reference);
			else secretEnvironment[environmentName] = value;
		}
		server = {
			...common,
			transport: "stdio",
			command: raw.command,
			...(raw.args === undefined ? {} : { args: stringArray(raw.args, "args")! }),
			...(envVars.size ? { envVars: [...envVars].sort() } : {}),
			...(raw.cwd === undefined
				? {}
				: typeof raw.cwd === "string" && raw.cwd
					? { cwd: raw.cwd }
					: (() => {
							throw new Error("MCP cwd must be a non-empty string");
						})()),
		};
	} else {
		if (transport !== undefined && transport !== "http" && transport !== "streamable-http") {
			throw new Error(`MCP server "${name}" has an invalid transport`);
		}
		if (typeof raw.url !== "string" || !raw.url) throw new Error("MCP URL must be a non-empty string");
		const envHttpHeaders = stringMap(raw.envHttpHeaders, "envHttpHeaders") ?? {};
		for (const [header, value] of Object.entries(stringMap(raw.headers, "headers") ?? {})) {
			const reference = referenceName(value);
			if (reference) {
				envHttpHeaders[header] = reference;
				continue;
			}
			const bearer = header.toLowerCase() === "authorization" ? /^Bearer\s+(.+)$/iu.exec(value)?.[1] : undefined;
			if (bearer) bearerToken = bearer;
			else {
				const environmentName = headerEnvironmentName(name, header);
				envHttpHeaders[header] = environmentName;
				secretEnvironment[environmentName] = value;
			}
		}
		if (
			raw.bearerTokenEnvVar !== undefined &&
			(typeof raw.bearerTokenEnvVar !== "string" || !raw.bearerTokenEnvVar)
		) {
			throw new Error("MCP bearerTokenEnvVar must be a non-empty string");
		}
		server = {
			...common,
			transport: "http",
			url: raw.url,
			...(raw.bearerTokenEnvVar ? { bearerTokenEnvVar: raw.bearerTokenEnvVar as string } : {}),
			...(Object.keys(envHttpHeaders).length ? { envHttpHeaders } : {}),
		};
	}

	inputMcpServer(server, undefined, cwd);
	const extractedCredential = credential(secretEnvironment, bearerToken);
	return { id: name, name, server, ...(extractedCredential ? { credential: extractedCredential } : {}) };
}

function assertSafeObjectKeys(node: Node): void {
	if (node.type === "object") {
		const names = (node.children ?? []).map((property) => String(property.children?.[0]?.value ?? ""));
		if (new Set(names).size !== names.length) throw new Error("MCP import contains duplicate object keys");
		if (names.some((name) => UNSAFE_KEYS.has(name))) throw new Error("MCP import contains an unsafe object key");
		for (const property of node.children ?? []) {
			const value = property.children?.[1];
			if (value) assertSafeObjectKeys(value);
		}
		return;
	}
	if (node.type === "array") {
		for (const child of node.children ?? []) assertSafeObjectKeys(child);
	}
}

function parseCandidates(input: McpImportSource): { sourceRevision: string; candidates: NormalizedCandidate[] } {
	if (!input.text || Buffer.byteLength(input.text, "utf8") > MAX_IMPORT_BYTES) {
		throw new Error("MCP import must contain JSONC no larger than 1 MiB");
	}
	const errors: ParseError[] = [];
	const root = parseTree(input.text, errors, { allowTrailingComma: true, disallowComments: false });
	const parsed: unknown = root ? getNodeValue(root) : undefined;
	if (errors.length || !root || !isRecord(parsed)) throw new Error("MCP import must be valid JSON or JSONC");
	assertSafeObjectKeys(root);
	const rawServers = parsed.mcpServers ?? parsed;
	if (!isRecord(rawServers)) throw new Error("MCP import must contain an mcpServers object");
	const entries = Object.entries(rawServers);
	if (entries.length === 0 || entries.length > MAX_SERVERS)
		throw new Error("MCP import must contain 1 to 128 servers");
	const names = new Set<string>();
	const candidates = entries.map(([rawName, raw]) => {
		const name = rawName.trim();
		if (names.has(name)) throw new Error(`MCP import contains duplicate server name "${name}"`);
		names.add(name);
		return normalizeCandidate(name, raw, input.cwd);
	});
	candidates.sort((left, right) => left.name.localeCompare(right.name));
	return { sourceRevision: sourceRevision(input.text), candidates };
}

export function inspectMcpImport(
	input: McpImportSource,
	existing: ReadonlyMap<string, string | null>,
): ClientResult<"mcp/import/inspect"> {
	const parsed = parseCandidates(input);
	return {
		sourceRevision: parsed.sourceRevision,
		candidates: parsed.candidates.map(({ id, name, server, credential: candidateCredential }) => ({
			id,
			name,
			transport: server.transport,
			enabled: server.enabled ?? true,
			existingRevision: existing.get(name) ?? null,
			bearerTokenConfigured: Boolean(candidateCredential?.bearerToken),
			credentialNames: Object.keys(candidateCredential?.environment ?? {}).sort(),
		})),
	};
}

export function resolveMcpImport(
	input: McpImportSource,
	selected: readonly McpImportSelection[],
	expectedSourceRevision?: string,
): ResolvedMcpImport {
	const parsed = parseCandidates(input);
	if (expectedSourceRevision !== undefined && parsed.sourceRevision !== expectedSourceRevision) {
		throw new Error("MCP import source changed after inspection");
	}
	const candidates = new Map(parsed.candidates.map((candidate) => [candidate.id, candidate]));
	const seen = new Set<string>();
	const entries = selected.map(({ id, expectedRevision }) => {
		if (seen.has(id)) throw new Error(`MCP import candidate "${id}" is duplicated`);
		seen.add(id);
		const candidate = candidates.get(id);
		if (!candidate) throw new Error(`MCP import candidate "${id}" was not found`);
		return { ...candidate, expectedRevision };
	});
	return { sourceRevision: parsed.sourceRevision, entries };
}
