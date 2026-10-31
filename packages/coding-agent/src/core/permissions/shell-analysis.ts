import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Node } from "@vscode/tree-sitter-wasm";
import { Minimatch } from "minimatch";
import { canonicalizeActionPath, isPathInside } from "../../utils/paths.ts";
import { analyzeCurlCommand, analyzeGitCommand } from "./git-curl-semantics.ts";
import { gitImplicitExecutionReasons } from "./git-implicit-config.ts";
import { type OptionScan, type OptionSpec, type ShellValue, scanCommandOptions } from "./option-scanner.ts";
import { analyzeInlineScript, type InlineScriptLanguage } from "./script-analysis.ts";
import { isSensitivePath } from "./sensitive-paths.ts";
import { parseShellSyntax } from "./shell-parser.ts";
import type { NetworkEndpoint, PermissionEffect, ShellAnalysisDisposition, ShellCommandTraceEntry } from "./types.ts";

export interface ShellAnalysisInput {
	readonly command: string;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots?: readonly string[];
	readonly shellPath: string;
}

export interface ShellCommandAnalysis {
	readonly disposition: ShellAnalysisDisposition;
	readonly complete: boolean;
	readonly reason: string;
	readonly readPaths: readonly string[];
	readonly writePaths: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
	readonly effects: readonly PermissionEffect[];
	readonly commands: readonly ShellCommandTraceEntry[];
}

export type ShellDisposition = ShellCommandAnalysis["disposition"];
export type { ShellValue } from "./option-scanner.ts";

const ANALYSIS_BUDGET_MS = 100;
const MAX_STEPS = 100_000;
const MAX_TRACE_ENTRIES = 1_000;
const DISPOSITION_ORDER = { safe: 0, review: 1, user: 2, deny: 3 } as const;
const PROTECTED_WORKSPACE_ENTRIES = [".git", ".metis", ".codex", ".agents"] as const;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
	"BASHOPTS",
	"BASH_ENV",
	"CDPATH",
	"ENV",
	"GLOBIGNORE",
	"IFS",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PATH",
	"PROMPT_COMMAND",
	"PS4",
	"PYTHONHOME",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"SHELLOPTS",
]);
const FORBIDDEN_ENVIRONMENT_PREFIXES = ["DYLD_"] as const;
const PYTHON_FLAGS = new Set(["-B", "-E", "-I", "-O", "-OO", "-q", "-S", "-s", "-u"]);
const PYTHON_ISOLATION_FLAGS = ["-I", "-S"] as const;
const NODE_FLAGS = new Set(["--no-deprecation", "--no-warnings"]);
const WRITE_COMMANDS = new Set(["cp", "install", "ln", "mkdir", "mv", "touch"]);
const DESTRUCTIVE_COMMANDS = new Set(["chmod", "chgrp", "chown", "dd", "mkfs", "rmdir", "shred", "truncate"]);
const UNKNOWN_EXECUTION_COMMANDS = new Set([
	"bash",
	"bun",
	"cargo",
	"cmd",
	"dash",
	"deno",
	"docker",
	"fish",
	"go",
	"gradle",
	"kubectl",
	"make",
	"mvn",
	"npx",
	"npm",
	"perl",
	"php",
	"pip",
	"pip3",
	"pnpm",
	"podman",
	"powershell",
	"pwsh",
	"ruby",
	"ruby3",
	"sh",
	"ssh",
	"terraform",
	"wget",
	"yarn",
	"zsh",
]);
const WRAPPER_COMMANDS = new Set([
	"builtin",
	"command",
	"env",
	"nice",
	"nohup",
	"stdbuf",
	"time",
	"timeout",
	"watch",
	"xargs",
]);
const SHELL_STATE_COMMANDS = new Set([
	"alias",
	"bg",
	"bind",
	"complete",
	"compopt",
	"declare",
	"enable",
	"fc",
	"fg",
	"hash",
	"history",
	"jobs",
	"local",
	"logout",
	"mapfile",
	"popd",
	"pushd",
	"read",
	"readarray",
	"readonly",
	"set",
	"shopt",
	"source",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"wait",
]);
const DESTRUCTIVE_BUILTINS = new Set(["kill", "killall", "pkill"]);
const REDIRECT_WRITE_OPERATORS = new Set([">", ">>", ">|", "&>", "&>>"]);
const REDIRECT_READ_OPERATORS = new Set(["<"]);
const REDIRECT_READ_WRITE_OPERATORS = new Set(["<>"]);
/** File-condition operators whose next operand is a read path. */
const FILE_TEST_UNARY = new Set([
	"-a",
	"-b",
	"-c",
	"-d",
	"-e",
	"-f",
	"-g",
	"-h",
	"-k",
	"-L",
	"-N",
	"-O",
	"-p",
	"-r",
	"-S",
	"-s",
	"-u",
	"-w",
	"-x",
]);
const FILE_TEST_BINARY = new Set(["-ef", "-nt", "-ot"]);
/** Assignment values containing these nodes are expansions, not static text. */
const DYNAMIC_ASSIGNMENT_NODES = new Set([
	"simple_expansion",
	"expansion",
	"command_substitution",
	"process_substitution",
	"arithmetic_expansion",
	"ansi_c_string",
	"translated_string",
]);

interface Facts {
	disposition: ShellDisposition;
	complete: boolean;
	reason?: string;
	readPaths: Set<string>;
	writePaths: Set<string>;
	endpoints: Map<string, NetworkEndpoint>;
	effects: Set<PermissionEffect>;
	commands: ShellCommandTraceEntry[];
}

/** Per-command facts collected while a single command node is dispatched. */
interface CommandFacts {
	effects: Set<PermissionEffect>;
	endpoints: Map<string, NetworkEndpoint>;
}

export interface ShellState {
	cwd: string | undefined;
	vars: Map<string, string | undefined>;
}

interface TestToken {
	readonly operator: boolean;
	readonly value: ShellValue;
}

interface HeredocInfo {
	readonly source: string;
	readonly literal: boolean;
	readonly fd?: string;
}

const DYNAMIC: ShellValue = { dynamic: true, glob: false };

function namedChildren(node: Node): Node[] {
	const children: Node[] = [];
	for (let index = 0; index < node.namedChildCount; index += 1) {
		const child = node.namedChild(index);
		if (child) children.push(child);
	}
	return children;
}

function firstNamedChild(node: Node): Node | undefined {
	return namedChildren(node)[0];
}

function childOfType(node: Node, ...types: readonly string[]): Node | undefined {
	return namedChildren(node).find((child) => types.includes(child.type));
}

function emptyFacts(): Facts {
	return {
		disposition: "safe",
		complete: true,
		readPaths: new Set(),
		writePaths: new Set(),
		endpoints: new Map(),
		effects: new Set(),
		commands: [],
	};
}

export function mergeShellDisposition(values: readonly ShellDisposition[]): ShellDisposition {
	return values.reduce<ShellDisposition>(
		(current, value) => (DISPOSITION_ORDER[value] > DISPOSITION_ORDER[current] ? value : current),
		"safe",
	);
}

function cloneState(state: ShellState): ShellState {
	return { cwd: state.cwd, vars: new Map(state.vars) };
}

function mergeStates(left: ShellState, right: ShellState): ShellState {
	const cwd = left.cwd === right.cwd ? left.cwd : undefined;
	const vars = new Map<string, string | undefined>();
	for (const [name, value] of left.vars) {
		if (!right.vars.has(name)) continue;
		const other = right.vars.get(name);
		if (value === other) vars.set(name, value);
		else if (value === undefined && other === undefined) vars.set(name, undefined);
	}
	return { cwd, vars };
}

function unescapeShellWord(value: string): { readonly text: string; readonly glob: boolean } | undefined {
	let output = "";
	let glob = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (character === "\\") {
			const next = value[index + 1];
			if (next === undefined) return undefined;
			index += 1;
			output += next === "\n" ? "" : next;
			continue;
		}
		if (character === "*" || character === "?" || character === "[" || character === "{") glob = true;
		output += character;
	}
	return { text: output, glob };
}

function variableNameOf(assignment: Node): string | undefined {
	const name = childOfType(assignment, "variable_name");
	return name?.text;
}

function isForbiddenEnvironment(name: string): boolean {
	return (
		FORBIDDEN_ENVIRONMENT_NAMES.has(name) || FORBIDDEN_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))
	);
}

/**
 * Names that move configuration or helper-execution sources for git/curl or
 * change command lookup. Assigning them leaves the executed program and its
 * implicit helpers unresolvable, so the analysis can no longer be complete.
 */
function environmentOverrideReason(name: string): string | undefined {
	if (name === "HOME" || name === "CURL_HOME") {
		return `assignment to ${name} moves git and curl configuration sources`;
	}
	if (
		name === "GIT_CONFIG_NOSYSTEM" ||
		name === "GIT_CONFIG_GLOBAL" ||
		name === "GIT_CONFIG_SYSTEM" ||
		name === "GIT_EXTERNAL_DIFF" ||
		name === "GIT_EXEC_PATH"
	) {
		return `assignment to ${name} changes git execution or configuration`;
	}
	if (name.startsWith("GIT_")) {
		return `assignment to ${name} changes git configuration sources`;
	}
	return undefined;
}

