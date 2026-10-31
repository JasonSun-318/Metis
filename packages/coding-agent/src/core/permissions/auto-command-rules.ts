/** Exact network destination allowed by an Auto command rule. */
export interface AutoCommandNetworkTarget {
	readonly hostname: string;
	readonly port: number;
}

export interface AutoCommandRule {
	readonly command: string;
	readonly allowNetwork: boolean;
	readonly networkTargets?: readonly AutoCommandNetworkTarget[];
}

export const MAX_AUTO_COMMAND_RULES = 64;
export const MAX_AUTO_COMMAND_LENGTH = 256;
export const MAX_AUTO_COMMAND_NETWORK_TARGETS = 32;

export const DEFAULT_AUTO_COMMAND_SUGGESTIONS = Object.freeze([
	"cd",
	"pwd",
	"ls",
	"cat",
	"head",
	"tail",
	"dirname",
	"basename",
	"which",
	"file",
	"find",
	"stat",
	"tree",
	"du",
	"df",
	"grep",
	"wc",
	"sort",
	"uniq",
	"cut",
	"rg",
	"echo",
	"printf",
	"date",
	"sleep",
	"whoami",
	"id",
	"uname",
	"printenv",
	"git status",
	"git diff",
	"git log",
	"git show",
	"docker ps",
	"docker images",
	"docker logs",
	"docker inspect",
	"docker compose ps",
	"docker compose logs",
	"docker compose config",
] as const);

export function tokenizeShellWords(source: string): { readonly words: readonly string[]; readonly complete: boolean } {
	const words: string[] = [];
	let word = "";
	let wordStarted = false;
	let quote: "'" | '"' | undefined;
	let complete = true;
	const flush = () => {
		if (wordStarted) words.push(word);
		word = "";
		wordStarted = false;
	};
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (quote) {
			if (character === quote) quote = undefined;
			else if (character === "\\" && quote === '"' && index + 1 < source.length) {
				const escaped = source[++index]!;
				if (escaped === "\n") continue;
				word += ['"', "\\", "$", "`"].includes(escaped) ? escaped : `\\${escaped}`;
			} else word += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			wordStarted = true;
			continue;
		}
		if (character === "\\") {
			if (index + 1 >= source.length) {
				complete = false;
				continue;
			}
			const escaped = source[++index]!;
			if (escaped === "\n") continue;
			wordStarted = true;
			word += escaped;
			continue;
		}
		if (/\s/u.test(character)) flush();
		else {
			wordStarted = true;
			word += character;
		}
	}
	if (quote) complete = false;
	flush();
	return { words, complete };
}

/** Split on `&&`, `||`, `;`, `|`, and newlines without cutting inside quotes. */
export function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			else if (character === "\\" && quote === '"' && index + 1 < command.length) current += command[++index]!;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			current += character;
			continue;
		}
		if (character === "\\") {
			current += character;
			if (index + 1 < command.length) current += command[++index]!;
			continue;
		}
		if (character === "\n" || character === ";") {
			flush();
			continue;
		}
		if (character === "&" && command[index + 1] === "&") {
			flush();
			index += 1;
			continue;
		}
		if (character === "|") {
			if (command[index + 1] === "|") index += 1;
			flush();
			continue;
		}
		current += character;
	}
	flush();
	return segments;
}

function isSimpleShellSource(source: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (character === '"') quote = undefined;
			else if (character === "\\" && index + 1 < source.length) index += 1;
			else if (character === "$" || character === "`" || character === "\n" || character === "\r") return false;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "\\") {
			if (index + 1 >= source.length) return false;
			index += 1;
			continue;
		}
		if (
			character === "$" ||
			character === "`" ||
			character === ";" ||
			character === "|" ||
			character === "&" ||
			character === "<" ||
			character === ">" ||
			character === "#" ||
			character === "\n" ||
			character === "\r"
		) {
			return false;
		}
	}
	return quote === undefined;
}

export function parseSimpleShellCommand(
	source: string,
	maxBytes = MAX_AUTO_COMMAND_LENGTH,
): readonly string[] | undefined {
	if (typeof source !== "string" || source.length === 0) return undefined;
	if (Buffer.byteLength(source, "utf8") > maxBytes) return undefined;
	if (!isSimpleShellSource(source)) return undefined;
	const parsed = tokenizeShellWords(source);
	if (!parsed.complete || parsed.words.length === 0) return undefined;
	return parsed.words;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((word, index) => word === right[index]);
}

