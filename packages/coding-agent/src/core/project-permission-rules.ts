import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { canonicalizeActionPath } from "../utils/paths.ts";
import { FileAuthStorageBackend } from "./auth-storage.ts";
import type { ActionRisk, PermissionAction, PermissionExecutionTarget } from "./permission-policy.ts";

export interface ProjectPermissionRuleDetail {
	readonly label: string;
	readonly value: string;
}

export interface ProjectPermissionRuleView {
	readonly id: string;
	readonly projectPath: string;
	readonly toolName: string;
	readonly command?: string;
	readonly paths: readonly string[];
	readonly details: readonly ProjectPermissionRuleDetail[];
	readonly omittedDetails: number;
	readonly risks: readonly ActionRisk[];
	readonly executionTarget: PermissionExecutionTarget;
	readonly createdAt: string;
}

export interface ProjectPermissionSignatureInput {
	readonly projectPath: string;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly executionTarget: PermissionExecutionTarget;
}

interface PermissionRuleFile {
	readonly version: 1;
	readonly rules: readonly ProjectPermissionRuleView[];
}

const FILE_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 256 * 1024;
const MAX_RULES_PER_PROJECT = 256;
const MAX_RULES_TOTAL = 4096;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_COMMAND_LENGTH = 16 * 1024;
const MAX_PATH_LENGTH = 4096;
const MAX_PATHS = 128;
const MAX_RISKS = 16;
const MAX_DETAILS = 128;
const MAX_DETAIL_VALUE_LENGTH = 4096;
const SECRET_DETAIL_KEY = /(api.?key|authorization|cookie|credential|password|private.?key|secret|token)/iu;
const ACTION_RISKS = new Set<ActionRisk>([
	"ordinary-read",
	"outside-read",
	"sensitive-read",
	"workspace-write",
	"outside-write",
	"shell",
	"destructive",
	"network",
	"elevation",
	"external-side-effect",
	"custom",
	"unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function canonicalJsonValue(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Permission rule arguments must contain finite JSON numbers");
		return value;
	}
	if (typeof value !== "object") throw new TypeError("Permission rule arguments must be JSON-compatible");
	if (seen.has(value)) throw new TypeError("Permission rule arguments must not be cyclic");
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item, seen));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError("Permission rule arguments must use plain JSON objects");
		}
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalJsonValue((value as Record<string, unknown>)[key], seen)]),
		);
	} finally {
		seen.delete(value);
	}
}

function boundedCanonicalJson(value: unknown): string {
	const serialized = JSON.stringify(canonicalJsonValue(value));
	if (Buffer.byteLength(serialized, "utf8") > MAX_SIGNATURE_BYTES) {
		throw new TypeError("Permission rule signature is too large");
	}
	return serialized;
}

function canonicalAbsolutePath(path: string, cwd: string): string {
	if (!path || path.length > MAX_PATH_LENGTH || path.includes("\0") || !isAbsolute(path)) {
		throw new TypeError("Permission rule paths must be bounded absolute paths");
	}
	const canonical = canonicalizeActionPath(path, cwd);
	if (canonical.length > MAX_PATH_LENGTH) throw new TypeError("Permission rule path is too long");
	return canonical;
}

function boundedText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let end = maxLength - 1;
	if (/^[\uDC00-\uDFFF]$/u.test(value[end] ?? "")) end -= 1;
	return `${value.slice(0, end)}…`;
}

function detailLabel(key: string): string {
	return boundedText(
		key.replaceAll(/[_-]+/gu, " ").replace(/^./u, (character) => character.toUpperCase()),
		MAX_TOOL_NAME_LENGTH,
	);
}

function argumentPreview(key: string, value: unknown): string | undefined {
	if (SECRET_DETAIL_KEY.test(key)) return "<redacted>";
	if (["string", "number", "boolean"].includes(typeof value))
		return boundedText(String(value), MAX_DETAIL_VALUE_LENGTH);
	if (Array.isArray(value)) return `Array (${value.length} items)`;
	if (isRecord(value)) return `Object (${Object.keys(value).length} keys)`;
	return undefined;
}