function globBase(value: string): string {
	const match = /[*?[{]/u.exec(value);
	if (!match) return value;
	const prefix = value.slice(0, match.index);
	if (prefix === "") return ".";
	if (prefix.endsWith("/")) return prefix.length > 1 ? prefix.slice(0, -1) : "/";
	return dirname(prefix);
}

class ShellAnalyzer {
	private readonly facts = emptyFacts();
	private readonly deadline: number;
	private readonly cwd: string;
	private readonly workspaceRoots: readonly string[];
	private readonly readOnlyRoots: readonly string[];
	private readonly home: string;
	private readonly protectedRoots: readonly string[];
	private readonly sensitiveCache = new Map<string, boolean>();
	private readonly input: ShellAnalysisInput;
	private steps = 0;
	private reason: string | undefined;

	constructor(input: ShellAnalysisInput) {
		this.input = input;
		this.cwd = canonicalizeActionPath(input.cwd, input.cwd);
		this.workspaceRoots = input.workspaceRoots.map((root) => canonicalizeActionPath(root, this.cwd));
		this.readOnlyRoots = (input.readOnlyRoots ?? []).map((root) => canonicalizeActionPath(root, this.cwd));
		this.home = canonicalizeActionPath(homedir(), homedir());
		this.protectedRoots = this.workspaceRoots.flatMap((root) =>
			PROTECTED_WORKSPACE_ENTRIES.map((name) => join(root, name)),
		);
		this.deadline = Date.now() + ANALYSIS_BUDGET_MS;
	}

	run(): ShellCommandAnalysis {
		const parsed = parseShellSyntax(this.input.command, this.input.shellPath, this.deadline);
		try {
			if (!parsed.complete || !parsed.root) {
				this.mark("user", parsed.reason ?? "shell syntax is incomplete", false);
				return this.result();
			}
			this.tick();
			const state: ShellState = {
				cwd: this.cwd,
				vars: new Map([
					["HOME", this.home],
					["PWD", this.cwd],
				]),
			};
			this.analyzeStatements(parsed.root, state);
		} catch {
			this.mark("user", "shell analysis failed before completing", false);
		} finally {
			parsed.dispose();
		}
		return this.result();
	}

	private result(): ShellCommandAnalysis {
		const reason =
			this.reason ??
			(this.facts.disposition === "safe"
				? "Command is fully analyzed and read-only"
				: this.facts.disposition === "review"
					? "Command reads explicit paths outside the workspace"
					: "Command requires user review");
		return Object.freeze({
			disposition: this.facts.disposition,
			complete: this.facts.complete,
			reason,
			readPaths: Object.freeze([...this.facts.readPaths].sort()),
			writePaths: Object.freeze([...this.facts.writePaths].sort()),
			networkEndpoints: Object.freeze([...this.facts.endpoints.values()]),
			effects: Object.freeze([...this.facts.effects].sort()),
			commands: Object.freeze([...this.facts.commands]),
		});
	}

	private tick(): void {
		this.steps += 1;
		if (this.steps > MAX_STEPS || Date.now() > this.deadline) {
			throw new Error("shell analysis exceeded the time budget");
		}
	}

	mark(disposition: ShellDisposition, reason: string, complete = true): void {
		if (!complete) this.facts.complete = false;
		if (DISPOSITION_ORDER[disposition] > DISPOSITION_ORDER[this.facts.disposition]) {
			this.facts.disposition = disposition;
			this.reason = reason;
		} else if (DISPOSITION_ORDER[disposition] === DISPOSITION_ORDER[this.facts.disposition] && !this.reason) {
			this.reason = reason;
		}
	}

	private currentHome(state: ShellState): string | undefined {
		return state.vars.has("HOME") ? state.vars.get("HOME") : this.home;
	}

	private expandHome(raw: string, state: ShellState): string | undefined {
		if (raw === "~") return this.currentHome(state);
		if (raw.startsWith("~/")) {
			const home = this.currentHome(state);
			return home === undefined ? undefined : join(home, raw.slice(2));
		}
		if (raw.startsWith("~")) return undefined;
		return raw;
	}

	resolveTarget(raw: string, state: ShellState, glob: boolean): string | undefined {
		const expanded = this.expandHome(glob ? globBase(raw) : raw, state);
		if (expanded === undefined) return undefined;
		if (!isAbsolute(expanded) && state.cwd === undefined) return undefined;
		try {
			return canonicalizeActionPath(expanded, state.cwd ?? this.cwd);
		} catch {
			return undefined;
		}
	}

	private isInside(target: string, roots: readonly string[]): boolean {
		return roots.some((root) => isPathInside(root, target));
	}

	private isSensitive(target: string, traversal: boolean): boolean {
		const key = `${traversal ? "t" : "e"}:${target}`;
		const cached = this.sensitiveCache.get(key);
		if (cached !== undefined) return cached;
		let sensitive = false;
		try {
			sensitive = isSensitivePath(target, this.cwd, traversal, this.workspaceRoots);
		} catch {
			sensitive = true;
		}
		this.sensitiveCache.set(key, sensitive);
		return sensitive;
	}

	private globReadTargets(raw: string, state: ShellState, parent: string): readonly string[] | undefined {
		const expanded = this.expandHome(raw, state)?.replace(/\/+$/u, "");
		if (expanded === undefined || /[*?[{]/u.test(dirname(expanded)) || expanded.includes("{")) return undefined;
		let names: string[];
		try {
			names = readdirSync(parent);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return [];
			return undefined;
		}
		const pattern = basename(expanded);
		const matcher = new Minimatch(pattern, { nobrace: true, noext: true, noglobstar: true });
		// macOS Bash includes . and .. in matching dot-globs, while minimatch
		// excludes those entries. A literal prefix removes that special case.
		if (pattern.startsWith(".")) {
			const dotMatcher = new Minimatch(`entry${pattern}`, { nobrace: true, noext: true, noglobstar: true });
			for (const name of [".", ".."]) {
				if (dotMatcher.match(`entry${name}`)) names.push(name);
			}
		}
		const targets: string[] = [];
		for (const name of names) {
			this.tick();
			if (name !== "." && name !== ".." && !matcher.match(name)) continue;
			const target = canonicalizeActionPath(join(parent, name), this.cwd);
			targets.push(target);
			// The shell needs the parent to expand the glob; a symlink can also
			// require a separate physical read root outside that parent.
			if (!isPathInside(parent, target)) this.facts.readPaths.add(target);
		}
		return targets;
	}

	addRead(value: ShellValue, state: ShellState, traversal: boolean): void {
		this.tick();
		if (value.dynamic || value.text === undefined) {
			this.mark("user", "read target is not statically known", false);
			return;
		}
		if (value.text === "/dev/null") return;
		const target = this.resolveTarget(value.text, state, value.glob);
		if (target === undefined) {
			this.mark("user", "relative read target has no determinate working directory", false);
			return;
		}
		this.facts.readPaths.add(target);
		const matches = value.glob ? this.globReadTargets(value.text, state, target) : [target];
		if (matches === undefined) this.mark("user", "glob read targets are not fully analyzed", false);
		const sensitive = value.glob
			? this.isSensitive(target, false) ||
				(matches === undefined
					? this.isSensitive(target, true)
					: matches.some((match) => this.isSensitive(match, traversal)))
			: this.isSensitive(target, traversal);
		if (sensitive) {
			this.addEffect("sensitive-read");
			this.mark("user", "Command reads a sensitive path", true);
			return;
		}
		const allowedRoots = [...this.workspaceRoots, ...this.readOnlyRoots];
		if (!this.isInside(target, allowedRoots) || matches?.some((match) => !this.isInside(match, allowedRoots))) {
			this.mark("review", "Command reads an explicit path outside the workspace", true);
		}
	}

	/**
	 * An unknown executable's path-shaped operands cannot be proven inert.
	 * Recording them as write targets keeps protected-write denies and grant
	 * scope conservative (the old operand-scope behavior) without treating the
	 * command as safe.
	 */
	private recordUnknownOperands(args: readonly ShellValue[], state: ShellState): void {
		for (const value of args) {
			if (value.dynamic || value.text === undefined) continue;
			const text = value.text;
			if (text.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(text) || !text.includes("/")) continue;
			this.addWrite(value, state);
		}
	}

	addWrite(value: ShellValue, state: ShellState, destructive = false): void {
		this.tick();
		if (value.dynamic || value.text === undefined) {
			this.mark("user", "write target is not statically known", false);
			return;
		}
		if (value.text === "/dev/null") return;
		const target = this.resolveTarget(value.text, state, value.glob);
		if (target === undefined) {
			this.mark("user", "relative write target has no determinate working directory", false);
			return;
		}
		this.facts.writePaths.add(target);
		if (destructive) this.addEffect("destructive");
		if (target === "/" || target === this.home) {
			this.mark(
				"deny",
				value.glob
					? "Writes to a whole filesystem root or the user home are forbidden"
					: "Writes to a filesystem root or the user home are forbidden",
				true,
			);
			return;
		}
		if (this.isInside(target, this.protectedRoots)) {
			this.mark("deny", "Writes to protected workspace metadata are forbidden", true);
			return;
		}
		if (this.isInside(target, this.readOnlyRoots)) {
			this.mark("deny", "Writes to a declared read-only root are forbidden", true);
			return;
		}
		if (destructive) {
			this.mark("user", "Command deletes or damages a filesystem target", true);
			return;
		}
		this.mark("user", "Command writes a filesystem target", true);
	}

	private evaluate(node: Node, state: ShellState): ShellValue {
		this.tick();
		switch (node.type) {
			case "word": {
				const unescaped = unescapeShellWord(node.text);
				return unescaped
					? { text: unescaped.text, dynamic: false, glob: unescaped.glob }
					: { dynamic: true, glob: false };
			}
			case "raw_string": {
				const text = node.text;
				if (text.length < 2) return DYNAMIC;
				return { text: text.slice(1, -1), dynamic: false, glob: false };
			}
			case "number":
				return { text: node.text, dynamic: false, glob: false };
			case "string": {
				let output = "";
				let dynamic = false;
				for (const child of namedChildren(node)) {
					if (child.type === "string_content") {
						output += child.text;
						continue;
					}
					const value = this.evaluate(child, state);
					if (value.dynamic || value.text === undefined) dynamic = true;
					else output += value.text;
				}
				return dynamic ? DYNAMIC : { text: output, dynamic: false, glob: false };
			}
			case "concatenation": {
				let output = "";
				let dynamic = false;
				let glob = false;
				for (const child of namedChildren(node)) {
					const value = this.evaluate(child, state);
					if (value.dynamic || value.text === undefined) dynamic = true;
					else output += value.text;
					glob ||= value.glob;
				}
				return dynamic ? { dynamic: true, glob } : { text: output, dynamic: false, glob };
			}
			case "simple_expansion": {
				const name = childOfType(node, "variable_name")?.text;
				if (!name) return DYNAMIC;
				return this.variableValue(name, state);
			}
			case "expansion": {
				const children = namedChildren(node);
				if (children.length !== 1 || children[0]?.type !== "variable_name") return DYNAMIC;
				return this.variableValue(children[0].text, state);
			}
			case "command_substitution": {
				this.analyzeNestedSequence(node, state);
				return DYNAMIC;
			}
			case "process_substitution": {
				this.analyzeNestedSequence(node, state);
				this.mark("user", "process substitution cannot be ordered statically", false);
				return DYNAMIC;
			}
			case "arithmetic_expansion":
				return DYNAMIC;
			case "ansi_c_string":
			case "translated_string":
				return DYNAMIC;
			default: {
				this.analyzeNestedExecutions(node, state);
				return DYNAMIC;
			}
		}
	}

	private variableValue(name: string, state: ShellState): ShellValue {
		if (!state.vars.has(name)) return DYNAMIC;
		const value = state.vars.get(name);
		return value === undefined ? DYNAMIC : { text: value, dynamic: false, glob: false };
	}

	private analyzeNestedExecutions(node: Node, state: ShellState): void {
		for (const child of namedChildren(node)) {
			if (child.type === "command_substitution" || child.type === "process_substitution") {
				this.analyzeNestedSequence(child, state);
				if (child.type === "process_substitution") {
					this.mark("user", "process substitution cannot be ordered statically", false);
				}
			} else {
				this.analyzeNestedExecutions(child, state);
			}
		}
	}

	private analyzeNestedSequence(node: Node, state: ShellState): void {
		const nested = cloneState(state);
		for (const child of namedChildren(node)) {
			nested.vars = new Map(nested.vars);
			this.analyzeStatement(child, nested);
		}
	}

	private analyzeStatements(node: Node, state: ShellState): ShellState {
		let current = state;
		for (const child of namedChildren(node)) current = this.analyzeStatement(child, current);
		return current;
	}

	private analyzeStatement(node: Node, state: ShellState): ShellState {
		this.tick();
		switch (node.type) {
			case "program":
			case "compound_statement":
			case "do_group":
				return this.analyzeStatements(node, state);
			case "comment":
				return state;
			case "command":
				return this.analyzeCommand(node, state);
			case "variable_assignment":
				this.recordAssignmentStatement(node, state);
				return state;
			case "declaration_command":
				this.analyzeDeclaration(node, state);
				return state;
			case "unset_command":
				this.mark("user", "unset changes the shell environment", true);
				return state;
			case "list":
				return this.analyzeList(node, state);
			case "pipeline":
				for (const child of namedChildren(node)) this.analyzeStatement(child, cloneState(state));
				return state;
			case "redirected_statement":
				return this.analyzeRedirectedStatement(node, state);
			case "subshell":
				for (const child of namedChildren(node)) this.analyzeStatement(child, cloneState(state));
				return state;
			case "if_statement":
				return this.analyzeIf(node, state);
			case "while_statement":
				return this.analyzeWhile(node, state);
			case "for_statement":
				return this.analyzeFor(node, state);
			case "case_statement":
				return this.analyzeCase(node, state);
			case "function_definition":
				this.mark("user", "shell function definitions are not statically analyzable", false);
				for (const child of namedChildren(node)) {
					if (child.type === "compound_statement") this.analyzeStatements(child, cloneState(state));
				}
				return state;
			case "test_command":
				this.recordTestCommand(node, state);
				return state;
			case "negated_command": {
				const child = firstNamedChild(node);
				return child ? this.analyzeStatement(child, state) : state;
			}
			case "file_redirect":
			case "heredoc_redirect":
			case "herestring_redirect":
				this.processRedirect(node, state);
				return state;
			case "coproc_statement":
				this.mark("user", "coprocess execution is not statically analyzable", false);
				return state;
			default:
				this.mark("user", `unsupported shell statement: ${node.type}`, false);
				return state;
		}
	}

	private analyzeList(node: Node, state: ShellState): ShellState {
		let current = state;
		let lastInput = state;
		let operator: string | undefined;
		let sawStatement = false;
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index);
			if (!child) continue;
			if (!child.isNamed) {
				if (["&&", "||", ";", "&"].includes(child.type)) operator = child.type;
				continue;
			}
			const input = current;
			const next = this.analyzeStatement(child, input);
			if (!sawStatement) {
				current = next;
				sawStatement = true;
			} else if (operator === "&&") {
				current = mergeStates(input, next);
			} else if (operator === "||") {
				current = mergeStates(mergeStates(lastInput, input), next);
			} else if (operator === "&") {
				current = mergeStates(lastInput, next);
			} else {
				current = next;
			}
			lastInput = input;
			operator = undefined;
			sawStatement = true;
		}
		return current;
	}

	private analyzeRedirectedStatement(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const body = children[0];
		const redirects = children.slice(1);
		const heredocs: HeredocInfo[] = [];
		for (const redirect of redirects) {
			const heredoc = this.processRedirect(redirect, state);
			if (heredoc) heredocs.push(heredoc);
		}
		if (!body) return state;
		if (body.type === "command" && heredocs.length === 1 && this.tryAnalyzeInterpreter(body, heredocs[0]!, state)) {
			return state;
		}
		return this.analyzeStatement(body, state);
	}

	private processRedirect(node: Node, state: ShellState): HeredocInfo | undefined {
		this.tick();
		if (node.type === "heredoc_redirect") {
			const start = childOfType(node, "heredoc_start");
			const body = childOfType(node, "heredoc_body");
			const descriptor = childOfType(node, "file_descriptor");
			if (!start || !body) {
				this.mark("user", "heredoc source is not statically readable", false);
				return undefined;
			}
			const delimiter = start.text;
			const quoted = /^['"\\]/u.test(delimiter);
			const literal = quoted || !/[$`\\]/u.test(body.text);
			return { source: body.text, literal, fd: descriptor?.text };
		}
		if (node.type === "herestring_redirect") {
			for (const child of namedChildren(node)) this.evaluate(child, state);
			return undefined;
		}
		if (node.type !== "file_redirect") return undefined;
		const descriptor = childOfType(node, "file_descriptor");
		let operator: string | undefined;
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index);
			if (child && !child.isNamed && /^[<>]|^&>>?$/u.test(child.type)) operator = child.type;
		}
		const destination = namedChildren(node)
			.filter((child) => child !== descriptor)
			.at(-1);
		if (!operator || !destination) {
			this.mark("user", "shell redirection is not statically readable", false);
			return undefined;
		}
		const value = this.evaluate(destination, state);
		if (destination.type === "number" || value.text === "-") return undefined;
		if (REDIRECT_READ_WRITE_OPERATORS.has(operator)) {
			this.addRead(value, state, false);
			this.addWrite(value, state);
			return undefined;
		}
		if (REDIRECT_READ_OPERATORS.has(operator)) {
			this.addRead(value, state, false);
			return undefined;
		}
		if (REDIRECT_WRITE_OPERATORS.has(operator)) {
			this.addWrite(value, state);
			return undefined;
		}
		this.mark("user", `unsupported shell redirection: ${operator}`, false);
		return undefined;
	}

	/**
	 * C28 only authorizes literal static values. Environment and command
	 * expansions are resolved for analysis but remain dynamic for the rule.
	 */
	private assignmentValueIsDynamic(node: Node | undefined): boolean {
		if (!node) return true;
		if (DYNAMIC_ASSIGNMENT_NODES.has(node.type)) return true;
		return namedChildren(node).some((child) => this.assignmentValueIsDynamic(child));
	}

	private analyzeAssignment(
		node: Node,
		state: ShellState,
	): { readonly name?: string; readonly complete: boolean; readonly value?: string } {
		const name = variableNameOf(node);
		if (!name) {
			this.mark("user", "shell assignment is not statically readable", false);
			return { complete: false };
		}
		const overrideReason = environmentOverrideReason(name);
		const forbidden = overrideReason !== undefined || isForbiddenEnvironment(name);
		if (forbidden) {
			this.addEffect("unknown");
			this.mark("user", overrideReason ?? `assignment to ${name} changes command resolution`, false);
		}
		const valueNode = namedChildren(node).at(-1);
		const value =
			valueNode && valueNode !== childOfType(node, "variable_name") ? this.evaluate(valueNode, state) : DYNAMIC;
		state.vars.set(name, value.dynamic ? undefined : value.text);
		const complete =
			!forbidden && !value.dynamic && value.text !== undefined && !this.assignmentValueIsDynamic(valueNode);
		return { name, complete, ...(complete ? { value: value.text } : {}) };
	}

	/**
	 * C28 binds only side-effect-free assignments whose value is fully known.
	 * The trace carries a structural marker so rule matching never has to parse
	 * raw source text or pretend the assignment is an executable command.
	 */
	private recordAssignmentStatement(node: Node, state: ShellState): void {
		const beforeDisposition = this.facts.disposition;
		const commandFacts: CommandFacts = { effects: new Set(), endpoints: new Map() };
		this.commandStack.push(commandFacts);
		try {
			const info = this.analyzeAssignment(node, state);
			if (!info.name) return;
			const args: ShellValue[] =
				info.complete && info.value !== undefined
					? [{ text: info.value, dynamic: false, glob: false }]
					: [{ text: "", dynamic: true, glob: false }];
			this.recordCommandTrace(info.name, args, commandFacts, beforeDisposition, "assignment");
		} finally {
			this.commandStack.pop();
		}
	}

	private analyzeDeclaration(node: Node, state: ShellState): void {
		this.mark("user", "shell declarations change interpreter state", true);
		for (const assignment of namedChildren(node)) {
			if (assignment.type !== "variable_assignment") continue;
			const name = variableNameOf(assignment);
			if (!name) continue;
			const overrideReason = environmentOverrideReason(name);
			if (overrideReason || isForbiddenEnvironment(name)) {
				this.addEffect("unknown");
				this.mark("user", overrideReason ?? `assignment to ${name} changes command resolution`, false);
			}
			const valueNode = namedChildren(assignment).at(-1);
			if (valueNode && valueNode.type !== "variable_name") this.evaluate(valueNode, state);
		}
	}

	private analyzeIf(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const condition = children[0];
		if (!condition) return state;
		let conditionState = this.analyzeStatement(condition, cloneState(state));
		const elseClause = children.find((child) => child.type === "else_clause");
		const thenNodes = children.filter(
			(child, index) => index > 0 && child !== elseClause && child.type !== "comment",
		);
		let thenState = cloneState(conditionState);
		for (const child of thenNodes) thenState = this.analyzeStatement(child, thenState);
		let elseState = conditionState;
		if (elseClause) {
			elseState = cloneState(conditionState);
			for (const child of namedChildren(elseClause)) {
				if (child.type === "else" || child.type === "comment") continue;
				elseState = this.analyzeStatement(child, elseState);
			}
		}
		conditionState = mergeStates(thenState, elseState);
		return mergeStates(state, conditionState);
	}

	private analyzeWhile(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const condition = children[0];
		if (!condition) return state;
		const conditionState = this.analyzeStatement(condition, cloneState(state));
		const body = childOfType(node, "do_group");
		let bodyState = cloneState(conditionState);
		if (body) bodyState = this.analyzeStatements(body, bodyState);
		return mergeStates(state, mergeStates(conditionState, bodyState));
	}

	private analyzeFor(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const body = childOfType(node, "do_group");
		const variable = childOfType(node, "variable_name")?.text;
		const items = children.filter((child) => child.type !== "do_group" && child.type !== "variable_name");
		const values = items.map((child) => this.evaluate(child, state));
		let bodyState = cloneState(state);
		if (variable) {
			const overrideReason = environmentOverrideReason(variable);
			if (overrideReason !== undefined || isForbiddenEnvironment(variable)) {
				this.addEffect("unknown");
				this.mark("user", overrideReason ?? `assignment to ${variable} changes command resolution`, false);
			}
		}
		const literalList =
			variable !== undefined &&
			values.length > 0 &&
			items.every((item) => !this.assignmentValueIsDynamic(item)) &&
			values.every(
				(value) => !value.dynamic && !value.glob && value.text !== undefined && !/[\s*?[{]/u.test(value.text),
			);
		if (literalList && body) {
			for (const value of values) {
				bodyState.vars.set(variable, value.text);
				bodyState = this.analyzeStatements(body, bodyState);
			}
		} else {
			// Do not reuse a previous value when the loop assigns an unresolved
			// item (including shell-expanded globs and positional parameters).
			if (variable) bodyState.vars.set(variable, undefined);
			this.mark("user", "for loop values are not a static literal list", false);
			if (body) bodyState = this.analyzeStatements(body, bodyState);
		}
		return mergeStates(state, bodyState);
	}

	private analyzeCase(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const value = children[0];
		if (value) this.evaluate(value, state);
		let merged = cloneState(state);
		let first = true;
		for (const item of children) {
			if (item.type !== "case_item") continue;
			let branch = cloneState(state);
			for (const child of namedChildren(item)) {
				if (this.isCasePatternNode(child)) continue;
				branch = this.analyzeStatement(child, branch);
			}
			merged = first ? branch : mergeStates(merged, branch);
			first = false;
		}
		return mergeStates(state, merged);
	}

	private isCasePatternNode(node: Node): boolean {
		return [
			"word",
			"raw_string",
			"string",
			"extglob_pattern",
			"concatenation",
			"simple_expansion",
			"expansion",
		].includes(node.type);
	}

	private evaluateTestExpression(node: Node, state: ShellState): TestToken[] {
		switch (node.type) {
			case "test_command":
				return namedChildren(node).flatMap((child) => this.evaluateTestExpression(child, state));
			case "unary_expression": {
				const operator = childOfType(node, "test_operator");
				const operand = namedChildren(node).at(-1);
				const tokens: TestToken[] = [];
				if (operator) {
					tokens.push({ operator: true, value: { text: operator.text, dynamic: false, glob: false } });
				}
				if (operand) tokens.push(...this.evaluateTestExpression(operand, state));
				return tokens;
			}
			case "binary_expression": {
				const tokens: TestToken[] = [];
				for (let index = 0; index < node.childCount; index += 1) {
					const child = node.child(index);
					if (!child) continue;
					if (!child.isNamed) {
						if (child.type !== "&&" && child.type !== "||") {
							tokens.push({ operator: true, value: { text: child.text, dynamic: false, glob: false } });
						}
						continue;
					}
					tokens.push(...this.evaluateTestExpression(child, state));
				}
				return tokens;
			}
			case "parenthesized_expression":
				return namedChildren(node).flatMap((child) => this.evaluateTestExpression(child, state));
			case "test_operator":
				return [{ operator: true, value: { text: node.text, dynamic: false, glob: false } }];
			default:
				return [{ operator: false, value: this.evaluate(node, state) }];
		}
	}

	private bindCommandTestPaths(args: readonly ShellValue[], state: ShellState): void {
		for (let index = 0; index < args.length; index += 1) {
			const operation = args[index]?.dynamic ? undefined : args[index]?.text;
			if (operation === undefined) continue;
			if (FILE_TEST_UNARY.has(operation)) {
				const operand = args[index + 1];
				if (operand) this.addRead(operand, state, false);
				continue;
			}
			if (FILE_TEST_BINARY.has(operation)) {
				const left = args[index - 1];
				const right = args[index + 1];
				if (left) this.addRead(left, state, false);
				if (right) this.addRead(right, state, false);
			}
		}
	}

	private bindTestPaths(tokens: readonly TestToken[], state: ShellState): void {
		for (let index = 0; index < tokens.length; index += 1) {
			const token = tokens[index]!;
			if (!token.operator || token.value.text === undefined) continue;
			const operation = token.value.text;
			if (FILE_TEST_UNARY.has(operation)) {
				const operand = tokens[index + 1];
				if (operand && !operand.operator) this.addRead(operand.value, state, false);
				continue;
			}
			if (FILE_TEST_BINARY.has(operation)) {
				const left = tokens[index - 1];
				const right = tokens[index + 1];
				if (left && !left.operator) this.addRead(left.value, state, false);
				if (right && !right.operator) this.addRead(right.value, state, false);
			}
		}
	}

	/**
	 * `test`, `[` and `[[ … ]]` conditions become one structural trace entry so
	 * C16–C18 can be disabled for real. File operands are bound to exact read
	 * paths; an unbound file condition never reaches the analyzer as safe.
	 */
	private recordTestCommand(node: Node, state: ShellState): void {
		const beforeDisposition = this.facts.disposition;
		const commandFacts: CommandFacts = { effects: new Set(), endpoints: new Map() };
		this.commandStack.push(commandFacts);
		try {
			const opener = node.child(0)?.type === "[[" ? "[[" : "[";
			const tokens = this.evaluateTestExpression(node, state);
			const complete = tokens.every((token) => !token.value.dynamic && token.value.text !== undefined);
			if (!complete) {
				this.mark("user", "shell conditional is not statically known", false);
			} else {
				this.bindTestPaths(tokens, state);
			}
			const args = tokens.map<ShellValue>((token) =>
				token.value.dynamic || token.value.text === undefined
					? { dynamic: true, glob: false }
					: { text: token.value.text, dynamic: false, glob: false },
			);
			this.recordCommandTrace(opener, args, commandFacts, beforeDisposition, "test");
		} finally {
			this.commandStack.pop();
		}
	}

	private readonly commandStack: CommandFacts[] = [];

	/**
	 * Facts are attributed to the command currently being dispatched. Every
	 * command records its own effects and endpoints even when an earlier node
	 * already recorded the same one, so rule matching can never clear a
	 * repeated behavior just because the aggregate already contains it.
	 */
	addEffect(effect: PermissionEffect): void {
		this.facts.effects.add(effect);
		this.commandStack.at(-1)?.effects.add(effect);
	}

	addEndpoint(endpoint: NetworkEndpoint): void {
		this.facts.endpoints.set(`${endpoint.hostname}:${endpoint.port}`, endpoint);
		this.commandStack.at(-1)?.endpoints.set(`${endpoint.hostname}:${endpoint.port}`, endpoint);
	}

	/**
	 * A wrapper or opaque executable may run a network client from its
	 * arguments; the request itself reaches an external service, so the
	 * mutation effect stays even though the invocation is user-required.
	 */
	private markNetworkArgs(args: readonly ShellValue[]): void {
		if (
			args.some(
				(value) =>
					!value.dynamic &&
					["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat"].includes(value.text ?? ""),
			)
		) {
			this.addEffect("external-side-effect");
		}
	}

	private recordCommandTrace(
		name: string,
		args: readonly ShellValue[],
		commandFacts: CommandFacts,
		beforeDisposition: ShellDisposition,
		structural?: "test" | "assignment",
	): void {
		const argv: string[] = [name];
		let complete = true;
		for (const arg of args) {
			if (arg.dynamic || arg.text === undefined || arg.glob) {
				complete = false;
				break;
			}
			argv.push(arg.text);
		}
		const disposition: ShellDisposition =
			DISPOSITION_ORDER[this.facts.disposition] > DISPOSITION_ORDER[beforeDisposition]
				? this.facts.disposition
				: "safe";
		if (this.facts.commands.length >= MAX_TRACE_ENTRIES) {
			this.mark("user", "shell command trace exceeds the analysis budget", false);
			return;
		}
		this.facts.commands.push(
			Object.freeze({
				argv: Object.freeze(argv),
				complete,
				disposition,
				effects: Object.freeze([...commandFacts.effects].sort()),
				networkEndpoints: Object.freeze([...commandFacts.endpoints.values()]),
				...(structural === undefined ? {} : { structural }),
			}),
		);
	}

	private analyzeCommand(node: Node, state: ShellState): ShellState {
		const children = namedChildren(node);
		const nameIndex = children.findIndex((child) => child.type === "command_name");
		for (const child of children.slice(0, nameIndex < 0 ? children.length : nameIndex)) {
			if (child.type !== "variable_assignment") {
				this.evaluate(child, state);
				continue;
			}
			const name = variableNameOf(child);
			if (name) {
				const overrideReason = environmentOverrideReason(name);
				if (overrideReason || isForbiddenEnvironment(name)) {
					// A mutated lookup environment changes which program actually
					// runs and which helpers it loads, so the target can no longer
					// be resolved completely.
					this.addEffect("unknown");
					this.mark("user", overrideReason ?? `assignment to ${name} changes command resolution`, false);
				}
			}
			const valueNode = namedChildren(child).at(-1);
			if (valueNode && valueNode.type !== "variable_name") this.evaluate(valueNode, state);
		}
		if (nameIndex < 0) {
			if (children.every((child) => child.type === "variable_assignment")) return state;
			this.mark("user", "command name is not statically known", false);
			return state;
		}
		const nameNode = firstNamedChild(children[nameIndex]!);
		const nameValue = nameNode ? this.evaluate(nameNode, state) : DYNAMIC;
		if (nameValue.dynamic || nameValue.text === undefined) {
			this.mark("user", "command name is not statically known", false);
			return state;
		}
		const rawName = nameValue.text;
		if (rawName.includes("/")) {
			this.mark("user", "external executable paths are not statically analyzable", false);
			this.addEffect("unknown");
			return state;
		}
		const beforeDisposition = this.facts.disposition;
		const commandFacts: CommandFacts = { effects: new Set(), endpoints: new Map() };
		this.commandStack.push(commandFacts);
		try {
			const args = children.slice(nameIndex + 1).map((child) => this.evaluate(child, state));
			const nextState = this.dispatch(rawName, args, state);
			this.recordCommandTrace(rawName, args, commandFacts, beforeDisposition);
			return nextState;
		} finally {
			this.commandStack.pop();
		}
	}

	private dispatch(name: string, args: readonly ShellValue[], state: ShellState): ShellState {
		switch (name) {
			case "pwd":
				return this.commandPwd(args, state);
			case "cd":
				return this.commandCd(args, state);
			case "ls":
				return this.commandLs(args, state);
			case "du":
				return this.commandDu(args, state);
			case "rg":
				return this.commandRg(args, state);
			case "grep":
				return this.commandGrep(args, state);
			case "cat":
				return this.commandCat(args, state);
			case "head":
			case "tail":
				return this.commandHeadTail(args, state);
			case "wc":
				return this.commandWc(args, state);
			case "sort":
				return this.commandSort(args, state);
			case "uniq":
				return this.commandUniq(args, state);
			case "cut":
				return this.commandCut(args, state);
			case "tr": {
				const scan = this.scanOptions(args, {
					boolean: [
						"-c",
						"-C",
						"-d",
						"-s",
						"-t",
						"--complement",
						"--delete",
						"--squeeze-repeats",
						"--truncate-set1",
					],
					value: [],
				});
				if (!scan.ok || scan.positionals.length < 1 || scan.positionals.length > 2) {
					this.mark("user", scan.reason ?? "tr arguments are not statically supported", false);
				}
				return state;
			}
			case "echo":
				return state;
			case "printf":
				return this.commandPrintf(args, state);
			case "git":
				return this.commandGit(args, state);
			case "curl":
				return this.commandCurl(args, state);
			case "rm":
				return this.commandRm(args, state);
			case "find":
				return this.commandFind(args, state);
			case "sed":
				return this.commandSed(args, state);
			case "tee":
				return this.commandTee(args, state);
			case "test":
			case "[":
				for (const arg of args) {
					if (arg.dynamic) this.mark("user", "shell test argument is not statically known", false);
				}
				this.bindCommandTestPaths(args, state);
				return state;
			case "true":
			case "false":
			case ":":
				return state;
			case "sudo":
			case "doas":
			case "su":
			case "runas":
				this.addEffect("elevation");
				this.mark("user", "privileged execution requires user review", false);
				this.addEffect("unknown");
				return state;
			case "eval":
			case "source":
			case ".":
			case "exec":
				this.mark("user", "dynamic shell execution is not statically analyzable", false);
				this.addEffect("unknown");
				return state;
			default:
				break;
		}
		if (name === "kill" || name === "pkill" || name === "killall" || DESTRUCTIVE_BUILTINS.has(name)) {
			this.addEffect("destructive");
			this.mark("user", "process termination requires user review", false);
			return state;
		}
		if (WRITE_COMMANDS.has(name)) return this.commandWrite(name, args, state);
		if (name === "rmdir" || DESTRUCTIVE_COMMANDS.has(name)) return this.commandDestructive(name, args, state);
		if (UNKNOWN_EXECUTION_COMMANDS.has(name) || name.startsWith("python") || name === "node" || name === "nodejs") {
			this.markNetworkArgs(args);
			const text = (value: ShellValue) => (value.dynamic ? undefined : value.text);
			if (
				["npm", "pnpm", "yarn", "bun", "cargo"].includes(name) &&
				args.some((value) => text(value) === "publish")
			) {
				this.addEffect("external-side-effect");
			}
			if (
				name === "wget" &&
				args.some((value) => {
					const word = text(value) ?? "";
					return (
						word.startsWith("--post-") ||
						word.startsWith("--body-") ||
						word === "--config" ||
						word.startsWith("--config=")
					);
				})
			) {
				this.addEffect("external-side-effect");
			}
			this.addEffect("unknown");
			this.mark("user", `execution of ${name} is not statically provable`, false);
			return state;
		}
		if (WRAPPER_COMMANDS.has(name)) {
			this.markNetworkArgs(args);
			this.addEffect("unknown");
			this.mark("user", `wrapper command ${name} is not statically transparent`, false);
			return state;
		}
		if (SHELL_STATE_COMMANDS.has(name)) {
			this.mark("user", `shell builtin ${name} changes interpreter state`, false);
			return state;
		}
		this.addEffect("unknown");
		this.mark("user", `unknown executable: ${name}`, false);
		this.recordUnknownOperands(args, state);
		return state;
	}

	private commandPwd(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, { boolean: ["-L", "--logical", "-P", "--physical"], value: [] });
		if (!scan.ok || scan.positionals.length > 0) {
			this.mark("user", scan.reason ?? "pwd arguments are not statically supported", false);
		}
		return state;
	}

	private commandCd(args: readonly ShellValue[], state: ShellState): ShellState {
		this.tick();
		const target = args[0];
		if (args.length > 1 || target?.dynamic || target?.glob) {
			this.mark("user", "cd target is not statically known", false);
			return { cwd: undefined, vars: new Map(state.vars) };
		}
		if (target && target.text === "-") {
			this.mark("user", "cd - depends on the previous working directory", false);
			return { cwd: undefined, vars: new Map(state.vars) };
		}
		const resolved = target ? this.resolveTarget(target.text ?? "", state, false) : this.currentHome(state);
		if (resolved === undefined) {
			this.mark("user", "cd target has no determinate working directory", false);
			return { cwd: undefined, vars: new Map(state.vars) };
		}
		const canonical = canonicalizeActionPath(resolved, state.cwd ?? this.cwd);
		if (!this.isInside(canonical, this.workspaceRoots)) {
			this.mark("user", "cd leaves the workspace", true);
		}
		const vars = new Map(state.vars);
		vars.set("PWD", canonical);
		return { cwd: canonical, vars };
	}

	private commandLs(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-1",
				"-A",
				"-B",
				"-C",
				"-F",
				"-G",
				"-H",
				"-L",
				"-Q",
				"-R",
				"-S",
				"-U",
				"-X",
				"-Z",
				"-a",
				"-b",
				"-c",
				"-d",
				"-e",
				"-f",
				"-g",
				"-h",
				"-i",
				"-k",
				"-l",
				"-m",
				"-n",
				"-o",
				"-p",
				"-q",
				"-r",
				"-s",
				"-t",
				"-u",
				"-v",
				"-x",
				"--all",
				"--almost-all",
				"--classify",
				"--directory",
				"--dereference-command-line",
				"--full-time",
				"--group-directories-first",
				"--human-readable",
				"--inode",
				"--numeric-uid-gid",
				"--quote-name",
				"--recursive",
				"--reverse",
				"--size",
				"--numeric-sort",
				"--time",
				"--version-sort",
			],
			value: [
				"-I",
				"-T",
				"-w",
				"--block-size",
				"--format",
				"--hide",
				"--ignore",
				"--ignore-pattern",
				"--indicator-style",
				"--quoting-style",
				"--sort",
				"--tabsize",
				"--time-style",
				"--width",
			],
			optionalValue: ["--color", "--colour", "--hyperlink"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "ls arguments are not statically supported", false);
			return state;
		}
		const recursive = scan.options.some((option) => option.name === "-R" || option.name === "--recursive");
		const targets = scan.positionals.length > 0 ? scan.positionals : [this.cwdValue(state)];
		for (const target of targets) this.addRead(target, state, recursive);
		return state;
	}

	private cwdValue(state: ShellState): ShellValue {
		return state.cwd === undefined ? DYNAMIC : { text: state.cwd, dynamic: false, glob: false };
	}

	private commandDu(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-0",
				"-A",
				"-a",
				"-b",
				"-c",
				"-h",
				"-k",
				"-l",
				"-m",
				"-P",
				"-r",
				"-S",
				"-s",
				"-x",
				"--all",
				"--apparent-size",
				"--bytes",
				"--count-links",
				"--human-readable",
				"--inodes",
				"--no-dereference",
				"--null",
				"--one-file-system",
				"--separate-dirs",
				"--si",
				"--summarize",
				"--total",
			],
			value: ["-B", "-d", "-I", "-t", "--block-size", "--exclude", "--max-depth", "--threshold"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "du arguments are not statically supported", false);
			return state;
		}
		const targets = scan.positionals.length > 0 ? scan.positionals : [this.cwdValue(state)];
		for (const target of targets) this.addRead(target, state, true);
		return state;
	}

	private commandCat(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-A",
				"-E",
				"-T",
				"-b",
				"-e",
				"-n",
				"-s",
				"-t",
				"-u",
				"-v",
				"--number",
				"--number-nonblank",
				"--show-all",
				"--show-ends",
				"--show-nonprinting",
				"--show-tabs",
				"--squeeze-blank",
			],
			value: [],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "cat arguments are not statically supported", false);
			return state;
		}
		for (const target of scan.positionals) this.addReadOptionalStdin(target, state);
		return state;
	}

	private addReadOptionalStdin(value: ShellValue, state: ShellState): void {
		if (!value.dynamic && value.text === "-") return;
		this.addRead(value, state, false);
	}

	private commandHeadTail(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(
			args,
			{
				boolean: ["-q", "-v", "-z", "-f", "-F", "--quiet", "--silent", "--verbose", "--zero-terminated", "--retry"],
				value: ["-n", "-c", "-s", "--lines", "--bytes", "--sleep-interval", "--pid", "--max-unchanged-stats"],
				optionalValue: ["--follow"],
			},
			true,
		);
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "head/tail arguments are not statically supported", false);
			return state;
		}
		for (const target of scan.positionals) this.addReadOptionalStdin(target, state);
		return state;
	}

	private commandWc(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-c",
				"-l",
				"-L",
				"-m",
				"-w",
				"--bytes",
				"--chars",
				"--lines",
				"--max-line-length",
				"--words",
				"--debug",
			],
			value: ["--files0-from", "--total"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "wc arguments are not statically supported", false);
			return state;
		}
		for (const option of scan.options) {
			if (option.name === "--files0-from") {
				this.mark("user", "wc --files0-from expands a dynamic file list", false);
			}
		}
		for (const target of scan.positionals) this.addReadOptionalStdin(target, state);
		return state;
	}

	private commandSort(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-b",
				"-d",
				"-f",
				"-g",
				"-h",
				"-i",
				"-M",
				"-m",
				"-n",
				"-r",
				"-R",
				"-s",
				"-u",
				"-V",
				"-z",
				"--debug",
				"--dictionary-order",
				"--general-numeric-sort",
				"--human-numeric-sort",
				"--ignore-case",
				"--ignore-leading-blanks",
				"--ignore-nonprinting",
				"--merge",
				"--month-sort",
				"--numeric-sort",
				"--random-sort",
				"--reverse",
				"--stable",
				"--unique",
				"--version-sort",
				"--zero-terminated",
			],
			value: [
				"-k",
				"-o",
				"-S",
				"-t",
				"-T",
				"--batch-size",
				"--buffer-size",
				"--compress-program",
				"--field-separator",
				"--files0-from",
				"--key",
				"--output",
				"--parallel",
				"--random-source",
				"--temporary-directory",
			],
			optionalValue: ["--check"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "sort arguments are not statically supported", false);
			return state;
		}
		for (const option of scan.options) {
			if (option.name === "-o" || option.name === "--output") {
				if (option.value) this.addWrite(option.value, state);
			} else if (option.name === "--compress-program") {
				this.mark("user", "sort --compress-program executes an external program", false);
			} else if (option.name === "-T" || option.name === "--temporary-directory") {
				if (option.value) this.addWrite(option.value, state);
			} else if (option.name === "--files0-from") {
				this.mark("user", "sort --files0-from expands a dynamic file list", false);
			}
		}
		for (const target of scan.positionals) this.addReadOptionalStdin(target, state);
		return state;
	}

	private commandUniq(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-c",
				"-d",
				"-i",
				"-u",
				"-z",
				"--count",
				"--ignore-case",
				"--repeated",
				"--unique",
				"--zero-terminated",
			],
			value: ["-f", "-s", "-w", "--check-chars", "--skip-chars", "--skip-fields"],
			optionalValue: ["-D", "--all-repeated", "--group"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "uniq arguments are not statically supported", false);
			return state;
		}
		if (scan.positionals.length > 2) {
			this.mark("user", "uniq accepts at most an input and an output file", false);
			return state;
		}
		const input = scan.positionals[0];
		const output = scan.positionals[1];
		if (input) this.addReadOptionalStdin(input, state);
		if (output) this.addWrite(output, state);
		return state;
	}

	private commandCut(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: ["-n", "-s", "-z", "--complement", "--only-delimited", "--zero-terminated"],
			value: ["-b", "-c", "-d", "-f", "--bytes", "--characters", "--delimiter", "--fields", "--output-delimiter"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "cut arguments are not statically supported", false);
			return state;
		}
		for (const target of scan.positionals) this.addReadOptionalStdin(target, state);
		return state;
	}

	private commandRg(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-0",
				"-F",
				"-H",
				"-L",
				"-N",
				"-S",
				"-U",
				"-a",
				"-c",
				"-h",
				"-i",
				"-l",
				"-n",
				"-o",
				"-q",
				"-s",
				"-v",
				"-w",
				"-x",
				"-z",
				"--binary",
				"--column",
				"--count",
				"--count-matches",
				"--files",
				"--files-with-matches",
				"--files-without-match",
				"--fixed-strings",
				"--follow",
				"--heading",
				"--hidden",
				"--ignore-case",
				"--invert-match",
				"--json",
				"--line-number",
				"--line-regexp",
				"--mmap",
				"--multiline",
				"--multiline-dotall",
				"--no-config",
				"--no-heading",
				"--no-ignore",
				"--no-ignore-dot",
				"--no-ignore-exclude",
				"--no-ignore-files",
				"--no-ignore-global",
				"--no-ignore-parent",
				"--no-ignore-vcs",
				"--no-line-number",
				"--no-messages",
				"--no-mmap",
				"--no-pcre2",
				"--no-require-git",
				"--no-unicode",
				"--null",
				"--null-data",
				"--one-file-system",
				"--only-matching",
				"--passthru",
				"--pcre2",
				"--quiet",
				"--smart-case",
				"--stats",
				"--search-zip",
				"--text",
				"--trim",
				"--type-list",
				"--vimgrep",
				"--with-filename",
				"--word-regexp",
			],
			value: [
				"-A",
				"-B",
				"-C",
				"-e",
				"-f",
				"-g",
				"-j",
				"-m",
				"-r",
				"-t",
				"-T",
				"--colors",
				"--color",
				"--colour",
				"--context",
				"--context-separator",
				"--encoding",
				"--field-context-separator",
				"--field-match-separator",
				"--glob",
				"--hostname-bin",
				"--hyperlink-format",
				"--iglob",
				"--ignore-file",
				"--max-columns",
				"--max-depth",
				"--max-filesize",
				"--path-separator",
				"--pre",
				"--pre-glob",
				"--regexp",
				"--replace",
				"--sort",
				"--sortr",
				"--threads",
				"--type",
				"--type-not",
				"--unrestricted",
			],
			optionalValue: ["--color", "--pre", "--sort"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "rg arguments are not statically supported", false);
			return state;
		}
		for (const option of scan.options) {
			if (option.name === "--pre" || option.name === "--pre-glob" || option.name === "--hostname-bin") {
				this.addEffect("unknown");
				this.mark("user", "rg --pre/--hostname-bin executes an external program", false);
			} else if (option.name === "--search-zip" || option.name === "-z") {
				this.addEffect("unknown");
				this.mark("user", "rg --search-zip invokes an external decompressor", false);
			} else if (option.name === "-f" || option.name === "--file") {
				if (option.value) this.addRead(option.value, state, false);
			}
		}
		const filesMode = scan.options.some((option) => option.name === "--files" || option.name === "--type-list");
		const explicitPattern =
			scan.options.some((option) => option.name === "-e" || option.name === "--regexp") ||
			scan.options.some((option) => option.name === "-f" || option.name === "--file");
		const targets = filesMode || explicitPattern ? scan.positionals : scan.positionals.slice(1);
		const paths = targets.length > 0 ? targets : [this.cwdValue(state)];
		for (const target of paths) this.addRead(target, state, true);
		return state;
	}

	private commandGrep(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-I",
				"-R",
				"-U",
				"-Z",
				"-a",
				"-b",
				"-c",
				"-E",
				"-F",
				"-G",
				"-H",
				"-P",
				"-T",
				"-V",
				"-h",
				"-i",
				"-l",
				"-m",
				"-n",
				"-o",
				"-q",
				"-r",
				"-s",
				"-v",
				"-w",
				"-x",
				"-z",
				"--binary-files",
				"--count",
				"--dereference-recursive",
				"--directories",
				"--extended-regexp",
				"--file",
				"--files-with-matches",
				"--files-without-match",
				"--fixed-strings",
				"--initial-tab",
				"--invert-match",
				"--line-buffered",
				"--line-number",
				"--line-regexp",
				"--mmap",
				"--no-filename",
				"--null",
				"--null-data",
				"--only-matching",
				"--perl-regexp",
				"--quiet",
				"--recursive",
				"--silent",
				"--text",
				"--with-filename",
				"--word-regexp",
			],
			value: [
				"-A",
				"-B",
				"-C",
				"-D",
				"-d",
				"-e",
				"-f",
				"-m",
				"--after-context",
				"--before-context",
				"--binary-files",
				"--color",
				"--colour",
				"--context",
				"--devices",
				"--directories",
				"--exclude",
				"--exclude-dir",
				"--exclude-from",
				"--group-separator",
				"--include",
				"--label",
				"--max-count",
			],
			optionalValue: ["--color", "--colour"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "grep arguments are not statically supported", false);
			return state;
		}
		const recursive = scan.options.some(
			(option) => option.name === "-r" || option.name === "-R" || option.name === "--recursive",
		);
		const explicitPattern = scan.options.some((option) => option.name === "-e" || option.name === "-f");
		const targets = explicitPattern ? scan.positionals : scan.positionals.slice(1);
		if (!explicitPattern) {
			const pattern = scan.positionals[0];
			if (pattern?.dynamic) {
				this.mark("user", "grep pattern is not statically known", false);
				return state;
			}
		}
		const paths = targets.length > 0 ? targets : recursive ? [this.cwdValue(state)] : [];
		for (const target of paths) this.addRead(target, state, recursive);
		return state;
	}

	private commandPrintf(args: readonly ShellValue[], state: ShellState): ShellState {
		const first = args[0];
		if (first?.dynamic) {
			this.mark("user", "printf format is not statically known", false);
			return state;
		}
		if (first?.text === "-v") {
			this.mark("user", "printf -v mutates shell state", true);
		}
		return state;
	}

	get currentDirectory(): string {
		return this.cwd;
	}

	private readonly gitImplicitConfigCache = new Map<string, readonly string[]>();

	private commandGit(args: readonly ShellValue[], state: ShellState): ShellState {
		return analyzeGitCommand(this, args, state);
	}

	gitImplicitConfigRisk(state: ShellState): string | undefined {
		const cwd = state.cwd ?? this.cwd;
		if (!this.gitImplicitConfigCache.has(cwd)) {
			this.gitImplicitConfigCache.set(cwd, gitImplicitExecutionReasons(cwd, this.deadline));
		}
		const reasons = this.gitImplicitConfigCache.get(cwd)!;
		if (reasons.length === 0) return undefined;
		return `git implicit configuration may execute helpers (${reasons[0]})`;
	}

	private commandCurl(args: readonly ShellValue[], state: ShellState): ShellState {
		return analyzeCurlCommand(this, args, state);
	}

	private commandRm(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-d",
				"-f",
				"-i",
				"-r",
				"-R",
				"-v",
				"--dir",
				"--force",
				"--interactive",
				"--preserve-root",
				"--recursive",
				"--verbose",
			],
			value: [],
			optionalValue: ["--interactive"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "rm arguments are not statically supported", false);
			return state;
		}
		if (scan.positionals.length === 0) {
			this.mark("user", "rm without a target is not statically meaningful", false);
			return state;
		}
		for (const target of scan.positionals) this.addWrite(target, state, true);
		return state;
	}

	private commandFind(args: readonly ShellValue[], state: ShellState): ShellState {
		const roots: ShellValue[] = [];
		let index = 0;
		for (; index < args.length; index += 1) {
			const value = args[index]!;
			if (value.dynamic) {
				this.mark("user", "find expression is not statically known", false);
				break;
			}
			const text = value.text ?? "";
			if (text.startsWith("-") || text === "!" || text === "(") break;
			roots.push(value);
		}
		if (roots.length === 0) roots.push(this.cwdValue(state));
		const expression = args.slice(index);
		for (let position = 0; position < expression.length; position += 1) {
			const value = expression[position]!;
			const text = value.dynamic ? "" : (value.text ?? "");
			if (text === "-delete") {
				this.addEffect("destructive");
				this.mark("user", "find -delete removes files", true);
				for (const root of roots) this.addWrite(root, state, true);
			} else if (["-exec", "-execdir", "-ok", "-okdir"].includes(text)) {
				this.addEffect("unknown");
				this.mark("user", "find executes an external command", false);
			} else if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(text)) {
				const target = expression[position + 1];
				if (target) this.addWrite(target, state);
			}
		}
		for (const root of roots) this.addRead(root, state, true);
		return state;
	}

	private commandSed(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-E",
				"-n",
				"-r",
				"-s",
				"-u",
				"-z",
				"--debug",
				"--follow-symlinks",
				"--null-data",
				"--posix",
				"--quiet",
				"--regexp-extended",
				"--sandbox",
				"--separate",
				"--silent",
				"--unbuffered",
			],
			value: ["-e", "-f", "-l", "--expression", "--file", "--line-length"],
			optionalValue: ["-i", "--in-place"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "sed arguments are not statically supported", false);
			return state;
		}
		const inPlace = scan.options.some((option) => option.name === "-i" || option.name === "--in-place");
		let fileStart = 0;
		const hasScriptOption = scan.options.some((option) =>
			["-e", "-f", "--expression", "--file"].includes(option.name),
		);
		for (const option of scan.options) {
			if (option.name === "-f" || option.name === "--file") {
				if (option.value) this.addRead(option.value, state, false);
			}
		}
		if (!hasScriptOption) fileStart = 1;
		for (const target of scan.positionals.slice(fileStart)) {
			if (inPlace) this.addWrite(target, state);
			else this.addReadOptionalStdin(target, state);
		}
		this.mark("user", inPlace ? "sed edits files in place" : "sed is not part of the read-only analyzer", true);
		return state;
	}

	private commandTee(args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: ["-a", "-i", "-p", "--append", "--ignore-interrupts"],
			value: ["--output-error"],
			optionalValue: ["--output-error"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? "tee arguments are not statically supported", false);
			return state;
		}
		for (const target of scan.positionals) this.addWrite(target, state);
		this.mark("user", "tee writes to files or standard output outside read-only analysis", true);
		return state;
	}

	private commandWrite(name: string, args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-R",
				"-a",
				"-b",
				"-d",
				"-f",
				"-i",
				"-l",
				"-n",
				"-p",
				"-r",
				"-s",
				"-u",
				"-v",
				"--archive",
				"--backup",
				"--force",
				"--interactive",
				"--no-clobber",
				"--parents",
				"--recursive",
				"--symbolic-link",
				"--verbose",
			],
			value: ["-t", "-S", "-m", "--mode", "--suffix", "--reference", "--target-directory"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? `${name} arguments are not statically supported`, false);
			return state;
		}
		const targetDirectory = scan.options.find(
			(option) => option.name === "-t" || option.name === "--target-directory",
		);
		if (targetDirectory) {
			for (const source of scan.positionals) this.addRead(source, state, true);
			if (targetDirectory.value) this.addWrite(targetDirectory.value, state, name === "mv");
			this.mark("user", "Target-directory copy/move semantics require explicit review", false);
			return state;
		}

		const targets = scan.positionals;
		if (targets.length === 0) {
			this.mark("user", `${name} has no statically known target`, true);
			return state;
		}
		if (name === "mv" || name === "cp" || name === "ln") {
			for (const source of targets.slice(0, -1)) this.addRead(source, state, true);
			const destination = targets.at(-1);
			if (destination) this.addWrite(destination, state, name === "mv");
			return state;
		}
		for (const target of targets) this.addWrite(target, state);
		return state;
	}

	private commandDestructive(name: string, args: readonly ShellValue[], state: ShellState): ShellState {
		const scan = this.scanOptions(args, {
			boolean: [
				"-R",
				"-f",
				"-r",
				"-v",
				"--force",
				"--no-preserve-root",
				"--preserve-root",
				"--recursive",
				"--verbose",
			],
			value: ["-m", "--mode", "--reference", "--size", "--suffix"],
		});
		if (!scan.ok) {
			this.mark("user", scan.reason ?? `${name} arguments are not statically supported`, false);
			this.addEffect("destructive");
			return state;
		}
		this.addEffect("destructive");
		this.mark("user", `${name} modifies files destructively`, true);
		let targets = scan.positionals.filter((value) => !value.dynamic && !value.text?.startsWith("-"));
		if (["chmod", "chown", "chgrp"].includes(name) && targets.length > 1) targets = targets.slice(1);
		for (const target of targets) this.addWrite(target, state, true);
		return state;
	}

	private tryAnalyzeInterpreter(command: Node, heredoc: HeredocInfo, state: ShellState): boolean {
		const children = namedChildren(command);
		const nameIndex = children.findIndex((child) => child.type === "command_name");
		// Prefix environment assignments bypass no checks: interpreters inherit
		// them, so an unknown startup environment leaves the invocation incomplete.
		for (const child of children.slice(0, nameIndex < 0 ? children.length : nameIndex)) {
			if (child.type !== "variable_assignment") continue;
			const name = variableNameOf(child);
			const overrideReason = name ? environmentOverrideReason(name) : undefined;
			this.addEffect("unknown");
			this.mark(
				"user",
				overrideReason ??
					(name && isForbiddenEnvironment(name)
						? `assignment to ${name} changes interpreter startup`
						: "interpreter startup with a modified environment is not statically provable"),
				false,
			);
			return true;
		}
		const beforeDisposition = this.facts.disposition;
		const commandFacts: CommandFacts = { effects: new Set(), endpoints: new Map() };
		this.commandStack.push(commandFacts);
		try {
			const result = this.tryAnalyzeInterpreterInner(command, heredoc, state);
			if (result.handled && result.name !== undefined) {
				this.recordCommandTrace(result.name, result.args ?? [], commandFacts, beforeDisposition);
			}
			return result.handled;
		} finally {
			this.commandStack.pop();
		}
	}

	private tryAnalyzeInterpreterInner(
		command: Node,
		heredoc: HeredocInfo,
		state: ShellState,
	): { handled: boolean; name?: string; args?: readonly ShellValue[] } {
		const children = namedChildren(command);
		const nameIndex = children.findIndex((child) => child.type === "command_name");
		if (nameIndex < 0) return { handled: false };
		const nameNode = firstNamedChild(children[nameIndex]!);
		const name = nameNode ? this.evaluate(nameNode, state) : DYNAMIC;
		if (name.dynamic || name.text === undefined) return { handled: false };
		const executable = name.text;
		let language: InlineScriptLanguage | undefined;
		if (/^(?:python|pypy)(?:\d+(?:\.\d+)?)?$/u.test(executable)) language = "python";
		else if (/^node(?:js)?$/u.test(executable)) language = "javascript";
		if (!language) return { handled: false };
		if (!heredoc.literal) {
			this.mark("user", "heredoc body is expanded by the shell before execution", false);
			return { handled: true, name: executable };
		}
		if (heredoc.fd !== undefined && heredoc.fd !== "0") return { handled: false };
		const args = children.slice(nameIndex + 1).map((child) => this.evaluate(child, state));
		if (args.some((arg) => arg.dynamic || arg.text === undefined)) {
			this.mark("user", "interpreter arguments are not statically known", false);
			return { handled: true, name: executable, args };
		}
		if (
			this.untrustedInterpreterInvocation(
				language,
				args.map((arg) => arg.text!),
			)
		) {
			return { handled: true, name: executable, args };
		}
		if (Date.now() > this.deadline) {
			this.mark("user", "shell analysis exceeded the time budget before the inline script", false);
			return { handled: true, name: executable, args };
		}
		const result = analyzeInlineScript(language, heredoc.source, this.input, this.deadline);
		this.mergeAnalysis(result);
		return { handled: true, name: executable, args };
	}

	private untrustedInterpreterInvocation(language: InlineScriptLanguage, args: readonly string[]): boolean {
		const allowed = language === "python" ? PYTHON_FLAGS : NODE_FLAGS;
		for (const value of args) {
			if (value === "-") continue;
			if (allowed.has(value)) continue;
			this.mark("user", `unsupported interpreter argument: ${value}`, false);
			return true;
		}
		if (language === "python" && !PYTHON_ISOLATION_FLAGS.every((flag) => args.includes(flag))) {
			this.mark(
				"user",
				"python startup must be isolated with -I -S before inline standard-library code is provable",
				false,
			);
			return true;
		}
		return false;
	}

	private mergeAnalysis(result: ShellCommandAnalysis): void {
		if (!result.complete) this.facts.complete = false;
		const disposition = result.disposition;
		if (DISPOSITION_ORDER[disposition] > DISPOSITION_ORDER[this.facts.disposition]) {
			this.facts.disposition = disposition;
			this.reason = result.reason;
		} else if (DISPOSITION_ORDER[disposition] === DISPOSITION_ORDER[this.facts.disposition] && !this.reason) {
			this.reason = result.reason;
		}
		for (const path of result.readPaths) this.facts.readPaths.add(path);
		for (const path of result.writePaths) this.facts.writePaths.add(path);
		for (const endpoint of result.networkEndpoints) {
			this.addEndpoint(endpoint);
		}
		for (const effect of result.effects) this.addEffect(effect);
	}

	scanOptions(args: readonly ShellValue[], spec: OptionSpec, numericShort = false): OptionScan {
		return scanCommandOptions(args, spec, numericShort);
	}
}

/**
 * Analyze a complete Bash program without executing it. The result is either a
 * fully identified behavior or an explicit reason to require user review.
 */
export function analyzeShellCommand(input: ShellAnalysisInput): ShellCommandAnalysis {
	if (typeof input?.command !== "string" || typeof input.cwd !== "string") {
		return Object.freeze({
			disposition: "user",
			complete: false,
			reason: "shell analysis requires command text and a working directory",
			readPaths: Object.freeze([]),
			writePaths: Object.freeze([]),
			networkEndpoints: Object.freeze([]),
			effects: Object.freeze(["unknown"] as const),
			commands: Object.freeze([]),
		});
	}
	return new ShellAnalyzer(input).run();
}
