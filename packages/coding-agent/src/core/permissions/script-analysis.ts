import { homedir } from "node:os";
import { join } from "node:path";
import type { Node } from "@vscode/tree-sitter-wasm";
import { canonicalizeActionPath, isPathInside } from "../../utils/paths.ts";
import {
	checkJavaScriptModule,
	JAVASCRIPT_GLOBAL_OBJECTS,
	JAVASCRIPT_REFUSED_IDENTIFIERS,
	JAVASCRIPT_STRING_METHODS,
	javascriptIdentifier,
	javascriptModuleCall,
} from "./script-javascript-semantics.ts";
import {
	PYTHON_MODULES,
	PYTHON_STRING_METHODS,
	pythonIdentifier,
	pythonModuleCall,
	pythonOpenEffect,
} from "./script-python-semantics.ts";
import {
	type ArgumentList,
	EMPTY_ARGUMENTS,
	isUnknown,
	type ScriptValue,
	STATIC,
	staticText,
	UNKNOWN,
} from "./script-values.ts";
import { isSensitivePath } from "./sensitive-paths.ts";
import type { ShellAnalysisInput, ShellCommandAnalysis } from "./shell-analysis.ts";
import { parseInlineScriptSyntax } from "./shell-parser.ts";
import type { NetworkEndpoint, PermissionEffect } from "./types.ts";

export type InlineScriptLanguage = "python" | "javascript";

const ANALYSIS_BUDGET_MS = 100;
const MAX_STEPS = 50_000;
const DISPOSITION_ORDER = { safe: 0, review: 1, user: 2, deny: 3 } as const;
const PROTECTED_WORKSPACE_ENTRIES = [".git", ".metis", ".codex", ".agents"] as const;

class ScriptBudgetError extends Error {}

interface ScriptFacts {
	disposition: ShellCommandAnalysis["disposition"];
	complete: boolean;
	reason?: string;
	readPaths: Set<string>;
	writePaths: Set<string>;
	endpoints: Map<string, NetworkEndpoint>;
	effects: Set<PermissionEffect>;
}

function namedChildren(node: Node): Node[] {
	const children: Node[] = [];
	for (let index = 0; index < node.namedChildCount; index += 1) {
		const child = node.namedChild(index);
		if (child) children.push(child);
	}
	return children;
}

function childOfType(node: Node, ...types: readonly string[]): Node | undefined {
	for (let index = 0; index < node.namedChildCount; index += 1) {
		const child = node.namedChild(index);
		if (child && types.includes(child.type)) return child;
	}
	return undefined;
}

function firstNamedChild(node: Node): Node | undefined {
	for (let index = 0; index < node.namedChildCount; index += 1) {
		const child = node.namedChild(index);
		if (child) return child;
	}
	return undefined;
}

function unescapeString(value: string): string | undefined {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character !== "\\") {
			output += character;
			continue;
		}
		const next = value[index + 1];
		if (next === undefined) return undefined;
		index += 1;
		switch (next) {
			case "\\":
			case "'":
			case '"':
				output += next;
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "0":
				output += "\0";
				break;
			default:
				return undefined;
		}
	}
	return output;
}

function mergeVars(
	left: ReadonlyMap<string, ScriptValue>,
	right: ReadonlyMap<string, ScriptValue>,
): Map<string, ScriptValue> {
	const merged = new Map<string, ScriptValue>();
	for (const [name, value] of left) {
		const other = right.get(name);
		if (other === undefined) continue;
		if (value.kind === "unknown" && other.kind === "unknown") merged.set(name, UNKNOWN);
		else if (value.kind === other.kind && staticText(value) === staticText(other)) merged.set(name, value);
	}
	return merged;
}

class ScriptAnalyzer {
	private readonly facts: ScriptFacts = {
		disposition: "safe",
		complete: true,
		readPaths: new Set(),
		writePaths: new Set(),
		endpoints: new Map(),
		effects: new Set(),
	};
	get currentDirectory(): string {
		return this.cwd;
	}

	private readonly deadline: number;
	private readonly workspaceRoots: readonly string[];
	private readonly readOnlyRoots: readonly string[];
	private readonly cwd: string;
	private readonly home: string;
	private readonly protectedRoots: readonly string[];
	private readonly language: InlineScriptLanguage;
	private readonly source: string;
	private steps = 0;
	private reason: string | undefined;

	constructor(language: InlineScriptLanguage, source: string, input: ShellAnalysisInput, deadline: number) {
		this.language = language;
		this.source = source;
		this.deadline = deadline;
		this.cwd = input.cwd;
		this.workspaceRoots = input.workspaceRoots.map((root) => canonicalizeActionPath(root, root));
		this.readOnlyRoots = (input.readOnlyRoots ?? []).map((root) => canonicalizeActionPath(root, root));
		this.home = canonicalizeActionPath(homedir(), homedir());
		this.protectedRoots = this.workspaceRoots.flatMap((root) =>
			PROTECTED_WORKSPACE_ENTRIES.map((name) => join(root, name)),
		);
	}