function permissionRuleDetails(
	input: ProjectPermissionSignatureInput,
	normalized: {
		readonly cwd: string;
		readonly paths: readonly string[];
		readonly networkTargets: readonly { readonly host: string; readonly port: number }[];
	},
): { readonly details: readonly ProjectPermissionRuleDetail[]; readonly omittedDetails: number } {
	const details: ProjectPermissionRuleDetail[] = [];
	const seen = new Set<string>();
	let omittedDetails = 0;
	const push = (label: string, value: string) => {
		const detail = {
			label: boundedText(label, MAX_TOOL_NAME_LENGTH),
			value: boundedText(value, MAX_DETAIL_VALUE_LENGTH),
		};
		const identity = `${detail.label}\0${detail.value}`;
		if (seen.has(identity)) return;
		seen.add(identity);
		if (details.length < MAX_DETAILS) details.push(detail);
		else omittedDetails += 1;
	};

	if (input.action.command) push("Command", input.action.command);
	if (input.action.toolName === "bash") push("Working directory", normalized.cwd);
	const pathLabel = ["edit", "write", "read"].includes(input.action.toolName) ? "File" : "Path";
	for (const path of normalized.paths) push(pathLabel, path);
	for (const { host, port } of normalized.networkTargets) push("Network", `${host}:${port}`);

	const args = isRecord(input.args) ? input.args : undefined;
	if (input.action.toolName === "web_fetch" && typeof args?.url === "string") push("Address", args.url);
	if (input.action.toolName === "web_search" && typeof args?.query === "string") push("Query", args.query);
	if (["grep", "find"].includes(input.action.toolName) && typeof args?.pattern === "string")
		push("Pattern", args.pattern);
	if (input.action.provenance !== "builtin" && args) {
		for (const [key, value] of Object.entries(args)) {
			const preview = argumentPreview(key, value);
			if (preview !== undefined) push(detailLabel(key), preview);
		}
	}
	return { details, omittedDetails };
}

function normalizeInput(input: ProjectPermissionSignatureInput): {
	readonly canonical: string;
	readonly projectPath: string;
	readonly cwd: string;
	readonly paths: readonly string[];
	readonly networkTargets: readonly { readonly host: string; readonly port: number }[];
} {
	const projectPath = canonicalAbsolutePath(input.projectPath, input.projectPath);
	const cwd = canonicalAbsolutePath(input.cwd, input.cwd);
	const workspaceRoots = [...new Set(input.workspaceRoots.map((root) => canonicalAbsolutePath(root, root)))].sort();
	if (workspaceRoots.length === 0 || workspaceRoots.length > MAX_PATHS) {
		throw new TypeError("Permission rules require one to 128 workspace roots");
	}
	if (!input.action.toolName || input.action.toolName.length > MAX_TOOL_NAME_LENGTH) {
		throw new TypeError("Permission rule tool name is invalid");
	}
	if (input.action.command !== undefined && input.action.command.length > MAX_COMMAND_LENGTH) {
		throw new TypeError("Permission rule command is too long");
	}
	if (
		input.action.paths.length > MAX_PATHS ||
		input.action.risks.length === 0 ||
		input.action.risks.length > MAX_RISKS
	) {
		throw new TypeError("Permission rule action metadata exceeds its limits");
	}
	if (!input.action.risks.every((risk) => ACTION_RISKS.has(risk))) {
		throw new TypeError("Permission rule contains an invalid risk");
	}
	const paths = [...new Set(input.action.paths.map((path) => canonicalAbsolutePath(path, cwd)))].sort();
	const networkTargets = [...input.action.networkTargets]
		.map(({ host, port }) => {
			if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) {
				throw new TypeError("Permission rule network target is invalid");
			}
			return { host: host.toLowerCase(), port };
		})
		.sort((left, right) => left.host.localeCompare(right.host) || left.port - right.port);
	const signature = {
		projectPath,
		cwd,
		workspaceRoots,
		toolName: input.action.toolName,
		provenance: input.action.provenance,
		risks: [...input.action.risks],
		paths,
		networkTargets,
		command: input.action.command ?? null,
		args: canonicalJsonValue(input.args),
		executionTarget: input.executionTarget,
	};
	return { canonical: boundedCanonicalJson(signature), projectPath, cwd, paths, networkTargets };
}

