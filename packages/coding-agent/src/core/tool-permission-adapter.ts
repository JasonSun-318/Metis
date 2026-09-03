import type { Static, TSchema } from "typebox";
import type {
	ToolDefinition,
	ToolPermissionClaim,
	ToolPermissionContext,
	ToolPermissionDescriptor,
} from "./extensions/types.ts";
import { tokenizeShellWords } from "./permissions/auto-command-rules.ts";
import { assertCompleteAction, digestCanonical, normalizePermissionAction } from "./permissions/normalize.ts";
import { bashReferencesSensitivePath, isSensitivePath } from "./permissions/sensitive-paths.ts";
import type { NormalizedPermissionAction, ToolProvenance } from "./permissions/types.ts";

const CLAIM_KEYS = ["command", "effects", "networkEndpoints", "readPaths", "writePaths"] as const;

export interface ToolIdentityInput {
	readonly provenance: ToolProvenance;
	readonly sourceIdentity: string;
	readonly toolName: string;
	readonly implementationVersion: string;
	readonly descriptorVersion: number;
}

export interface DescribeToolActionContext extends ToolPermissionContext {
	readonly provenance: ToolProvenance;
	readonly toolIdentity: string;
}

export class ToolPermissionDescriptionError extends TypeError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolPermissionDescriptionError";
	}
}

export function permissionDescriptor<TParams>(
	describe: ToolPermissionDescriptor<TParams>["describe"],
): ToolPermissionDescriptor<TParams> {
	return Object.freeze({ version: 1, describe });
}

export function permissionClaim(input: Partial<ToolPermissionClaim> = {}): ToolPermissionClaim {
	return {
		readPaths: input.readPaths ?? [],
		writePaths: input.writePaths ?? [],
		networkEndpoints: input.networkEndpoints ?? [],
		...(input.command === undefined ? {} : { command: input.command }),
		effects: input.effects ?? [],
	};
}

export function fileReadPermissionClaim(
	path: string,
	context: ToolPermissionContext,
	options: {
		readonly traversal?: boolean;
		readonly networkEndpoints?: ToolPermissionClaim["networkEndpoints"];
	} = {},
): ToolPermissionClaim {
	return permissionClaim({
		readPaths: [path],
		networkEndpoints: options.networkEndpoints,
		effects: isSensitivePath(path, context.cwd, options.traversal === true, context.workspaceRoots)
			? ["sensitive-read"]
			: [],
	});
}

export function exactNetworkEndpoint(value: string | URL): { readonly hostname: string; readonly port: number } {
	const url = value instanceof URL ? value : new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Network URL must use HTTP(S)");
	if (url.username || url.password) throw new TypeError("Network URL must not contain credentials");
	const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
	if (!hostname || hostname.includes("*")) throw new TypeError("Network URL must name one exact host");
	const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("Network URL port is invalid");
	return Object.freeze({ hostname, port });
}

const READ_ONLY_SHELL_COMMANDS = new Set([
	"[",
	"cat",
	"cd",
	"file",
	"find",
	"grep",
	"head",
	"ls",
	"pwd",
	"rg",
	"readonly",
	"stat",
	"tail",
	"test",
	"tree",
	"wc",
]);

const NETWORK_SHELL_COMMAND =
	/\b(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet)\b|\bgit\s+(?:push|pull|fetch|clone)\b|\b(?:npm|pnpm|yarn|bun|pip|pip3|cargo|brew)\s+(?:install|add|update|publish)\b/iu;