	run(): ShellCommandAnalysis {
		if (this.source.length === 0) {
			return this.result("Empty inline script");
		}
		if (Date.now() > this.deadline) {
			this.facts.complete = false;
			this.facts.disposition = "user";
			this.reason = "shell analysis exceeded the time budget before the inline script";
			return this.result();
		}
		const parsed = parseInlineScriptSyntax(this.source, this.language, this.deadline);
		try {
			if (!parsed.complete || !parsed.root) {
				this.mark("user", parsed.reason ?? "inline script syntax is incomplete", false);
				return this.result();
			}
			this.tick();
			const vars = new Map<string, ScriptValue>();
			this.analyzeStatements(parsed.root, vars);
		} catch (error) {
			if (error instanceof ScriptBudgetError) {
				this.mark("user", "inline script analysis exceeded the time budget", false);
			} else {
				this.mark("user", "inline script analysis failed", false);
			}
		} finally {
			parsed.dispose();
		}
		return this.result();
	}

	private result(fallback?: string): ShellCommandAnalysis {
		const reason =
			this.reason ??
			fallback ??
			(this.facts.disposition === "safe"
				? "Inline script is fully analyzed and read-only"
				: this.facts.disposition === "review"
					? "Inline script reads an explicit path outside the workspace"
					: "Inline script requires user review");
		return Object.freeze({
			disposition: this.facts.disposition,
			complete: this.facts.complete,
			reason,
			readPaths: Object.freeze([...this.facts.readPaths].sort()),
			writePaths: Object.freeze([...this.facts.writePaths].sort()),
			networkEndpoints: Object.freeze([...this.facts.endpoints.values()]),
			effects: Object.freeze([...this.facts.effects].sort()),
			commands: Object.freeze([]),
		});
	}

	private tick(): void {
		this.steps += 1;
		if (this.steps > MAX_STEPS || Date.now() > this.deadline) throw new ScriptBudgetError();
	}

	mark(disposition: ShellCommandAnalysis["disposition"], reason: string, complete = true): void {
		this.tick();
		if (!complete) this.facts.complete = false;
		if (DISPOSITION_ORDER[disposition] > DISPOSITION_ORDER[this.facts.disposition]) {
			this.facts.disposition = disposition;
			this.reason = reason;
		} else if (DISPOSITION_ORDER[disposition] === DISPOSITION_ORDER[this.facts.disposition] && !this.reason) {
			this.reason = reason;
		}
	}

	private expandHome(raw: string): string | undefined {
		if (raw === "~") return this.home;
		if (raw.startsWith("~/")) return join(this.home, raw.slice(2));
		if (raw.startsWith("~")) return undefined;
		return raw;
	}

	private resolveTarget(raw: string): string | undefined {
		const expanded = this.expandHome(raw);
		if (expanded === undefined) return undefined;
		try {
			return canonicalizeActionPath(expanded, this.cwd);
		} catch {
			return undefined;
		}
	}

	private isInside(target: string, roots: readonly string[]): boolean {
		return roots.some((root) => isPathInside(root, target));
	}

	recordRead(rawPath: string, traversal: boolean): void {
		const target = this.resolveTarget(rawPath);
		if (!target) {
			this.mark("user", "inline script read target is not statically known", false);
			return;
		}
		this.facts.readPaths.add(target);
		let sensitive = false;
		try {
			sensitive = isSensitivePath(target, this.cwd, traversal, this.workspaceRoots);
		} catch {
			this.mark("user", "inline script read target could not be classified", false);
			return;
		}
		if (sensitive) {
			this.facts.effects.add("sensitive-read");
			this.mark("user", "inline script reads a sensitive path", true);
			return;
		}
		if (!this.isInside(target, [...this.workspaceRoots, ...this.readOnlyRoots])) {
			this.mark("review", "inline script reads an explicit path outside the workspace", true);
		}
	}