function parseDetail(value: unknown): ProjectPermissionRuleDetail {
	if (
		!isRecord(value) ||
		!exactKeys(value, ["label", "value"]) ||
		typeof value.label !== "string" ||
		!value.label ||
		value.label.length > MAX_TOOL_NAME_LENGTH ||
		typeof value.value !== "string" ||
		value.value.length > MAX_DETAIL_VALUE_LENGTH
	) {
		throw new TypeError("Permission rule file contains an invalid detail");
	}
	return { label: value.label, value: value.value };
}

function parseRule(value: unknown): ProjectPermissionRuleView {
	if (
		!isRecord(value) ||
		!exactKeys(
			value,
			["id", "projectPath", "toolName", "paths", "risks", "executionTarget", "createdAt"],
			["command", "details", "omittedDetails"],
		) ||
		typeof value.id !== "string" ||
		!/^[0-9a-f]{64}$/u.test(value.id) ||
		typeof value.projectPath !== "string" ||
		typeof value.toolName !== "string" ||
		!Array.isArray(value.paths) ||
		!Array.isArray(value.risks) ||
		(value.command !== undefined && typeof value.command !== "string") ||
		(value.details !== undefined && !Array.isArray(value.details)) ||
		(value.omittedDetails !== undefined &&
			(typeof value.omittedDetails !== "number" ||
				!Number.isSafeInteger(value.omittedDetails) ||
				value.omittedDetails < 0)) ||
		(value.details === undefined) !== (value.omittedDetails === undefined) ||
		(value.executionTarget !== "sandbox" && value.executionTarget !== "host") ||
		typeof value.createdAt !== "string"
	) {
		throw new TypeError("Permission rule file contains an invalid rule");
	}
	if (
		value.projectPath.length > MAX_PATH_LENGTH ||
		!isAbsolute(value.projectPath) ||
		canonicalizeActionPath(value.projectPath, value.projectPath) !== value.projectPath ||
		!value.toolName ||
		value.toolName.length > MAX_TOOL_NAME_LENGTH ||
		(value.command !== undefined && value.command.length > MAX_COMMAND_LENGTH) ||
		(value.details !== undefined && value.details.length > MAX_DETAILS) ||
		value.paths.length > MAX_PATHS ||
		!value.paths.every(
			(path) =>
				typeof path === "string" &&
				path.length <= MAX_PATH_LENGTH &&
				isAbsolute(path) &&
				canonicalizeActionPath(path, value.projectPath as string) === path,
		) ||
		value.risks.length === 0 ||
		value.risks.length > MAX_RISKS ||
		!value.risks.every((risk) => typeof risk === "string" && ACTION_RISKS.has(risk as ActionRisk)) ||
		new Date(value.createdAt).toISOString() !== value.createdAt
	) {
		throw new TypeError("Permission rule file contains invalid bounded fields");
	}
	const details =
		value.details === undefined
			? [
					...(value.command === undefined
						? []
						: [{ label: "Command", value: boundedText(value.command, MAX_DETAIL_VALUE_LENGTH) }]),
					...value.paths.map((path) => ({
						label: "Path",
						value: boundedText(path as string, MAX_DETAIL_VALUE_LENGTH),
					})),
				]
			: value.details.map(parseDetail);
	return {
		id: value.id,
		projectPath: value.projectPath,
		toolName: value.toolName,
		...(value.command === undefined ? {} : { command: value.command }),
		paths: [...value.paths] as string[],
		details,
		omittedDetails: value.omittedDetails === undefined ? 0 : value.omittedDetails,
		risks: [...value.risks] as ActionRisk[],
		executionTarget: value.executionTarget,
		createdAt: value.createdAt,
	};
}

