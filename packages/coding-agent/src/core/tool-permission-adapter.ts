import { homedir } from "node:os";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import type {
	ToolDefinition,
	ToolPermissionClaim,
	ToolPermissionContext,
	ToolPermissionDescriptor,
} from "./extensions/types.ts";
import { splitShellSegments, tokenizeShellWords } from "./permissions/auto-command-rules.ts";
import { assertWellFormedAction, digestCanonical, normalizePermissionAction } from "./permissions/normalize.ts";
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
	"echo",
	"file",
	"find",
	"grep",
	"head",
	"ls",
	"printf",
	"pwd",
	"rg",
	"readonly",
	"stat",
	"tail",
	"test",
	"tree",
	"wc",
]);
const FD_OR_NULL_REDIRECT = /\d*(?:>>?|<)&\d+|\d*(?:>>?|<)\s*\/dev\/(?:null|stdin|stdout|stderr)\b/gu;

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

function requestMethod(words: readonly string[], flags: readonly string[]): string | undefined {
	let method: string | undefined;
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index]!;
		for (const flag of flags) {
			if (word === flag) {
				method = words[index + 1];
				index += 1;
				break;
			}
			if (word.startsWith(`${flag}=`)) method = word.slice(flag.length + 1);
			else if (flag.length === 2 && word.startsWith(flag) && word.length > 2) method = word.slice(2);
		}
	}
	return method;
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
			word === "-K" ||
			word === "-T" ||
			(/^-[^-]/u.test(word) && /[dFT]/u.test(word.slice(1))) ||
			word.startsWith("-K") ||
			word === "--config" ||
			word.startsWith("--config=") ||
			word === "--json" ||
			word.startsWith("--json=") ||
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
			word === "--config" ||
			word.startsWith("--config=") ||
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
		for (let index = 0; index < words.length; index += 1) {
			const executable = words[index]?.replace(/^.*\//u, "")?.toLowerCase();
			if (!executable) continue;
			const args = words.slice(index + 1);
			if (remote.has(executable)) return true;
			if (executable === "git" && args.includes("push")) return true;
			if (publishers.has(executable) && args.includes("publish")) return true;
			if (executable === "curl" && curlMutates(args)) return true;
			if (executable === "wget" && wgetMutates(args)) return true;
		}
	}
	return false;
}

function shellSegments(command: string): string[] {
	return splitShellSegments(command);
}