	recordWrite(rawPath: string, destructive = false): void {
		const target = this.resolveTarget(rawPath);
		if (!target) {
			this.mark("user", "inline script write target is not statically known", false);
			return;
		}
		this.facts.writePaths.add(target);
		if (destructive) this.facts.effects.add("destructive");
		if (target === "/" || target === this.home) {
			this.mark("deny", "Writes to a filesystem root or the user home are forbidden", true);
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
		this.mark("user", "Inline script writes a filesystem target", true);
	}

	private analyzeStatements(node: Node, vars: Map<string, ScriptValue>): void {
		for (const child of namedChildren(node)) {
			this.analyzeStatement(child, vars);
		}
	}

	private analyzeBlock(node: Node | undefined, vars: Map<string, ScriptValue>): Map<string, ScriptValue> {
		if (!node) return vars;
		const branch = new Map(vars);
		this.analyzeStatements(node, branch);
		return branch;
	}

	private analyzeStatement(node: Node, vars: Map<string, ScriptValue>): void {
		this.tick();
		switch (node.type) {
			case "module":
			case "program":
			case "block":
			case "statement_block":
				this.analyzeStatements(node, vars);
				return;
			case "expression_statement": {
				const expression = firstNamedChild(node);
				if (expression) this.analyzeExpressionStatement(expression, vars);
				return;
			}
			case "assignment":
			case "annotated_assignment":
			case "named_expression":
				this.handleAssignment(node, vars);
				return;
			case "augmented_assignment":
			case "augmented_assignment_expression":
			case "update_expression": {
				const target = firstNamedChild(node);
				if (target?.type === "identifier") vars.set(target.text, UNKNOWN);
				for (const child of namedChildren(node).slice(1)) this.evalExpression(child, vars);
				return;
			}
			case "lexical_declaration":
			case "variable_declaration":
				for (const child of namedChildren(node)) {
					if (child.type === "variable_declarator") this.handleDeclarator(child, vars);
				}
				return;
			case "import_statement":
				this.handleImport(node, vars);
				return;
			case "import_from_statement":
				this.handleImportFrom(node, vars);
				return;
			case "if_statement":
				this.handleIf(node, vars);
				return;
			case "try_statement":
				this.handleTry(node, vars);
				return;
			case "for_statement":
				this.handleFor(node, vars);
				return;
			case "for_in_statement":
				this.handleForIn(node, vars);
				return;
			case "while_statement":
			case "do_statement":
				this.evalExpression(firstNamedChild(node) ?? node, vars);
				this.mark("user", "unbounded or untracked loop is not supported", false);
				return;
			case "with_statement":
				this.handleWith(node, vars);
				return;
			case "switch_statement":
				this.handleSwitch(node, vars);
				return;
			case "return_statement":
			case "raise_statement":
			case "throw_statement":
			case "assert_statement":
			case "pass_statement":
			case "break_statement":
			case "continue_statement":
			case "empty_statement":
			case "comment":
			case "expression_list":
				for (const child of namedChildren(node)) this.evalExpression(child, vars);
				return;
			case "delete_statement":
				this.mark("user", "deletion is not supported in inline scripts", false);
				return;
			case "function_definition":
			case "function_declaration":
			case "generator_function_declaration":
			case "class_definition":
			case "class_declaration":
			case "lambda":
			case "arrow_function":
				this.mark("user", "inline script defines a function or class", false);
				return;
			case "global_statement":
			case "nonlocal_statement":
				this.mark("user", "inline script mutates a global scope", false);
				return;
			case "export_statement": {
				const declaration = childOfType(
					node,
					"lexical_declaration",
					"variable_declaration",
					"function_declaration",
					"class_declaration",
				);
				if (declaration) this.analyzeStatement(declaration, vars);
				else this.mark("user", "exported inline script value is not supported", false);
				return;
			}
			default:
				this.mark("user", `unsupported inline script statement: ${node.type}`, false);
		}
	}

	private analyzeExpressionStatement(node: Node, vars: Map<string, ScriptValue>): void {
		switch (node.type) {
			case "assignment":
			case "annotated_assignment":
			case "named_expression":
				this.handleAssignment(node, vars);
				return;
			case "augmented_assignment":
			case "augmented_assignment_expression":
			case "update_expression":
				this.analyzeStatement(node, vars);
				return;
			default:
				this.evalExpression(node, vars);
		}
	}

	private handleAssignment(node: Node, vars: Map<string, ScriptValue>): void {
		const children = namedChildren(node);
		if (children.length === 0) return;
		const valueNode = children[children.length - 1];
		const targets = children.slice(0, -1);
		if (!valueNode || targets.length === 0) {
			this.mark("user", "inline script assignment is not statically analyzable", false);
			return;
		}
		const value = this.evalExpression(valueNode, vars);
		for (const target of targets) this.bindTarget(target, value, vars);
	}

	private bindTarget(target: Node, value: ScriptValue, vars: Map<string, ScriptValue>): void {
		if (target.type === "identifier") {
			vars.set(target.text, value);
			return;
		}
		if (target.type === "object_pattern") this.bindObjectPattern(target, value, vars);
		else if (target.type === "array_pattern") this.bindArrayPattern(target, value, vars);
		else if (target.type === "as_pattern_target") {
			const inner = firstNamedChild(target);
			if (inner) this.bindTarget(inner, value, vars);
		} else {
			this.mark("user", "inline script assignment target is not supported", false);
		}
	}

	private bindObjectPattern(pattern: Node, value: ScriptValue, vars: Map<string, ScriptValue>): void {
		for (const child of namedChildren(pattern)) {
			if (child.type === "shorthand_property_identifier_pattern") {
				vars.set(child.text, value.kind === "module" ? UNKNOWN : value);
			} else if (child.type === "pair_pattern") {
				const key = childOfType(child, "property_identifier", "identifier", "string");
				const target = childOfType(child, "identifier", "object_pattern", "array_pattern");
				if (key && target) {
					if (value.kind === "module") {
						const moduleName = value.name.split(".")[0];
						vars.set(key.text, { kind: "module", name: `${moduleName}.${key.text}` });
					} else {
						vars.set(key.text, UNKNOWN);
					}
				}
			}
		}
	}

	private bindArrayPattern(pattern: Node, value: ScriptValue, vars: Map<string, ScriptValue>): void {
		void value;
		for (const child of namedChildren(pattern)) {
			if (child.type === "identifier") vars.set(child.text, UNKNOWN);
		}
	}

	private handleDeclarator(node: Node, vars: Map<string, ScriptValue>): void {
		const children = namedChildren(node);
		const target = children[0];
		const valueNode = children[1];
		if (!target) return;
		const value = valueNode ? this.evalExpression(valueNode, vars) : UNKNOWN;
		this.bindTarget(target, value, vars);
	}

	private handleImport(node: Node, vars: Map<string, ScriptValue>): void {
		if (this.language === "python") {
			this.handlePythonImport(node, vars);
			return;
		}
		this.handleJavaScriptImport(node, vars);
	}

	private handlePythonImport(node: Node, vars: Map<string, ScriptValue>): void {
		const source = childOfType(node, "dotted_name", "aliased_import");
		if (!source) {
			this.mark("user", "inline script import is not statically readable", false);
			return;
		}
		const moduleName = this.importedModuleName(source);
		const alias = this.importedAlias(source);
		if (!moduleName || !PYTHON_MODULES.has(moduleName.split(".")[0] ?? "")) {
			this.mark("user", `inline script loads an unsupported module: ${moduleName ?? "unknown"}`, false);
			return;
		}
		vars.set(alias ?? moduleName.split(".")[0]!, { kind: "module", name: moduleName.split(".")[0]! });
	}

	private handleImportFrom(node: Node, vars: Map<string, ScriptValue>): void {
		if (this.language === "python") {
			const moduleNode = childOfType(node, "dotted_name");
			const moduleName = moduleNode?.text;
			if (!moduleName || !PYTHON_MODULES.has(moduleName.split(".")[0] ?? "")) {
				this.mark("user", `inline script loads an unsupported module: ${moduleName ?? "unknown"}`, false);
				return;
			}
			const children = namedChildren(node);
			const moduleIndex = moduleNode ? children.indexOf(moduleNode) : -1;
			const imported = children.slice(moduleIndex + 1);
			for (const entry of imported) {
				if (entry.type === "wildcard_import") {
					this.mark("user", "wildcard imports cannot be analyzed", false);
					continue;
				}
				const name = this.importedModuleName(entry);
				const alias = this.importedAlias(entry);
				if (!name) {
					this.mark("user", "inline script import name is not statically readable", false);
					continue;
				}
				vars.set(alias ?? name, { kind: "module", name: `${moduleName.split(".")[0]}.${name}` });
			}
			return;
		}
		const imported = childOfType(node, "import_clause");
		const source = namedChildren(node)
			.filter((child) => child !== imported)
			.find((child) => child.type === "string");
		if (!imported || !source) {
			this.mark("user", "inline script import is not statically readable", false);
			return;
		}
		this.bindJavaScriptImport(node, imported, source, vars);
	}

	private handleJavaScriptImport(node: Node, vars: Map<string, ScriptValue>): void {
		const imported = childOfType(node, "import_clause");
		const source = namedChildren(node).find((child) => child.type === "string");
		if (!source) {
			this.mark("user", "inline script import is not statically readable", false);
			return;
		}
		if (!imported) {
			this.checkJavaScriptModule(this.stringLiteral(source), false);
			return;
		}
		this.bindJavaScriptImport(node, imported, source, vars);
	}

	private bindJavaScriptImport(node: Node, clause: Node, source: Node, vars: Map<string, ScriptValue>): void {
		void node;
		const moduleName = this.checkJavaScriptModule(this.stringLiteral(source), true);
		if (!moduleName) return;
		for (const child of namedChildren(clause)) {
			if (child.type === "identifier") {
				vars.set(child.text, { kind: "module", name: moduleName });
				continue;
			}
			if (child.type === "namespace_import") {
				const name = childOfType(child, "identifier");
				if (name) vars.set(name.text, { kind: "module", name: moduleName });
				continue;
			}
			if (child.type === "named_imports") {
				for (const specifier of namedChildren(child)) {
					if (specifier.type !== "import_specifier") continue;
					const identifiers = namedChildren(specifier).filter((entry) => entry.type === "identifier");
					const importedName = identifiers[0]?.text;
					const alias = identifiers[1]?.text ?? importedName;
					if (importedName && alias) {
						vars.set(alias, { kind: "module", name: `${moduleName}.${importedName}` });
					}
				}
			}
		}
	}

	private checkJavaScriptModule(moduleName: string | undefined, markFailure: boolean): string | undefined {
		return checkJavaScriptModule(this, moduleName, markFailure);
	}

	private importedModuleName(node: Node): string | undefined {
		if (node.type === "identifier" || node.type === "dotted_name") return node.text;
		if (node.type === "aliased_import") {
			const target = firstNamedChild(node);
			return target ? this.importedModuleName(target) : undefined;
		}
		return undefined;
	}

	private importedAlias(node: Node): string | undefined {
		if (node.type !== "aliased_import") return undefined;
		const identifier = namedChildren(node)
			.filter((child) => child.type === "identifier")
			.at(-1);
		return identifier?.text;
	}

	private handleIf(node: Node, vars: Map<string, ScriptValue>): void {
		const children = namedChildren(node);
		const condition = children[0];
		if (!condition) {
			this.mark("user", "inline script condition is not analyzable", false);
			return;
		}
		this.evalExpression(condition, vars);
		const consequenceIndex = children.findIndex(
			(child, index) => index > 0 && (child.type === "block" || child.type === "statement_block"),
		);
		if (consequenceIndex < 0) {
			this.mark("user", "inline script branch is not analyzable", false);
			return;
		}
		const consequence = children[consequenceIndex]!;
		const elseClause = children
			.slice(consequenceIndex + 1)
			.find((child) => child.type === "else_clause" || child.type === "elif_clause");
		const thenVars = this.analyzeBlock(consequence, vars);
		let elseVars = new Map(vars);
		if (elseClause) {
			const elseBody = firstNamedChild(elseClause);
			if (elseClause.type === "elif_clause") this.analyzeIfLike(elseClause, elseVars);
			else if (elseBody) elseVars = this.analyzeBlock(elseBody, vars);
		}
		this.replaceVars(vars, mergeVars(thenVars, elseVars));
	}

	private analyzeIfLike(node: Node, vars: Map<string, ScriptValue>): void {
		const synthetic = node;
		const children = namedChildren(synthetic);
		const condition = children[0];
		if (condition) this.evalExpression(condition, vars);
		const body = children.find((child) => child.type === "block" || child.type === "statement_block");
		if (body) vars = this.analyzeBlock(body, vars);
		this.replaceVars(vars, vars);
	}

	private handleTry(node: Node, vars: Map<string, ScriptValue>): void {
		const branches: Map<string, ScriptValue>[] = [new Map(vars)];
		for (const child of namedChildren(node)) {
			if (child.type === "block" || child.type === "statement_block") {
				branches.push(this.analyzeBlock(child, vars));
			} else if (
				child.type === "except_clause" ||
				child.type === "catch_clause" ||
				child.type === "finally_clause"
			) {
				const block = childOfType(child, "block", "statement_block");
				branches.push(this.analyzeBlock(block, vars));
			}
		}
		let merged = branches[0]!;
		for (const branch of branches.slice(1)) merged = mergeVars(merged, branch);
		this.replaceVars(vars, merged);
	}

	private handleFor(node: Node, vars: Map<string, ScriptValue>): void {
		const children = namedChildren(node);
		if (this.language === "python") {
			const iterable = children.find(
				(child, index) => index > 0 && child.type !== "block" && child.type !== "identifier",
			);
			if (!iterable) {
				this.mark("user", "inline script loop iterable is not statically known", false);
				return;
			}
			const value = this.evalExpression(iterable, vars);
			if (isUnknown(value)) {
				this.mark("user", "inline script loop iterable is not statically known", false);
				return;
			}
			const target = children.find((child) => child.type === "identifier");
			if (target) vars.set(target.text, UNKNOWN);
			const body = childOfType(node, "block");
			const bodyVars = this.analyzeBlock(body, vars);
			this.replaceVars(vars, mergeVars(vars, bodyVars));
			return;
		}
		const block = childOfType(node, "statement_block");
		const condition = children.find(
			(child) => child !== block && child.type !== "lexical_declaration" && child.type !== "variable_declaration",
		);
		if (!block) {
			const body = children.at(-1);
			if (!body || condition === undefined) {
				this.mark("user", "inline script loop is not statically analyzable", false);
				return;
			}
			this.evalExpression(condition, vars);
			const branch = new Map(vars);
			this.analyzeStatement(body, branch);
			this.replaceVars(vars, mergeVars(vars, branch));
			return;
		}
		if (!condition) {
			this.mark("user", "inline script loop condition is not statically bounded", false);
			return;
		}
		this.evalExpression(condition, vars);
		const bodyVars = this.analyzeBlock(block, vars);
		this.replaceVars(vars, mergeVars(vars, bodyVars));
	}

	private handleForIn(node: Node, vars: Map<string, ScriptValue>): void {
		const children = namedChildren(node);
		const block = childOfType(node, "statement_block");
		const body = block ?? children.at(-1);
		const iterable = children.find(
			(child) =>
				child !== body &&
				child.type !== "identifier" &&
				child.type !== "lexical_declaration" &&
				child.type !== "variable_declaration",
		);
		if (!iterable || !body) {
			this.mark("user", "inline script loop is not statically analyzable", false);
			return;
		}
		const value = this.evalExpression(iterable, vars);
		if (isUnknown(value)) {
			this.mark("user", "inline script loop iterable is not statically known", false);
			return;
		}
		const target = childOfType(node, "identifier");
		if (target) vars.set(target.text, UNKNOWN);
		const branch = new Map(vars);
		this.analyzeStatement(body, branch);
		this.replaceVars(vars, mergeVars(vars, branch));
	}

	private handleWith(node: Node, vars: Map<string, ScriptValue>): void {
		const clause = childOfType(node, "with_clause");
		const block = childOfType(node, "block");
		if (!clause) {
			this.mark("user", "inline script context manager is not supported", false);
			return;
		}
		for (const item of namedChildren(clause)) {
			if (item.type !== "with_item") continue;
			const resource = firstNamedChild(item);
			if (!resource) continue;
			const value = this.evalExpression(resource, vars);
			const binding = childOfType(item, "as_pattern");
			const target = binding ? childOfType(binding, "as_pattern_target") : undefined;
			const identifier = target ? childOfType(target, "identifier") : undefined;
			if (identifier) vars.set(identifier.text, value);
		}
		if (block) vars = this.analyzeBlock(block, vars);
		this.replaceVars(vars, vars);
	}

	private handleSwitch(node: Node, vars: Map<string, ScriptValue>): void {
		const condition = childOfType(node, "parenthesized_expression");
		if (condition) this.evalExpression(condition, vars);
		const branches: Map<string, ScriptValue>[] = [new Map(vars)];
		const body = childOfType(node, "switch_body");
		for (const entry of body ? namedChildren(body) : []) {
			if (entry.type !== "switch_case" && entry.type !== "switch_default") continue;
			const branch = new Map(vars);
			for (const child of namedChildren(entry)) {
				if (child === firstNamedChild(entry)) continue;
				this.analyzeStatement(child, branch);
			}
			branches.push(branch);
		}
		let merged = branches[0]!;
		for (const branch of branches.slice(1)) merged = mergeVars(merged, branch);
		this.replaceVars(vars, merged);
	}

	private replaceVars(target: Map<string, ScriptValue>, source: Map<string, ScriptValue>): void {
		target.clear();
		for (const [name, value] of source) target.set(name, value);
	}

	private evalExpression(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		this.tick();
		switch (node.type) {
			case "identifier": {
				const name = node.text;
				if (this.language === "javascript") {
					if (JAVASCRIPT_GLOBAL_OBJECTS.has(name)) return { kind: "module", name };
					if (JAVASCRIPT_REFUSED_IDENTIFIERS.has(name)) {
						this.mark("user", `inline script uses unsupported global: ${name}`, false);
						return UNKNOWN;
					}
				}
				return vars.get(name) ?? UNKNOWN;
			}
			case "property_identifier":
			case "shorthand_property_identifier_pattern":
				return UNKNOWN;
			case "true":
			case "false":
				return { kind: "static", value: node.text.toLowerCase() };
			case "none":
			case "null":
			case "undefined":
				return { kind: "static", value: node.text.toLowerCase() };
			case "integer":
			case "float":
			case "number":
				return { kind: "static", value: node.text };
			case "string":
				return this.evalString(node, vars);
			case "template_string":
				return this.evalTemplateString(node, vars);
			case "raw_string":
				return { kind: "static", value: node.text };
			case "regex":
				return STATIC;
			case "list":
			case "tuple":
			case "set":
			case "dictionary":
			case "array":
			case "object":
				for (const child of namedChildren(node)) this.evalExpression(child, vars);
				return STATIC;
			case "pair":
			case "keyword_argument":
				return this.evalExpression(namedChildren(node).at(-1) ?? node, vars);
			case "parenthesized_expression":
			case "expression_list":
			case "spread_element": {
				const child = firstNamedChild(node);
				return child ? this.evalExpression(child, vars) : STATIC;
			}
			case "binary_operator":
			case "binary_expression":
			case "comparison_operator":
			case "boolean_operator":
			case "not_operator":
			case "conditional_expression":
			case "ternary_expression": {
				const values = namedChildren(node).map((child) => this.evalExpression(child, vars));
				return this.combineBinary(node.type, this.operatorOf(node), values);
			}
			case "unary_operator":
			case "unary_expression":
				return this.evalUnary(node, vars);
			case "subscript":
			case "slice":
				for (const child of namedChildren(node)) this.evalExpression(child, vars);
				return UNKNOWN;
			case "attribute":
			case "member_expression": {
				const objectNode = firstNamedChild(node);
				if (objectNode) this.evalExpression(objectNode, vars);
				return UNKNOWN;
			}
			case "call":
			case "call_expression":
				return this.evalCall(node, vars);
			case "assignment_expression":
				this.mark("user", "inline script assignment expression is not supported", false);
				return UNKNOWN;
			case "new_expression":
				this.mark("user", "inline script constructs an object dynamically", false);
				return UNKNOWN;
			case "await_expression":
			case "yield":
				this.mark("user", "inline script uses asynchronous or generator control flow", false);
				return UNKNOWN;
			case "list_comprehension":
			case "set_comprehension":
			case "dictionary_comprehension":
			case "generator_expression":
				return this.evalComprehension(node, vars);
			case "comment":
				return STATIC;
			default:
				for (const child of namedChildren(node)) this.evalExpression(child, vars);
				this.mark("user", `unsupported inline script expression: ${node.type}`, false);
				return UNKNOWN;
		}
	}

	private operatorOf(node: Node): string {
		for (let index = 0; index < node.childCount; index += 1) {
			const child = node.child(index);
			if (child && !child.isNamed) return child.type;
		}
		return "";
	}

	private combineBinary(type: string, operator: string, values: readonly ScriptValue[]): ScriptValue {
		if (values.some(isUnknown)) return STATIC;
		if (type !== "binary_operator" && type !== "binary_expression") return STATIC;
		if (values.length !== 2 || operator !== "+") return STATIC;
		const left = staticText(values[0]!);
		const right = staticText(values[1]!);
		if (left === undefined || right === undefined) return STATIC;
		if (/^-?\d+(?:\.\d+)?$/u.test(left) && /^-?\d+(?:\.\d+)?$/u.test(right)) {
			return { kind: "static", value: String(Number(left) + Number(right)) };
		}
		return { kind: "static", value: `${left}${right}` };
	}

	private evalUnary(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		const operator = node.child(0)?.type;
		const operand = namedChildren(node).at(-1);
		const value = operand ? this.evalExpression(operand, vars) : STATIC;
		if (operator === "delete") {
			this.mark("user", "inline script deletes an object property", false);
			return UNKNOWN;
		}
		const text = staticText(value);
		if (text !== undefined && (operator === "-" || operator === "+")) {
			const numeric = Number(text);
			if (!Number.isNaN(numeric)) {
				return { kind: "static", value: String(operator === "-" ? -numeric : numeric) };
			}
		}
		return STATIC;
	}

	private evalString(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		let output = "";
		let dynamic = false;
		for (const child of namedChildren(node)) {
			if (child.type === "string_content" || child.type === "string_fragment") {
				const unescaped = unescapeString(child.text);
				if (unescaped === undefined) dynamic = true;
				else output += unescaped;
			} else if (child.type === "interpolation" || child.type === "template_substitution") {
				const expression = firstNamedChild(child);
				const value = expression ? this.evalExpression(expression, vars) : UNKNOWN;
				const text = staticText(value);
				if (text === undefined) dynamic = true;
				else output += text;
			} else if (child.type === "escape_sequence") {
				dynamic = true;
			}
		}
		return dynamic ? UNKNOWN : { kind: "static", value: output };
	}

	private evalTemplateString(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		let output = "";
		for (const child of namedChildren(node)) {
			if (child.type === "string_fragment") {
				output += child.text;
			} else if (child.type === "template_substitution") {
				const expression = firstNamedChild(child);
				const value = expression ? this.evalExpression(expression, vars) : UNKNOWN;
				const text = staticText(value);
				if (text === undefined) return UNKNOWN;
				output += text;
			}
		}
		return { kind: "static", value: output };
	}

	private stringLiteral(node: Node): string | undefined {
		const value = this.evalString(node, new Map());
		return staticText(value);
	}

	private evalComprehension(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		for (const child of namedChildren(node)) {
			if (child.type === "for_in_clause") {
				const inIndex = namedChildren(child).findIndex((entry) => entry.type !== "identifier");
				const iterable = namedChildren(child)[inIndex];
				if (!iterable) {
					this.mark("user", "inline script comprehension is not statically analyzable", false);
					return UNKNOWN;
				}
				const value = this.evalExpression(iterable, vars);
				if (isUnknown(value)) {
					this.mark("user", "inline script comprehension iterable is not statically known", false);
					return UNKNOWN;
				}
			} else {
				this.evalExpression(child, vars);
			}
		}
		return STATIC;
	}

	private evalCall(node: Node, vars: Map<string, ScriptValue>): ScriptValue {
		const children = namedChildren(node);
		const callee = children[0];
		const argsNode = children.find((child) => child.type === "arguments" || child.type === "argument_list");
		if (!callee) {
			this.mark("user", "inline script call target is not statically known", false);
			return UNKNOWN;
		}
		const args = this.evalArguments(argsNode, vars);
		return this.callValue(callee, args, vars);
	}

	private evalArguments(node: Node | undefined, vars: Map<string, ScriptValue>): ArgumentList {
		if (!node) return EMPTY_ARGUMENTS;
		const positionals: ScriptValue[] = [];
		const keywords = new Map<string, ScriptValue>();
		let splat = false;
		for (const child of namedChildren(node)) {
			if (child.type === "keyword_argument") {
				const [name, valueNode] = namedChildren(child);
				const value = valueNode ? this.evalExpression(valueNode, vars) : UNKNOWN;
				if (name) keywords.set(name.text, value);
				continue;
			}
			if (
				["list_splat", "dictionary_splat", "list_splat_pattern", "dictionary_splat_pattern"].includes(child.type)
			) {
				splat = true;
				this.evalExpression(child, vars);
				continue;
			}
			positionals.push(this.evalExpression(child, vars));
		}
		return { positionals, keywords, splat };
	}

	private callValue(callee: Node, args: ArgumentList, vars: Map<string, ScriptValue>): ScriptValue {
		if (callee.type === "identifier") {
			return this.callIdentifier(callee.text, args, vars);
		}
		if (callee.type === "attribute" || callee.type === "member_expression") {
			const objectNode = firstNamedChild(callee);
			const property = namedChildren(callee)
				.filter((child) => child.type === "identifier" || child.type === "property_identifier")
				.at(-1);
			if (!objectNode || !property) {
				this.mark("user", "inline script method target is not statically known", false);
				return UNKNOWN;
			}
			const object = this.evalExpression(objectNode, vars);
			return this.callMember(object, property.text, args, vars);
		}
		this.mark("user", "inline script calls a dynamic function", false);
		return UNKNOWN;
	}

	private callIdentifier(name: string, args: ArgumentList, vars: Map<string, ScriptValue>): ScriptValue {
		if (this.language === "python") return pythonIdentifier(this, name, args, vars);
		return javascriptIdentifier(this, name, args, vars);
	}

	private callMember(
		object: ScriptValue,
		name: string,
		args: ArgumentList,
		vars: Map<string, ScriptValue>,
	): ScriptValue {
		if (object.kind === "module") return this.callModule(`${object.name}.${name}`, args, vars);
		if (object.kind === "file") {
			if (["read", "readline", "readlines", "close", "flush", "seek", "tell", "fileno"].includes(name)) {
				return name.startsWith("read") ? { kind: "string" } : STATIC;
			}
			if (["write", "writelines", "truncate"].includes(name)) {
				this.recordWrite(object.path);
				return STATIC;
			}
			this.mark("user", `inline script calls an unsupported file method: ${name}`, false);
			return UNKNOWN;
		}
		if (object.kind === "path") {
			if (name === "open") {
				return pythonOpenEffect(
					this,
					{ kind: "static", value: object.value },
					args.positionals[0] ?? args.keywords.get("mode"),
					args,
				);
			}
			if (["read_text", "read_bytes"].includes(name)) {
				this.recordRead(object.value, false);
				return name === "read_bytes" ? { kind: "bytes" } : { kind: "string" };
			}
			if (["write_text", "write_bytes"].includes(name)) {
				this.recordWrite(object.value);
				return STATIC;
			}
			if (["exists", "is_file", "is_dir", "stat", "iterdir", "glob", "rglob"].includes(name)) {
				this.recordRead(object.value, true);
				return STATIC;
			}
			this.mark("user", `inline script calls an unsupported path method: ${name}`, false);
			return UNKNOWN;
		}
		if (object.kind === "string") {
			if (this.language === "python" && PYTHON_STRING_METHODS.has(name)) return { kind: "string" };
			if (this.language === "javascript" && JAVASCRIPT_STRING_METHODS.has(name)) return { kind: "string" };
			this.mark("user", `inline script calls an unsupported string method: ${name}`, false);
			return UNKNOWN;
		}
		if (object.kind === "static") {
			if (
				(this.language === "python" && PYTHON_STRING_METHODS.has(name)) ||
				(this.language === "javascript" && JAVASCRIPT_STRING_METHODS.has(name))
			) {
				return { kind: "string" };
			}
			if (this.language === "javascript" && (name === "toString" || name === "valueOf")) return STATIC;
			this.mark("user", `inline script calls a method on an unproven value: ${name}`, false);
			return UNKNOWN;
		}
		if (object.kind === "bytes") {
			if (name === "decode" || name === "hex") return { kind: "string" };
			this.mark("user", `inline script calls an unsupported bytes method: ${name}`, false);
			return UNKNOWN;
		}
		this.mark("user", "inline script calls a method on a dynamic value", false);
		return UNKNOWN;
	}

	callModule(qualifiedName: string, args: ArgumentList, vars: Map<string, ScriptValue>): ScriptValue {
		const parts = qualifiedName.split(".");
		const moduleName = parts[0]!;
		const member = parts.slice(1).join(".");
		if (this.language === "python") return pythonModuleCall(this, moduleName, member, args, vars);
		return javascriptModuleCall(this, moduleName, member, args, vars);
	}
}

/**
 * Statically analyze a literal Python or JavaScript program embedded in a shell
 * command. This is a proof of a small finite subset, not a sandbox: anything the
 * analyzer cannot determine becomes user review.
 */
export function analyzeInlineScript(
	language: InlineScriptLanguage,
	source: string,
	input: ShellAnalysisInput,
	deadline: number = Date.now() + ANALYSIS_BUDGET_MS,
): ShellCommandAnalysis {
	if (language !== "python" && language !== "javascript") {
		return Object.freeze({
			disposition: "user",
			complete: false,
			reason: `unsupported inline script language: ${String(language)}`,
			readPaths: Object.freeze([]),
			writePaths: Object.freeze([]),
			networkEndpoints: Object.freeze([]) as readonly NetworkEndpoint[],
			effects: Object.freeze(["unknown"] as const),
			commands: Object.freeze([]),
		});
	}
	return new ScriptAnalyzer(language, source, input, deadline).run();
}