function parseFile(current: string | undefined): PermissionRuleFile {
	if (current === undefined) return { version: FILE_VERSION, rules: [] };
	if (Buffer.byteLength(current, "utf8") > MAX_FILE_BYTES) throw new TypeError("Permission rule file is too large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(current);
	} catch {
		throw new TypeError("Permission rule file is malformed");
	}
	if (isRecord(parsed) && Object.keys(parsed).length === 0) return { version: FILE_VERSION, rules: [] };
	if (
		!isRecord(parsed) ||
		!exactKeys(parsed, ["version", "rules"]) ||
		parsed.version !== FILE_VERSION ||
		!Array.isArray(parsed.rules)
	) {
		throw new TypeError("Permission rule file has an unsupported schema");
	}
	const rules = parsed.rules.map(parseRule);
	if (rules.length > MAX_RULES_TOTAL || new Set(rules.map((rule) => rule.id)).size !== rules.length) {
		throw new TypeError("Permission rule file exceeds its limits");
	}
	const counts = new Map<string, number>();
	for (const rule of rules) counts.set(rule.projectPath, (counts.get(rule.projectPath) ?? 0) + 1);
	if ([...counts.values()].some((count) => count > MAX_RULES_PER_PROJECT)) {
		throw new TypeError("Permission rule project exceeds its limit");
	}
	return { version: FILE_VERSION, rules };
}

function serializeFile(rules: readonly ProjectPermissionRuleView[]): string {
	const serialized = `${JSON.stringify({ version: FILE_VERSION, rules }, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) throw new TypeError("Permission rule file is too large");
	return serialized;
}

function cloneRule(rule: ProjectPermissionRuleView): ProjectPermissionRuleView {
	return {
		...rule,
		paths: [...rule.paths],
		details: rule.details.map((detail) => ({ ...detail })),
		risks: [...rule.risks],
	};
}

export class ProjectPermissionRuleStore {
	private readonly storage: FileAuthStorageBackend;

	constructor(agentDir: string) {
		this.storage = new FileAuthStorageBackend(join(agentDir, "permission-rules.json"));
	}

	match(input: ProjectPermissionSignatureInput): ProjectPermissionRuleView | undefined {
		const normalized = normalizeInput(input);
		const id = createHash("sha256").update(normalized.canonical).digest("hex");
		return this.storage.withLock((current) => {
			const rule = parseFile(current).rules.find(
				(value) => value.projectPath === normalized.projectPath && value.id === id,
			);
			return { result: rule ? cloneRule(rule) : undefined };
		});
	}

	remember(input: ProjectPermissionSignatureInput): ProjectPermissionRuleView {
		const normalized = normalizeInput(input);
		const id = createHash("sha256").update(normalized.canonical).digest("hex");
		const summary = permissionRuleDetails(input, normalized);
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const existing = file.rules.find((rule) => rule.projectPath === normalized.projectPath && rule.id === id);
			if (existing) return { result: cloneRule(existing) };
			if (file.rules.length >= MAX_RULES_TOTAL) throw new TypeError("Permission rule store is full");
			if (file.rules.filter((rule) => rule.projectPath === normalized.projectPath).length >= MAX_RULES_PER_PROJECT) {
				throw new TypeError("Permission rule project is full");
			}
			const rule: ProjectPermissionRuleView = {
				id,
				projectPath: normalized.projectPath,
				toolName: input.action.toolName,
				...(input.action.command === undefined ? {} : { command: input.action.command }),
				paths: normalized.paths,
				details: summary.details,
				omittedDetails: summary.omittedDetails,
				risks: [...input.action.risks],
				executionTarget: input.executionTarget,
				createdAt: new Date().toISOString(),
			};
			return { result: cloneRule(rule), next: serializeFile([...file.rules, rule]) };
		});
	}

	list(projectPath: string): readonly ProjectPermissionRuleView[] {
		const canonicalProject = canonicalAbsolutePath(projectPath, projectPath);
		return this.storage.withLock((current) => ({
			result: parseFile(current)
				.rules.filter((rule) => rule.projectPath === canonicalProject)
				.map(cloneRule),
		}));
	}

	delete(projectPath: string, id: string): boolean {
		const canonicalProject = canonicalAbsolutePath(projectPath, projectPath);
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const next = file.rules.filter((rule) => rule.projectPath !== canonicalProject || rule.id !== id);
			return {
				result: next.length !== file.rules.length,
				...(next.length === file.rules.length ? {} : { next: serializeFile(next) }),
			};
		});
	}

	clear(projectPath: string): number {
		const canonicalProject = canonicalAbsolutePath(projectPath, projectPath);
		return this.storage.withLock((current) => {
			const file = parseFile(current);
			const next = file.rules.filter((rule) => rule.projectPath !== canonicalProject);
			const removed = file.rules.length - next.length;
			return { result: removed, ...(removed === 0 ? {} : { next: serializeFile(next) }) };
		});
	}
}
