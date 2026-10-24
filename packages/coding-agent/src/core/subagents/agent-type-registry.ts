import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { AGENT_TYPE_PROFILES, type AgentTypeProfile } from "./profiles.ts";

export const BUILT_IN_AGENT_TYPE_IDS: readonly string[] = Object.keys(AGENT_TYPE_PROFILES);
export const AGENT_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const MAX_CUSTOM_AGENT_TYPES = 16;

const REGISTRY_FILE_NAME = "agent-types.json";
const MAX_DISPLAY_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 512;
const MAX_SYSTEM_PROMPT_UTF8_BYTES = 8 * 1024;
const MAX_ALLOWED_TOOLS = 32;
const NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface CustomAgentType {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly allowedTools: readonly string[];
	readonly systemPrompt: string;
	readonly writePolicy: "inherit" | "deny";
	readonly mayDelegate: boolean;
}

/** Durable role instructions, never an authorization or runtime-tool snapshot. */
export interface AgentRoleSnapshot {
	readonly version: 1;
	readonly agentType: string;
	readonly displayName: string;
	readonly purpose: string;
	readonly systemPrompt: string;
	readonly revision: string;
	readonly source: "created" | "legacy-current" | "legacy-missing";
}

export function parseAgentRoleSnapshot(value: unknown): AgentRoleSnapshot {
	const fields = ["version", "agentType", "displayName", "purpose", "systemPrompt", "revision", "source"];
	if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
		throw new Error("Invalid agent role snapshot fields");
	}
	const { version, agentType, displayName, purpose, systemPrompt, revision, source } = value;
	if (version !== 1) throw new Error("Invalid agent role snapshot version");
	if (typeof agentType !== "string" || !AGENT_TYPE_ID_PATTERN.test(agentType)) {
		throw new Error("Invalid agent role snapshot agentType");
	}
	if (
		typeof displayName !== "string" ||
		displayName.length < 1 ||
		displayName.length > MAX_DISPLAY_NAME_CHARS ||
		NAME_CONTROL_CHARS.test(displayName)
	) {
		throw new Error("Invalid agent role snapshot displayName");
	}
	if (typeof purpose !== "string" || purpose.length > MAX_DESCRIPTION_CHARS) {
		throw new Error("Invalid agent role snapshot purpose");
	}
	if (typeof systemPrompt !== "string" || Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_UTF8_BYTES) {
		throw new Error("Invalid agent role snapshot systemPrompt");
	}
	if (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision)) {
		throw new Error("Invalid agent role snapshot revision");
	}
	if (source !== "created" && source !== "legacy-current" && source !== "legacy-missing") {
		throw new Error("Invalid agent role snapshot source");
	}
	return Object.freeze({ version, agentType, displayName, purpose, systemPrompt, revision, source });
}

function agentRoleRevision(agentType: string, definition: AgentTypeProfile): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				agentType,
				displayName: definition.displayName ?? agentType,
				purpose: definition.purpose,
				systemPrompt: definition.systemPrompt ?? "",
				allowedTools: definition.allowedTools ? [...new Set(definition.allowedTools)].sort() : null,
				writePolicy: definition.writePolicy,
				mayDelegate: definition.mayDelegate,
			}),
		)
		.digest("hex");
}

export function captureAgentRoleSnapshot(
	agentType: string,
	definition: AgentTypeProfile,
	source: "created" | "legacy-current" = "created",
): AgentRoleSnapshot {
	return Object.freeze({
		version: 1,
		agentType,
		displayName: definition.displayName ?? agentType,
		purpose: definition.purpose,
		systemPrompt: definition.systemPrompt ?? "",
		revision: agentRoleRevision(agentType, definition),
		source,
	});
}

export function resolveAgentRoleSnapshot(
	agentType: string,
	options: {
		readonly roleSnapshot?: AgentRoleSnapshot;
		readonly agentDir?: string;
		readonly definitions?: Readonly<Record<string, AgentTypeProfile>>;
	} = {},
): AgentRoleSnapshot {
	if (options.roleSnapshot) {
		if (options.roleSnapshot.agentType !== agentType) {
			throw new Error(`Role snapshot ${options.roleSnapshot.agentType} does not match agent type ${agentType}`);
		}
		return options.roleSnapshot;
	}
	const definitions = options.definitions ?? loadAgentTypeDefinitions(options.agentDir);
	const definition = Object.hasOwn(definitions, agentType) ? definitions[agentType] : undefined;
	if (definition) return captureAgentRoleSnapshot(agentType, definition, "legacy-current");
	const fallback = captureAgentRoleSnapshot(agentType, {
		purpose:
			"The historical role instructions could not be recovered. Continue only the explicit assignment under the existing runtime limits.",
		writePolicy: "deny",
		mayDelegate: false,
	});
	return Object.freeze({ ...fallback, source: "legacy-missing" });
}

interface RegistryFile {
	readonly version: 1;
	readonly types: readonly CustomAgentType[];
}

let cache:
	| {
			readonly path: string;
			readonly mtimeMs: number;
			readonly size: number;
			readonly types: readonly CustomAgentType[];
	  }
	| undefined;