function isArgvPrefix(prefix: readonly string[], command: readonly string[]): boolean {
	return prefix.length <= command.length && prefix.every((word, index) => word === command[index]);
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isExactNetworkHostname(hostname: string): boolean {
	if (hostname.length === 0 || hostname.length > 253) return false;
	return hostname.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

export function normalizeNetworkTargets(value: unknown): readonly AutoCommandNetworkTarget[] {
	if (!Array.isArray(value)) throw new TypeError("Auto command network targets must be an array");
	if (value.length > MAX_AUTO_COMMAND_NETWORK_TARGETS) {
		throw new TypeError("too many Auto command network targets");
	}
	const seen = new Set<string>();
	const targets: AutoCommandNetworkTarget[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) throw new TypeError("invalid Auto command network target");
		const keys = Object.keys(entry);
		if (
			keys.length !== 2 ||
			!keys.includes("hostname") ||
			!keys.includes("port") ||
			typeof entry.hostname !== "string" ||
			typeof entry.port !== "number" ||
			!Number.isInteger(entry.port) ||
			entry.port < 1 ||
			entry.port > 65_535
		) {
			throw new TypeError("invalid Auto command network target");
		}
		const hostname = entry.hostname.toLowerCase();
		if (!isExactNetworkHostname(hostname)) throw new TypeError("invalid Auto command network target");
		const key = `${hostname}:${entry.port}`;
		if (seen.has(key)) throw new TypeError("duplicate Auto command network target");
		seen.add(key);
		targets.push(Object.freeze({ hostname, port: entry.port }));
	}
	return Object.freeze(targets);
}

export function normalizeAutoCommandRules(value: unknown): readonly AutoCommandRule[] {
	if (!Array.isArray(value)) throw new TypeError("Auto command rules must be an array");
	if (value.length > MAX_AUTO_COMMAND_RULES) throw new TypeError("too many Auto command rules");
	const seen: string[][] = [];
	const rules: AutoCommandRule[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) throw new TypeError("invalid Auto command rule");
		const keys = Object.keys(entry);
		const hasNetworkTargets = keys.includes("networkTargets");
		if (
			keys.length !== (hasNetworkTargets ? 3 : 2) ||
			!keys.includes("command") ||
			!keys.includes("allowNetwork") ||
			typeof entry.command !== "string" ||
			typeof entry.allowNetwork !== "boolean"
		) {
			throw new TypeError("invalid Auto command rule");
		}
		const networkTargets = hasNetworkTargets ? normalizeNetworkTargets(entry.networkTargets) : undefined;
		const argv = parseSimpleShellCommand(entry.command);
		if (!argv) throw new TypeError("invalid Auto command rule");
		if (argv.some((token) => /\s/u.test(token))) {
			throw new TypeError("rule tokens must not contain whitespace");
		}
		if (seen.some((existing) => sameArgv(existing, argv))) {
			throw new TypeError("duplicate Auto command rule");
		}
		seen.push([...argv]);
		rules.push(
			Object.freeze({
				command: argv.join(" "),
				allowNetwork: entry.allowNetwork,
				...(networkTargets ? { networkTargets } : {}),
			}),
		);
	}
	return Object.freeze(rules);
}

/**
 * Legacy single-rule lookup over raw command text. Kept for configuration and
 * compat queries with its original 256-byte parseSimpleShellCommand semantics;
 * the authorization path must use matchingAutoCommandRules over trusted
 * per-node analysis instead, so this can never widen what executes.
 */
export function matchAutoCommandRule(command: string, rules: readonly AutoCommandRule[]): AutoCommandRule | undefined {
	const argv = parseSimpleShellCommand(command);
	if (!argv) return undefined;
	return [...matchingAutoCommandRules(argv, rules)]
		.sort(
			(left, right) =>
				(parseSimpleShellCommand(right.command)?.length ?? 0) -
				(parseSimpleShellCommand(left.command)?.length ?? 0),
		)
		.at(0);
}

/**
 * A configured rule joined with the argv prefix parsed from it, so one policy
 * evaluation can reuse the parse for every analyzed command node.
 */
export interface CompiledAutoCommandRule {
	readonly rule: AutoCommandRule;
	readonly prefix: readonly string[];
}

export function compileAutoCommandRules(rules: readonly AutoCommandRule[]): readonly CompiledAutoCommandRule[] {
	const compiled: CompiledAutoCommandRule[] = [];
	for (const rule of rules) {
		const prefix = parseSimpleShellCommand(rule.command);
		if (prefix) compiled.push(Object.freeze({ rule, prefix }));
	}
	return Object.freeze(compiled);
}

/**
 * Match a configured rule's argv prefix against one analyzed command node.
 * The rule config keeps its own 256-byte validated form; the executing command
 * is compared per analyzed AST node, never by re-parsing raw command text.
 */
export function matchingAutoCommandRules(
	argv: readonly string[],
	rules: readonly AutoCommandRule[],
): readonly AutoCommandRule[] {
	return matchingCompiledAutoCommandRules(argv, compileAutoCommandRules(rules));
}

/** Match one analyzed command node against prefixes compiled once for this evaluation. */
export function matchingCompiledAutoCommandRules(
	argv: readonly string[],
	compiled: readonly CompiledAutoCommandRule[],
): readonly AutoCommandRule[] {
	return compiled.filter(({ prefix }) => isArgvPrefix(prefix, argv)).map(({ rule }) => rule);
}