function isReadOnlyShellCommand(command: string): boolean {
	const stripped = command.replace(FD_OR_NULL_REDIRECT, " ");
	if (/[<>`]|\$\(/u.test(stripped)) return false;
	return shellSegments(stripped).every((segment) => {
		const words = segment.split(/\s+/u);
		const executable = words[0]?.replace(/^.*\//u, "");
		if (!executable) return false;
		if (READ_ONLY_SHELL_COMMANDS.has(executable)) return executable !== "sed" || !words.includes("-i");
		if (executable !== "git") return false;
		return ["diff", "log", "show", "status"].includes(words[1] ?? "");
	});
}

function commandHasDestructiveExecutable(command: string): boolean {
	return splitShellSegments(command).some((segment) => {
		const words = tokenizeShellWords(segment).words;
		const executable = words[0]?.replace(/^.*\//u, "").toLowerCase();
		if (!executable) return false;
		if (
			["rm", "rmdir", "remove-item", "shred", "truncate", "dd", "mkfs", "del", "erase", "format"].includes(
				executable,
			)
		) {
			return true;
		}
		if (executable === "find") return words.includes("-delete");
		if (executable === "git") {
			return words[1] === "clean" || (words[1] === "reset" && words.includes("--hard"));
		}
		return ["kill", "pkill", "killall", "reboot", "shutdown", "chmod", "chown", "chgrp"].includes(executable);
	});
}

function recursiveDeleteTargets(command: string): string[] | undefined {
	const match = command.match(/^\s*rm\s+((?:-[^\s]+\s+)+)([^;&|\n]+)\s*$/u);
	if (!match || !/(?:^|\s)-[^\s]*r/iu.test(match[1] ?? "")) return undefined;
	const targets = (match[2] ?? "").trim().split(/\s+/u);
	if (targets.length === 0 || targets.some((target) => /[*?$`'"\\]/u.test(target))) return undefined;
	return targets.map((target) => filesystemOperand(target) ?? target);
}

function isDiscardRedirectionTarget(target: string): boolean {
	return /^&\d+$/u.test(target) || ["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"].includes(target);
}

function globDirectory(path: string): string | undefined {
	const index = path.search(/[*?[]/u);
	if (index < 0) return undefined;
	const prefix = path.slice(0, index);
	const separator = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
	if (separator <= 0) return prefix.startsWith("/") || prefix.startsWith("\\") ? prefix.slice(0, 1) : undefined;
	return prefix.slice(0, separator);
}

function shellRedirectionScope(command: string): {
	readonly readPaths: string[];
	readonly writePaths: string[];
	readonly complete: boolean;
} {
	const readPaths: string[] = [];
	const writePaths: string[] = [];
	let complete = true;
	let resolved = 0;
	const redirection = /\d*(>>(?!>)|>(?!>)|<(?!<))\s*(?:"([^"\n]*)"|'([^'\n]*)'|(&\d+)|([^\s;&|]+))/gu;
	for (const match of command.matchAll(redirection)) {
		const operator = match[1];
		const target = match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
		if (isDiscardRedirectionTarget(target)) {
			resolved += 1;
			continue;
		}
		if (!target || /["'`$*?[\]{}()\\]/u.test(target)) {
			complete = false;
			continue;
		}
		(operator === "<" ? readPaths : writePaths).push(target);
		resolved += 1;
	}
	if ([...command.matchAll(/\d*(?:>>?|<+)/gu)].length > resolved) complete = false;
	return { readPaths, writePaths, complete };
}

function filesystemOperand(word: string): string | undefined {
	let value = word;
	const equals = value.indexOf("=");
	if (equals >= 0) value = value.slice(equals + 1);
	if (!value || /^(?:https?|ssh|git):\/\//iu.test(value)) return undefined;
	if (value === "~") return homedir();
	if (/^~[/\\]/u.test(value)) value = join(homedir(), value.slice(2));
	return /^(?:\/|\.\.?[/\\])/u.test(value) || /[/\\]/u.test(value) ? value : undefined;
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
	const barePathWriters = new Set(["mkdir", "rm", "rmdir", "shred", "tee", "touch", "truncate"]);
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
		const readCommand =
			READ_ONLY_SHELL_COMMANDS.has(executable) ||
			(executable === "git" && ["diff", "log", "show", "status"].includes(parsed.words[1] ?? ""));
		const hasShellExpansion = argumentWords.some((value) => /[`$(){}]/u.test(value));
		const hasGlob = argumentWords.some((value) => /[*?[]/u.test(value));
		if (fileCommand && (hasShellExpansion || (hasGlob && !readCommand))) complete = false;
		if (readCommand) {
			if (
				executable === "find" &&
				argumentWords.some((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir")
			) {
				complete = false;
			}
			for (const word of argumentWords) {
				const path = filesystemOperand(word);
				if (!path) continue;
				readPaths.push(globDirectory(path) ?? path);
			}
			continue;
		}
		if (pathWriters.has(executable)) {
			let endFlags = false;
			for (const word of argumentWords) {
				if (!endFlags && word === "--") {
					endFlags = true;
					continue;
				}
				if (!endFlags && word.startsWith("-") && word !== "-") continue;
				const path = filesystemOperand(word);
				if (path) writePaths.push(path);
				else if (barePathWriters.has(executable)) writePaths.push(word);
			}
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
		if (operands.length > 0) {
			if (argumentWords.some((value) => /[`$*?[\]{}()]/u.test(value))) complete = false;
			else writePaths.push(...operands);
		}
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
	if (splitShellSegments(command).some((segment) => /^\s*(?:sudo|doas|pkexec)\b/iu.test(segment))) {
		effects.add("elevation");
	}
	if (/\b(?:chmod\s+(?:-r\s+)?(?:777|a\+rwx)|spctl\s+--master-disable)\b/u.test(lower)) {
		effects.add("security-weakening");
	}
	if (commandHasDestructiveExecutable(command)) {
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
		assertWellFormedAction(action);
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
