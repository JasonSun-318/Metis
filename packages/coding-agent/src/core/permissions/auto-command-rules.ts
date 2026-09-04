export interface AutoCommandRule {
	readonly command: string;
	readonly allowNetwork: boolean;
}

export const MAX_AUTO_COMMAND_RULES = 64;
export const MAX_AUTO_COMMAND_LENGTH = 256;

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

export function parseSimpleShellCommand(source: string): readonly string[] | undefined {
	if (typeof source !== "string" || source.length === 0) return undefined;
	if (Buffer.byteLength(source, "utf8") > MAX_AUTO_COMMAND_LENGTH) return undefined;
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

export function normalizeAutoCommandRules(value: unknown): readonly AutoCommandRule[] {
	if (!Array.isArray(value)) throw new TypeError("Auto command rules must be an array");
	if (value.length > MAX_AUTO_COMMAND_RULES) throw new TypeError("too many Auto command rules");
	const seen: string[][] = [];
	const rules: AutoCommandRule[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) throw new TypeError("invalid Auto command rule");
		const keys = Object.keys(entry);
		if (
			keys.length !== 2 ||
			!keys.includes("command") ||
			!keys.includes("allowNetwork") ||
			typeof entry.command !== "string" ||
			typeof entry.allowNetwork !== "boolean"
		) {
			throw new TypeError("invalid Auto command rule");
		}
		const argv = parseSimpleShellCommand(entry.command);
		if (!argv) throw new TypeError("invalid Auto command rule");
		if (argv.some((token) => /\s/u.test(token))) {
			throw new TypeError("rule tokens must not contain whitespace");
		}
		if (seen.some((existing) => sameArgv(existing, argv))) {
			throw new TypeError("duplicate Auto command rule");
		}
		seen.push([...argv]);
		rules.push(Object.freeze({ command: argv.join(" "), allowNetwork: entry.allowNetwork }));
	}
	return Object.freeze(rules);
}

export function matchAutoCommandRule(command: string, rules: readonly AutoCommandRule[]): AutoCommandRule | undefined {
	const argv = parseSimpleShellCommand(command);
	if (!argv) return undefined;
	return rules
		.map((rule) => ({ rule, prefix: parseSimpleShellCommand(rule.command) }))
		.filter(
			(entry): entry is { rule: AutoCommandRule; prefix: readonly string[] } =>
				entry.prefix !== undefined && isArgvPrefix(entry.prefix, argv),
		)
		.sort((left, right) => right.prefix.length - left.prefix.length)[0]?.rule;
}