function registryPath(agentDir: string): string {
	return join(agentDir, REGISTRY_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): CustomAgentType | undefined {
	if (!isRecord(value)) return undefined;
	const { id, displayName, description, allowedTools, systemPrompt, writePolicy, mayDelegate } = value;
	if (typeof id !== "string" || !AGENT_TYPE_ID_PATTERN.test(id) || BUILT_IN_AGENT_TYPE_IDS.includes(id))
		return undefined;
	if (typeof displayName !== "string" || displayName.length < 1 || displayName.length > MAX_DISPLAY_NAME_CHARS)
		return undefined;
	if (NAME_CONTROL_CHARS.test(displayName)) return undefined;
	if (typeof description !== "string" || description.length > MAX_DESCRIPTION_CHARS) return undefined;
	if (!Array.isArray(allowedTools) || allowedTools.length > MAX_ALLOWED_TOOLS) return undefined;
	if (allowedTools.some((tool) => typeof tool !== "string" || tool.length < 1 || tool.length > 64)) return undefined;
	if (typeof systemPrompt !== "string" || Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_UTF8_BYTES)
		return undefined;
	if (writePolicy !== "inherit" && writePolicy !== "deny") return undefined;
	if (typeof mayDelegate !== "boolean") return undefined;
	return { id, displayName, description, allowedTools, systemPrompt, writePolicy, mayDelegate };
}

export function isValidAgentTypeId(id: string): boolean {
	return BUILT_IN_AGENT_TYPE_IDS.includes(id) || AGENT_TYPE_ID_PATTERN.test(id);
}

export function readCustomAgentTypes(agentDir: string = getAgentDir()): readonly CustomAgentType[] {
	const path = registryPath(agentDir);
	if (!existsSync(path)) return [];
	const stats = statSync(path);
	if (cache?.path === path && cache.mtimeMs === stats.mtimeMs && cache.size === stats.size) return cache.types;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	const types =
		isRecord(parsed) && Array.isArray(parsed.types)
			? parsed.types.map(parseEntry).filter((entry): entry is CustomAgentType => entry !== undefined)
			: [];
	cache = { path, mtimeMs: stats.mtimeMs, size: stats.size, types };
	return types;
}

function writeRegistry(agentDir: string, types: readonly CustomAgentType[]): void {
	mkdirSync(agentDir, { recursive: true });
	const path = registryPath(agentDir);
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ version: 1, types } satisfies RegistryFile, null, "\t")}\n`);
	renameSync(temporary, path);
	cache = undefined;
}

export function upsertCustomAgentType(agentDir: string, input: CustomAgentType): void {
	if (BUILT_IN_AGENT_TYPE_IDS.includes(input.id)) {
		throw new Error(`Agent type id is reserved by a built-in role: ${input.id}`);
	}
	if (!AGENT_TYPE_ID_PATTERN.test(input.id)) {
		throw new Error(`Agent type id must match ${AGENT_TYPE_ID_PATTERN.source}: ${input.id}`);
	}
	if (
		input.displayName.length < 1 ||
		input.displayName.length > MAX_DISPLAY_NAME_CHARS ||
		NAME_CONTROL_CHARS.test(input.displayName)
	) {
		throw new Error(
			`Agent type displayName must be 1-${MAX_DISPLAY_NAME_CHARS} characters without control characters`,
		);
	}
	if (input.description.length > MAX_DESCRIPTION_CHARS) {
		throw new Error(`Agent type description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
	}
	if (Buffer.byteLength(input.systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_UTF8_BYTES) {
		throw new Error(`Agent type systemPrompt must be at most ${MAX_SYSTEM_PROMPT_UTF8_BYTES} UTF-8 bytes`);
	}
	if (
		input.allowedTools.length > MAX_ALLOWED_TOOLS ||
		input.allowedTools.some((tool) => tool.length < 1 || tool.length > 64)
	) {
		throw new Error(`Agent type allowedTools must contain at most ${MAX_ALLOWED_TOOLS} entries of 1-64 characters`);
	}
	const others = readCustomAgentTypes(agentDir).filter((entry) => entry.id !== input.id);
	if (others.length >= MAX_CUSTOM_AGENT_TYPES) {
		throw new Error(`Custom agent types are capped at ${MAX_CUSTOM_AGENT_TYPES}`);
	}
	writeRegistry(agentDir, [...others, input]);
}

export function removeCustomAgentType(agentDir: string, id: string): void {
	if (BUILT_IN_AGENT_TYPE_IDS.includes(id)) throw new Error(`Cannot remove built-in agent type: ${id}`);
	const current = readCustomAgentTypes(agentDir);
	const remaining = current.filter((entry) => entry.id !== id);
	if (remaining.length === current.length) throw new Error(`Unknown custom agent type: ${id}`);
	writeRegistry(agentDir, remaining);
}

export function loadAgentTypeDefinitions(agentDir: string = getAgentDir()): Readonly<Record<string, AgentTypeProfile>> {
	const definitions: Record<string, AgentTypeProfile> = { ...AGENT_TYPE_PROFILES };
	for (const custom of readCustomAgentTypes(agentDir)) {
		definitions[custom.id] = {
			displayName: custom.displayName,
			purpose: custom.description,
			...(custom.allowedTools.length > 0 ? { allowedTools: custom.allowedTools } : {}),
			...(custom.systemPrompt ? { systemPrompt: custom.systemPrompt } : {}),
			writePolicy: custom.writePolicy,
			mayDelegate: custom.mayDelegate,
		};
	}
	return Object.fromEntries(
		Object.entries(definitions).map(([id, definition]) => [
			id,
			{ ...definition, revision: agentRoleRevision(id, definition) },
		]),
	);
}