const HTTP_URL = /https?:\/\/[^\s"'`<>|;&]+/giu;
const SSH_URL = /ssh:\/\/[^\s"'`<>|;&]+/giu;

function shellNetworkEndpoints(command: string): {
	readonly detected: boolean;
	readonly endpoints: readonly { readonly hostname: string; readonly port: number }[];
	readonly complete: boolean;
} {
	const detected = NETWORK_SHELL_COMMAND.test(command);
	if (!detected) return { detected: false, endpoints: [], complete: true };
	if (/[`$]/u.test(command)) return { detected: true, endpoints: [], complete: false };

	const endpoints: Array<{ hostname: string; port: number }> = [];
	let complete = true;
	for (const match of command.matchAll(HTTP_URL)) {
		try {
			endpoints.push(exactNetworkEndpoint(match[0]));
		} catch {
			complete = false;
		}
	}
	for (const match of command.matchAll(SSH_URL)) {
		try {
			const url = new URL(match[0]);
			if (url.password || !url.hostname || url.hostname.includes("*")) throw new TypeError("invalid SSH endpoint");
			const port = url.port ? Number(url.port) : 22;
			if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("invalid SSH port");
			endpoints.push({ hostname: url.hostname.toLowerCase().replace(/\.$/u, ""), port });
		} catch {
			complete = false;
		}
	}

	const unique = new Map(endpoints.map((endpoint) => [`${endpoint.hostname}\0${endpoint.port}`, endpoint]));
	return { detected: true, endpoints: [...unique.values()], complete: complete && unique.size > 0 };
}

function firstNonFlag(words: readonly string[], start = 1): string | undefined {
	return words.slice(start).find((word) => !word.startsWith("-"));
}

function requestMethod(words: readonly string[], flags: readonly string[]): string | undefined {
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index]!;
		for (const flag of flags) {
			if (word === flag) return words[index + 1];
			if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
			if (flag.length === 2 && word.startsWith(flag) && word.length > 2) return word.slice(2);
		}
	}
	return undefined;
}

function isSafeHttpMethod(method: string | undefined): boolean {
	return method === undefined || method === "GET" || method === "HEAD";
}

function curlMutates(words: readonly string[]): boolean {
	const method = requestMethod(words, ["-X", "--request"])?.toUpperCase();
	if (!isSafeHttpMethod(method)) return true;
	return words.some(
		(word) =>
			word === "-d" ||
			word === "-F" ||
			word === "-T" ||
			word.startsWith("--data") ||
			word.startsWith("--form") ||
			word.startsWith("--upload-file"),
	);
}

function wgetMutates(words: readonly string[]): boolean {
	const method = requestMethod(words, ["--method"])?.toUpperCase();
	if (!isSafeHttpMethod(method)) return true;
	return words.some(
		(word) =>
			word.startsWith("--post-data") ||
			word.startsWith("--post-file") ||
			word.startsWith("--body-data") ||
			word.startsWith("--body-file"),
	);
}

function shellHasKnownExternalMutation(command: string): boolean {
	if (/\bdeploy\b/iu.test(command)) return true;
	const remote = new Set(["ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet"]);
	const publishers = new Set(["npm", "pnpm", "yarn", "bun", "cargo"]);
	for (const segment of shellSegments(command)) {
		const words = tokenizeShellWords(segment).words;
		const executable = words[0]?.replace(/^.*\//u, "")?.toLowerCase();
		if (!executable) continue;
		if (remote.has(executable)) return true;
		if (executable === "git" && firstNonFlag(words) === "push") return true;
		if (publishers.has(executable) && words.slice(1).some((word) => word === "publish")) return true;
		if (executable === "curl" && curlMutates(words.slice(1))) return true;
		if (executable === "wget" && wgetMutates(words.slice(1))) return true;
	}
	return false;
}

function shellSegments(command: string): string[] {
	return command
		.split(/(?:&&|\|\||[;|\n])/u)
		.map((part) => part.trim())
		.filter(Boolean);
}

function isReadOnlyShellCommand(command: string): boolean {
	if (/[<>`]|\$\(/u.test(command)) return false;
	return shellSegments(command).every((segment) => {
		const words = segment.split(/\s+/u);
		const executable = words[0]?.replace(/^.*\//u, "");
		if (!executable) return false;
		if (READ_ONLY_SHELL_COMMANDS.has(executable)) return executable !== "sed" || !words.includes("-i");
		if (executable !== "git") return false;
		return ["diff", "log", "show", "status"].includes(words[1] ?? "");
	});
}

function recursiveDeleteTargets(command: string): string[] | undefined {
	const match = command.match(/^\s*rm\s+((?:-[^\s]+\s+)+)([^;&|\n]+)\s*$/u);
	if (!match || !/(?:^|\s)-[^\s]*r/iu.test(match[1] ?? "")) return undefined;
	const targets = (match[2] ?? "").trim().split(/\s+/u);
	if (targets.length === 0 || targets.some((target) => /[*?$`'"\\]/u.test(target))) return undefined;
	return targets;
}

function shellRedirectionScope(command: string): {
	readonly readPaths: string[];
	readonly writePaths: string[];
	readonly complete: boolean;
} {
	const readPaths: string[] = [];
	const writePaths: string[] = [];
	let complete = true;
	const redirection = /\d*(>>(?!>)|>(?!>)|<(?!<))\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|]+))/gu;
	for (const match of command.matchAll(redirection)) {
		const operator = match[1];
		const target = match[2] ?? match[3] ?? match[4] ?? "";
		if (!target || /["'`$*?[\]{}()\\]/u.test(target)) {
			complete = false;
			continue;
		}
		if (["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(target)) continue;
		(operator === "<" ? readPaths : writePaths).push(target);
	}
	const redirectionCount = [...command.matchAll(/\d*(?:>>?|<+)/gu)].filter((match) => {
		const suffix = command.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 1);
		return suffix !== "&";
	}).length;
	if (redirectionCount > readPaths.length + writePaths.length) complete = false;
	return { readPaths, writePaths, complete };
}

function filesystemOperand(word: string): string | undefined {
	let value = word;
	const equals = value.indexOf("=");
	if (equals >= 0) value = value.slice(equals + 1);
	if (!value || /^(?:https?|ssh|git):\/\//iu.test(value)) return undefined;
	return /^(?:\/|\.\.?[/\\]|~[/\\])/u.test(value) || /[/\\]/u.test(value) ? value : undefined;
}

function bindManagedWorkOperand(word: string, managedWorkDir: string | undefined): string {
	if (!managedWorkDir) return word;
	const match = word.match(/^\$(?:\{(METIS_WORK_DIR|TMPDIR|TMP|TEMP)\}|(METIS_WORK_DIR|TMPDIR|TMP|TEMP))(.*)$/u);
	if (!match) return word;
	return `${managedWorkDir}${match[3] ?? ""}`;
}

function shellOperandScope(
	command: string,
	managedWorkDir?: string,
): {
	readonly readPaths: string[];
	readonly writePaths: string[];
	readonly complete: boolean;
} {
	const readPaths: string[] = [];
	const writePaths: string[] = [];
	let complete = true;
	const withoutRedirections = command.replace(
		/\d*(?:>>(?!>)|>(?!>)|<(?!<))\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gu,
		" ",
	);
	const pathWriters = new Set([
		"chmod",
		"chown",
		"chgrp",
		"mkdir",
		"rm",
		"rmdir",
		"shred",
		"tee",
		"touch",
		"truncate",
	]);
	for (const segment of shellSegments(withoutRedirections)) {
		const parsed = tokenizeShellWords(segment);
		if (!parsed.complete) complete = false;
		const executable = parsed.words[0]?.replace(/^.*\//u, "");
		if (!executable) continue;
		const argumentWords = parsed.words.slice(1).map((word) => bindManagedWorkOperand(word, managedWorkDir));
		const operands = argumentWords.map(filesystemOperand).filter((value): value is string => value !== undefined);
		const fileCommand =
			READ_ONLY_SHELL_COMMANDS.has(executable) ||
			pathWriters.has(executable) ||
			["cp", "dd", "install", "mv", "sed"].includes(executable) ||
			executable === "git";
		const dynamicPath = fileCommand && argumentWords.some((value) => /[`$*?[\]{}()]/u.test(value));
		if (dynamicPath) {
			complete = false;
		}
		if (
			READ_ONLY_SHELL_COMMANDS.has(executable) ||
			(executable === "git" && ["diff", "log", "show", "status"].includes(parsed.words[1] ?? ""))
		) {
			readPaths.push(...operands);
			continue;
		}
		if (pathWriters.has(executable)) {
			writePaths.push(...operands);
			continue;
		}
		if (executable === "cp" || executable === "install") {
			if (
				argumentWords.some(
					(word) => word === "-t" || word === "--target-directory" || word.startsWith("--target-directory="),
				)
			) {
				complete = false;
			}
			const positional = argumentWords.filter((word) => !word.startsWith("-") && !/[`$*?[\]{}()]/u.test(word));
			if (
				executable === "install" &&
				argumentWords.some(
					(word) =>
						word === "--directory" || (word.startsWith("-") && !word.startsWith("--") && word.includes("d")),
				)
			) {
				for (const target of positional) {
					const path = filesystemOperand(target);
					if (path) writePaths.push(path);
				}
				continue;
			}
			for (const source of positional.slice(0, -1)) {
				const path = filesystemOperand(source);
				if (path) readPaths.push(path);
			}
			const target = filesystemOperand(positional.at(-1) ?? "");
			if (target) writePaths.push(target);
			continue;
		}
		if (executable === "mv") {
			writePaths.push(...operands);
			continue;
		}
		if (executable === "dd") {
			for (const word of parsed.words.slice(1)) {
				if (word.startsWith("if=")) readPaths.push(word.slice(3));
				if (word.startsWith("of=")) writePaths.push(word.slice(3));
			}
			continue;
		}
		if (executable === "sed" && parsed.words.some((word) => word === "-i" || word.startsWith("-i"))) {
			writePaths.push(...operands);
			continue;
		}
		if (operands.length > 0) complete = false;
	}
	return { readPaths, writePaths, complete };
}

export function bashPermissionClaim(command: string, context: ToolPermissionContext): ToolPermissionClaim {
	const effects = new Set<ToolPermissionClaim["effects"][number]>();
	const lower = command.toLowerCase().replaceAll("\\", "/");
	const network = shellNetworkEndpoints(command);
	const redirections = shellRedirectionScope(command);
	const operands = shellOperandScope(command, context.managedWorkDir);
	if (bashReferencesSensitivePath(command)) {
		effects.add("sensitive-read");
	}
	if (/\b(?:sudo|doas|pkexec)\b/u.test(lower)) effects.add("elevation");
	if (/\b(?:chmod\s+(?:-r\s+)?(?:777|a\+rwx)|spctl\s+--master-disable)\b/u.test(lower)) {
		effects.add("security-weakening");
	}
	if (
		/\b(?:rm|rmdir|shred|truncate|dd|mkfs|del|erase|format)\b/iu.test(command) ||
		/\bfind\b[^\n]*\s-delete\b/iu.test(command) ||
		/\bgit\s+(?:reset\s+--hard|clean\b)/iu.test(command) ||
		/\b(?:kill|pkill|killall|reboot|shutdown)\b/iu.test(command) ||
		/\b(?:chmod|chown|chgrp)\b/iu.test(command)
	) {
		effects.add("destructive");
	}
	if (/\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\bdeploy\b/iu.test(command)) {
		effects.add("external-side-effect");
	}
	if (/\bdeploy\b[^\n]*(?:prod|production)\b|\b(?:prod|production)\b[^\n]*\bdeploy\b/iu.test(command)) {
		effects.add("production-mutation");
	}
	if (network.detected && !network.complete) effects.add("unknown");
	if (shellHasKnownExternalMutation(command)) effects.add("external-side-effect");
	if (!redirections.complete || !operands.complete) effects.add("unknown");
	const deleteTargets = recursiveDeleteTargets(command);
	if (deleteTargets) effects.add("destructive");
	return permissionClaim({
		readPaths: [...context.workspaceRoots, ...redirections.readPaths, ...operands.readPaths],
		writePaths: deleteTargets ?? [
			...(isReadOnlyShellCommand(command) ? [] : context.workspaceRoots),
			...redirections.writePaths,
			...operands.writePaths,
		],
		networkEndpoints: network.endpoints,
		command,
		effects: [...effects],
	});
}

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
	if (value.includes("\0")) throw new TypeError(`${field} must not contain NUL bytes`);
	return value.trim();
}

export function createToolIdentity(input: ToolIdentityInput): string {
	const identity = {
		version: 1,
		provenance: input.provenance,
		sourceIdentity: nonEmpty(input.sourceIdentity, "sourceIdentity"),
		toolName: nonEmpty(input.toolName, "toolName"),
		implementationVersion: nonEmpty(input.implementationVersion, "implementationVersion"),
		descriptorVersion: input.descriptorVersion,
	};
	if (!Number.isSafeInteger(identity.descriptorVersion) || identity.descriptorVersion < 1) {
		throw new TypeError("descriptorVersion must be a positive integer");
	}
	return `tool:v1:${digestCanonical(identity)}`;
}

export function assertToolPermissionDescriptor(
	definition: Pick<ToolDefinition<any, any, any>, "name"> & { readonly permission?: unknown },
): asserts definition is Pick<ToolDefinition<any, any, any>, "name" | "permission"> {
	const descriptor = definition.permission as Partial<ToolPermissionDescriptor<unknown>> | undefined;
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		descriptor.version !== 1 ||
		typeof descriptor.describe !== "function"
	) {
		throw new TypeError(`Executable tool ${definition.name} requires a permission descriptor`);
	}
}

function copyClaim(value: unknown): ToolPermissionClaim {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("Permission action scope is incomplete");
	}
	const record = value as Record<string, unknown>;
	const actualKeys = Object.keys(record).sort();
	const expectedKeys = CLAIM_KEYS.filter((key) => key !== "command" || record.command !== undefined).sort();
	if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
		throw new TypeError("Permission action scope is incomplete");
	}
	if (
		!Array.isArray(record.readPaths) ||
		!Array.isArray(record.writePaths) ||
		!Array.isArray(record.networkEndpoints) ||
		!Array.isArray(record.effects)
	) {
		throw new TypeError("Permission action scope is incomplete");
	}
	return {
		readPaths: [...record.readPaths] as string[],
		writePaths: [...record.writePaths] as string[],
		networkEndpoints: (record.networkEndpoints as Array<{ hostname: string; port: number }>).map(
			({ hostname, port }) => ({ hostname, port }),
		),
		...(record.command === undefined ? {} : { command: record.command as string }),
		effects: [...record.effects] as ToolPermissionClaim["effects"],
	};
}

export function describeToolAction<TParams extends TSchema>(
	definition: ToolDefinition<TParams, any, any>,
	params: Static<TParams>,
	context: DescribeToolActionContext,
): NormalizedPermissionAction {
	try {
		assertToolPermissionDescriptor(definition);
		const claim = copyClaim(definition.permission.describe(params, context));
		const action = normalizePermissionAction({
			actionId: context.actionId,
			toolName: definition.name,
			provenance: context.provenance,
			toolIdentity: context.toolIdentity,
			args: params,
			cwd: context.cwd,
			workspaceRoots: context.workspaceRoots,
			...claim,
		});
		assertCompleteAction(action);
		return action;
	} catch (error) {
		if (error instanceof ToolPermissionDescriptionError) throw error;
		const message =
			error instanceof TypeError &&
			/scope is incomplete|^network (?:hostname|url|endpoint|port)\b/iu.test(error.message)
				? error.message
				: `Permission action could not be described for ${definition.name}`;
		throw new ToolPermissionDescriptionError(message, { cause: error });
	}
}
