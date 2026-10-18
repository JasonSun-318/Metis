import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const BASELINE_VERSION = 1;
const BASELINE_FILE = "scripts/baselines/presentation-boundaries.json";
const SOURCE_ROOT = "packages/coding-agent/src";
const CORE_DIRECTORY = `${SOURCE_ROOT}/core`;
const PRESENTATION_DIRECTORY = `${SOURCE_ROOT}/presentation`;
const MODES_DIRECTORY = `${SOURCE_ROOT}/modes`;
const RULES = ["core-to-modes", "presentation-to-modes", "runtime-presentation-to-core"];
const KINDS = ["runtime", "type"];
// core/presentation -> modes is reported for both kinds; presentation -> core
// is reported only at runtime so the existing type-only SourceInfo dependency
// and modes compatibility reexports toward presentation remain legal.
const RULE_ORDER = new Map(RULES.map((rule, index) => [rule, index]));
const KIND_ORDER = new Map(KINDS.map((kind, index) => [kind, index]));
const SCANNABLE_EXTENSION = /\.(?:[cm]?ts|tsx)$/i;
const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/i;
const IGNORED_DIRECTORIES = new Set([
	".artifacts",
	".cache",
	".claude",
	".codegraph",
	".cursor",
	".devin",
	".git",
	".next",
	".nyc_output",
	".turbo",
	".vite",
	".webpack",
	"artifacts",
	"build",
	"coverage",
	"dist",
	"docs",
	"generated",
	"logs",
	"node_modules",
	"out",
	"plans",
	"playwright-report",
	"reports",
	"test-results",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs"];
const JAVASCRIPT_EXTENSION_REPLACEMENTS = new Map([
	[".js", [".ts", ".tsx", ".d.ts"]],
	[".jsx", [".tsx", ".ts", ".d.ts"]],
	[".mjs", [".mts", ".d.mts"]],
	[".cjs", [".cts", ".d.cts"]],
]);
const DEFAULT_COMPILER_OPTIONS = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.Preserve,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowImportingTsExtensions: true,
	rewriteRelativeImportExtensions: true,
	jsx: ts.JsxEmit.Preserve,
	resolveJsonModule: true,
	skipLibCheck: true,
	experimentalDecorators: false,
	emitDecoratorMetadata: false,
	useDefineForClassFields: false,
	esModuleInterop: true,
	types: [],
	noEmit: false,
	noEmitOnError: false,
	emitDeclarationOnly: false,
	declaration: false,
	declarationMap: false,
	sourceMap: false,
	inlineSourceMap: false,
	incremental: false,
	composite: false,
	removeComments: true,
	noCheck: true,
};

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left, right) {
	return left.localeCompare(right, "en");
}

function portablePath(root, file) {
	return relative(root, resolve(file)).replaceAll("\\", "/") || ".";
}

function displayPath(root, file) {
	const path = portablePath(root, file);
	return path.startsWith("../") || path === ".." ? file : path;
}

function isSafeRelativePath(file) {
	if (typeof file !== "string" || file.length === 0) return false;
	if (file.includes("\\") || /[\u0000-\u001f]/u.test(file)) return false;
	if (isAbsolute(file) || /^[A-Za-z]:/.test(file)) return false;
	const segments = file.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
	return posix.normalize(file) === file;
}

function statPath(path) {
	try {
		const stats = statSync(path);
		return { exists: true, directory: stats.isDirectory(), file: stats.isFile() };
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { exists: false, directory: false, file: false };
		}
		return { exists: false, directory: false, file: false, error };
	}
}

function compilerOptionsFor(root) {
	const configPath = join(root, "tsconfig.json");
	if (!existsSync(configPath)) return { options: { ...DEFAULT_COMPILER_OPTIONS } };
	try {
		const read = ts.readConfigFile(configPath, ts.sys.readFile);
		if (read.error) {
			return {
				options: { ...DEFAULT_COMPILER_OPTIONS },
				error: `Cannot read ${displayPath(root, configPath)} for type/runtime classification: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
			};
		}
		const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
		const options = {
			...DEFAULT_COMPILER_OPTIONS,
			...parsed.options,
			// Emit in memory for classification, not for the build. Keep the
			// repository's semantic options (notably decorator metadata) while
			// forcing per-file ESM output.
			module: ts.ModuleKind.Preserve,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			allowImportingTsExtensions: true,
			rewriteRelativeImportExtensions: true,
			noEmit: false,
			noEmitOnError: false,
			emitDeclarationOnly: false,
			declaration: false,
			declarationMap: false,
			sourceMap: false,
			inlineSourceMap: false,
			incremental: false,
			composite: false,
			removeComments: true,
			noCheck: true,
		};
		// Code 18002/18003 only means the config's own include/files list is
		// empty; root names are supplied separately. Other config diagnostics
		// can invalidate the options we use for classification.
		const configErrors = parsed.errors.filter((error) => error.code !== 18002 && error.code !== 18003);
		if (configErrors.length > 0) {
			return {
				options,
				error: `Root tsconfig ${displayPath(root, configPath)} has configuration error(s): ${configErrors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ")}`,
			};
		}
		return { options };
	} catch (error) {
		return {
			options: { ...DEFAULT_COMPILER_OPTIONS },
			error: `Cannot parse ${displayPath(root, configPath)} for type/runtime classification: ${messageOf(error)}`,
		};
	}
}

function scopeOf(relativePath) {
	if (relativePath === CORE_DIRECTORY || relativePath.startsWith(`${CORE_DIRECTORY}/`)) return "core";
	if (relativePath === PRESENTATION_DIRECTORY || relativePath.startsWith(`${PRESENTATION_DIRECTORY}/`))
		return "presentation";
	if (relativePath === MODES_DIRECTORY || relativePath.startsWith(`${MODES_DIRECTORY}/`)) return "modes";
	return undefined;
}

function ruleFor(sourceScope, targetScope, kind) {
	if (sourceScope === "core" && targetScope === "modes") return "core-to-modes";
	if (sourceScope === "presentation" && targetScope === "modes") return "presentation-to-modes";
	if (sourceScope === "presentation" && targetScope === "core" && kind === "runtime") {
		return "runtime-presentation-to-core";
	}
	return undefined;
}

function scriptKindFor(fileName) {
	return /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function compareEdges(left, right) {
	return (
		compareText(left.source, right.source) ||
		compareText(left.target, right.target) ||
		(RULE_ORDER.get(left.rule) ?? RULES.length) - (RULE_ORDER.get(right.rule) ?? RULES.length) ||
		(KIND_ORDER.get(left.kind) ?? KINDS.length) - (KIND_ORDER.get(right.kind) ?? KINDS.length)
	);
}

function compareOccurrences(left, right) {
	return (
		compareEdges(left, right) ||
		left.line - right.line ||
		left.column - right.column ||
		compareText(left.form, right.form) ||
		compareText(left.specifier, right.specifier)
	);
}

function edgeKey(edge) {
	// Location and duplicate occurrences are deliberately excluded so line
	// moves and repeated imports do not churn the incremental baseline.
	return `${edge.source}\0${edge.target}\0${edge.rule}\0${edge.kind}`;
}

function identityOf(edge) {
	return { source: edge.source, target: edge.target, rule: edge.rule, kind: edge.kind };
}

function edgeLabel(edge) {
	return `${edge.source} -> ${edge.target} [${edge.rule}, ${edge.kind}]`;
}

function sourceFiles(root, diagnostics) {
	const sourceRoot = join(root, SOURCE_ROOT);
	const sourceRootStatus = statPath(sourceRoot);
	if (sourceRootStatus.error) {
		diagnostics.push({
			severity: "error",
			message: `Cannot access source root ${SOURCE_ROOT}: ${messageOf(sourceRootStatus.error)}`,
		});
		return [];
	}
	if (!sourceRootStatus.exists) {
		diagnostics.push({
			severity: "error",
			message: `Required source root ${SOURCE_ROOT} is missing; run from the repository root or pass --root.`,
		});
		return [];
	}
	if (!sourceRootStatus.directory) {
		diagnostics.push({ severity: "error", message: `Required source root ${SOURCE_ROOT} is not a directory` });
		return [];
	}
	const files = [];
	for (const [scope, directory] of [
		["core", CORE_DIRECTORY],
		["presentation", PRESENTATION_DIRECTORY],
	]) {
		const status = statPath(join(root, directory));
		if (status.error) {
			diagnostics.push({
				severity: "error",
				message: `Cannot access source directory ${directory}: ${messageOf(status.error)}`,
			});
			continue;
		}
		// A missing scope directory is a coverage error, not a clean scan: a
		// typo or partial checkout must not be recorded as an empty baseline.
		if (!status.exists) {
			diagnostics.push({
				severity: "error",
				message: `Required source directory ${directory} is missing; presentation boundary coverage is incomplete.`,
			});
			continue;
		}
		if (!status.directory) {
			diagnostics.push({ severity: "error", message: `Source directory ${directory} is not a directory` });
			continue;
		}
		walkSourceDirectory(root, join(root, directory), scope, files, diagnostics);
	}
	return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function walkSourceDirectory(root, directory, scope, files, diagnostics) {
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
			compareText(left.name, right.name),
		);
	} catch (error) {
		diagnostics.push({
			severity: "error",
			message: `Cannot read source directory ${portablePath(root, directory)}: ${messageOf(error)}`,
		});
		return;
	}
	for (const entry of entries) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
			walkSourceDirectory(root, absolute, scope, files, diagnostics);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!SCANNABLE_EXTENSION.test(entry.name) || DECLARATION_EXTENSION.test(entry.name)) continue;
		files.push({ absolute, relativePath: portablePath(root, absolute), scope });
	}
}

function positionOf(sourceFile, node) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return { line: line + 1, column: character + 1 };
}

function isRelativeOrAbsolute(specifier) {
	return specifier.startsWith(".") || isAbsolute(specifier);
}

function candidateFiles(base) {
	const extension = extname(base).toLowerCase();
	if (JAVASCRIPT_EXTENSION_REPLACEMENTS.has(extension)) {
		return [
			...JAVASCRIPT_EXTENSION_REPLACEMENTS.get(extension).map(
				(replacement) => `${base.slice(0, -extension.length)}${replacement}`,
			),
			base,
		];
	}
	if (extension) return [base];
	return [
		...SOURCE_EXTENSIONS.map((suffix) => `${base}${suffix}`),
		...SOURCE_EXTENSIONS.map((suffix) => join(base, `index${suffix}`)),
	];
}

function resolveSpecifier(sourceFile, specifier) {
	if (!isRelativeOrAbsolute(specifier)) return { external: true };
	const clean = specifier.replace(/[?#].*$/u, "");
	const base = isAbsolute(clean) ? resolve(clean) : resolve(dirname(sourceFile), clean);
	let accessError;
	for (const candidate of candidateFiles(base)) {
		const status = statPath(candidate);
		if (status.error) {
			accessError ??= status.error;
			continue;
		}
		if (status.exists && status.file) return { resolved: candidate };
	}
	return { error: accessError };
}

// Emit in memory so TypeScript's own elision decides whether an import or
// reexport is type-only. This recognizes explicit `type` modifiers, syntactic
// implicit type imports, and type-aware reexports; the original AST still
// drives edge detection and location reporting.
function runtimeModuleInfoFromEmitted(output, fileName, sourceAbsolute) {
	const emitted = ts.createSourceFile(
		`${fileName}.emitted`,
		output,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(fileName),
	);
	const imports = new Map();
	const exports = { names: new Set(), exportStar: false };
	const requires = new Set();
	const importInfo = (target) => {
		let info = imports.get(target);
		if (!info) {
			info = { locals: new Set(), sideEffect: false };
			imports.set(target, info);
		}
		return info;
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			// Emit may rewrite `.ts` specifiers to `.js`; resolve both sides to
			// the same source target before comparing type/runtime information.
			const resolved = resolveSpecifier(sourceAbsolute, node.moduleSpecifier.text);
			if (!resolved.resolved) {
				ts.forEachChild(node, visit);
				return;
			}
			const info = importInfo(resolve(resolved.resolved));
			if (!node.importClause) {
				info.sideEffect = true;
			} else {
				if (node.importClause.name) info.locals.add(node.importClause.name.text);
				const bindings = node.importClause.namedBindings;
				if (bindings) {
					if (ts.isNamespaceImport(bindings)) {
						info.locals.add(bindings.name.text);
					} else {
						for (const element of bindings.elements) info.locals.add(element.name.text);
					}
				}
			}
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			const clause = node.exportClause;
			if (!clause) {
				exports.exportStar = true;
			} else if (ts.isNamedExports(clause)) {
				for (const element of clause.elements) exports.names.add(element.name.text);
			} else if (ts.isNamespaceExport(clause)) {
				exports.names.add(clause.name.text);
			}
		} else if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "require" &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			// `import x = require()` is emitted as this call when it survives.
			const resolved = resolveSpecifier(sourceAbsolute, node.arguments[0].text);
			if (resolved.resolved) requires.add(resolve(resolved.resolved));
		}
		ts.forEachChild(node, visit);
	};
	visit(emitted);
	return { imports, exports, requires };
}

function runtimeModuleInfo(text, fileName, sourceAbsolute, compilerOptions) {
	const output = ts.transpileModule(text, {
		compilerOptions: {
			...compilerOptions,
			module: ts.ModuleKind.Preserve,
			noEmit: false,
			noEmitOnError: false,
		},
		fileName,
	}).outputText;
	return runtimeModuleInfoFromEmitted(output, fileName, sourceAbsolute);
}

function needsTypeAwareEmit(root, file, text, compilerOptions) {
	const mayEmitMetadata = compilerOptions.emitDecoratorMetadata && text.includes("@");
	if (!mayEmitMetadata && (!text.includes("export") || !text.includes("from"))) return false;
	const sourceFile = ts.createSourceFile(
		file.relativePath,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(file.relativePath),
	);
	let needed = false;
	const visit = (node) => {
		if (needed) return;
		// Metadata needs symbol resolution: imported classes survive, while
		// interfaces become Object and their imports can be erased.
		if (mayEmitMetadata && ts.canHaveDecorators(node) && ts.getDecorators(node)?.length) {
			needed = true;
			return;
		}
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			if (!node.isTypeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
				const names = node.exportClause.elements.filter((element) => !element.isTypeOnly);
				if (names.length > 0) {
					const resolved = resolveSpecifier(file.absolute, node.moduleSpecifier.text);
					if (resolved.resolved) {
						const targetScope = scopeOf(portablePath(root, resolved.resolved));
						if (targetScope === "modes" || (file.scope === "presentation" && targetScope === "core")) {
							needed = true;
							return;
						}
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return needed;
}

function emittedSourceMap(root, files, readFile, compilerOptions) {
	const candidates = files.filter((file) => {
		let text;
		try {
			text = readFile(file.absolute, "utf8");
		} catch {
			return false;
		}
		if (typeof text !== "string") return false;
		try {
			return needsTypeAwareEmit(root, file, text, compilerOptions);
		} catch {
			return false;
		}
	});
	if (candidates.length === 0) return { emitted: new Map() };
	const program = ts.createProgram(
		candidates.map((file) => file.absolute),
		compilerOptions,
	);
	const wanted = new Set(candidates.map((file) => resolve(file.absolute)));
	const emitted = new Map();
	program.emit(undefined, (fileName, text, _bom, _error, sources) => {
		if (!/\.(?:[cm]?js|jsx)$/i.test(fileName) || sources?.length !== 1) return;
		const source = resolve(sources[0].fileName);
		if (wanted.has(source)) emitted.set(source, text);
	});
	const missing = candidates.filter((file) => !emitted.has(resolve(file.absolute)));
	if (missing.length > 0) {
		return {
			emitted,
			error: `Type-aware emit produced no output for ${missing.map((file) => file.relativePath).join(", ")}; type/runtime classification is uncertain.`,
		};
	}
	return { emitted };
}

function staticImportBindingNames(clause) {
	const names = [];
	if (clause.name) names.push(clause.name.text);
	const bindings = clause.namedBindings;
	if (bindings) {
		if (ts.isNamespaceImport(bindings)) {
			names.push(bindings.name.text);
		} else {
			for (const element of bindings.elements) {
				if (!element.isTypeOnly) names.push(element.name.text);
			}
		}
	}
	return names;
}

function importTypeSpecifier(node) {
	if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
		return node.argument.literal;
	}
	return undefined;
}

function scanSourceFile(root, file, text, emittedText, compilerOptions, collect, diagnose) {
	const sourceFile = ts.createSourceFile(
		file.relativePath,
		text,
		ts.ScriptTarget.Latest,
		true,
		scriptKindFor(file.relativePath),
	);
	for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
		const position =
			typeof diagnostic.start === "number"
				? sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
				: { line: 0, character: 0 };
		diagnose({
			severity: "error",
			message: `Syntax error in ${file.relativePath}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
		});
	}
	let runtime;
	try {
		runtime =
			emittedText === undefined
				? runtimeModuleInfo(text, file.relativePath, file.absolute, compilerOptions)
				: runtimeModuleInfoFromEmitted(emittedText, file.relativePath, file.absolute);
	} catch (error) {
		diagnose({
			severity: "error",
			message: `Cannot classify runtime imports in ${file.relativePath}: ${messageOf(error)}`,
		});
		runtime = { imports: new Map(), exports: { names: new Set(), exportStar: false }, requires: new Set() };
	}

	const addReference = (literal, kind, form) => {
		const specifier = literal.text;
		if (!isRelativeOrAbsolute(specifier)) return;
		const position = positionOf(sourceFile, literal);
		const resolved = resolveSpecifier(file.absolute, specifier);
		if (!resolved.resolved) {
			const detail = resolved.error ? `: ${messageOf(resolved.error)}` : "";
			diagnose({
				severity: "error",
				message: `Cannot resolve module ${JSON.stringify(specifier)} in ${file.relativePath}:${position.line}:${position.column}${detail}`,
			});
			return;
		}
		const target = portablePath(root, resolved.resolved);
		const targetScope = scopeOf(target);
		if (!targetScope) return;
		const rule = ruleFor(file.scope, targetScope, kind);
		if (!rule) return;
		collect({
			source: file.relativePath,
			target,
			rule,
			kind,
			form,
			specifier,
			line: position.line,
			column: position.column,
		});
	};
	const addComputedReference = (node, description) => {
		const position = positionOf(sourceFile, node);
		diagnose({
			severity: "error",
			message: `Cannot statically resolve computed ${description} in ${file.relativePath}:${position.line}:${position.column}; presentation boundary coverage is incomplete.`,
		});
	};

	const visit = (node) => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			const clause = node.importClause;
			let kind = "runtime";
			if (!clause) {
				kind = "runtime";
			} else if (clause.isTypeOnly) {
				kind = "type";
			} else {
				const names = staticImportBindingNames(clause);
				const resolved = resolveSpecifier(file.absolute, node.moduleSpecifier.text);
				const info = resolved.resolved ? runtime.imports.get(resolve(resolved.resolved)) : undefined;
				if (names.length === 0) {
					kind = info?.sideEffect ? "runtime" : "type";
				} else {
					kind = names.some((name) => info?.locals.has(name)) ? "runtime" : "type";
				}
			}
			addReference(node.moduleSpecifier, kind, kind === "type" ? "type-import" : "import");
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			let kind = "runtime";
			if (node.isTypeOnly) {
				kind = "type";
			} else {
				const clause = node.exportClause;
				if (!clause) {
					kind = runtime.exports.exportStar ? "runtime" : "type";
				} else if (ts.isNamedExports(clause)) {
					const names = clause.elements.filter((element) => !element.isTypeOnly);
					kind = names.some((element) => runtime.exports.names.has(element.name.text)) ? "runtime" : "type";
				} else if (ts.isNamespaceExport(clause)) {
					kind = runtime.exports.names.has(clause.name.text) ? "runtime" : "type";
				}
			}
			addReference(node.moduleSpecifier, kind, kind === "type" ? "type-export" : "export");
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression &&
			ts.isStringLiteralLike(node.moduleReference.expression)
		) {
			const expression = node.moduleReference.expression;
			const resolved = resolveSpecifier(file.absolute, expression.text);
			const survives = resolved.resolved ? runtime.requires.has(resolve(resolved.resolved)) : false;
			const kind = node.isTypeOnly || !survives ? "type" : "runtime";
			addReference(expression, kind, kind === "type" ? "type-import-equals" : "import-equals");
		} else if (ts.isImportTypeNode(node)) {
			const literal = importTypeSpecifier(node);
			if (literal) addReference(literal, "type", "import-type");
			else addComputedReference(node, "import type");
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument)) addReference(argument, "runtime", "dynamic-import");
			else addComputedReference(node, "dynamic import()");
		} else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
			const argument = node.arguments[0];
			if (argument && ts.isStringLiteralLike(argument)) addReference(argument, "runtime", "require");
			else addComputedReference(node, "require()");
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

export function scanPresentationBoundaries(rootInput, options = {}) {
	const root = resolve(rootInput);
	const readFile = options.readFile ?? readFileSync;
	const diagnostics = [];
	const compiler = compilerOptionsFor(root);
	if (compiler.error) diagnostics.push({ severity: "error", message: compiler.error });
	const edgesByKey = new Map();
	const occurrences = [];
	const files = sourceFiles(root, diagnostics);
	let emitted;
	try {
		const result = emittedSourceMap(root, files, readFile, compiler.options);
		emitted = result.emitted;
		if (result.error) diagnostics.push({ severity: "error", message: result.error });
	} catch (error) {
		diagnostics.push({
			severity: "error",
			message: `Type-aware emit failed (${messageOf(error)}); falling back to per-file transpilation for type/runtime classification.`,
		});
		emitted = new Map();
	}
	let filesScanned = 0;
	for (const file of files) {
		let text;
		try {
			text = readFile(file.absolute, "utf8");
		} catch (error) {
			diagnostics.push({
				severity: "error",
				message: `Cannot read source file ${file.relativePath}: ${messageOf(error)}`,
			});
			continue;
		}
		if (typeof text !== "string") {
			diagnostics.push({
				severity: "error",
				message: `Cannot read source file ${file.relativePath}: reader did not return text`,
			});
			continue;
		}
		filesScanned++;
		try {
			scanSourceFile(
				root,
				file,
				text,
				emitted.get(resolve(file.absolute)),
				compiler.options,
				(occurrence) => {
					const identity = identityOf(occurrence);
					const key = edgeKey(identity);
					if (!edgesByKey.has(key)) edgesByKey.set(key, identity);
					occurrences.push(occurrence);
				},
				(diagnostic) => diagnostics.push(diagnostic),
			);
		} catch (error) {
			diagnostics.push({
				severity: "error",
				message: `Cannot scan source file ${file.relativePath}: ${messageOf(error)}`,
			});
		}
	}
	const edges = [...edgesByKey.values()].sort(compareEdges);
	occurrences.sort(compareOccurrences);
	const snapshot = { version: BASELINE_VERSION, edges: edges.map(identityOf) };
	return {
		root,
		version: BASELINE_VERSION,
		filesScanned,
		edges,
		occurrences,
		diagnostics,
		incomplete: diagnostics.some((diagnostic) => diagnostic.severity === "error"),
		snapshot,
	};
}

function edgeList(value) {
	if (Array.isArray(value)) return value;
	if (isRecord(value) && Array.isArray(value.edges)) return value.edges;
	return [];
}

export function presentationBoundaryChanges(actual, baseline) {
	const actualByKey = new Map(edgeList(actual).map((edge) => [edgeKey(identityOf(edge)), identityOf(edge)]));
	const baselineByKey = new Map(edgeList(baseline).map((edge) => [edgeKey(identityOf(edge)), identityOf(edge)]));
	const added = [];
	const removed = [];
	const unchanged = [];
	for (const [key, edge] of actualByKey) {
		if (baselineByKey.has(key)) unchanged.push(edge);
		else added.push(edge);
	}
	for (const [key, edge] of baselineByKey) {
		if (!actualByKey.has(key)) removed.push(edge);
	}
	added.sort(compareEdges);
	removed.sort(compareEdges);
	unchanged.sort(compareEdges);
	return { added, removed, unchanged };
}

export function validatePresentationBoundaryBaseline(value) {
	if (!isRecord(value)) return "baseline must contain a JSON object";
	if (value.version !== BASELINE_VERSION) return `unsupported baseline version ${JSON.stringify(value.version)}`;
	if (!Array.isArray(value.edges)) return "baseline edges must be an array";
	const identities = new Set();
	for (const [index, edge] of value.edges.entries()) {
		if (!isRecord(edge)) return `baseline edge ${index} is not an object`;
		if (typeof edge.source !== "string" || !isSafeRelativePath(edge.source)) {
			return `baseline edge ${index} has an unsafe or non-relative source path ${JSON.stringify(edge.source)}`;
		}
		if (typeof edge.target !== "string" || !isSafeRelativePath(edge.target)) {
			return `baseline edge ${index} has an unsafe or non-relative target path ${JSON.stringify(edge.target)}`;
		}
		if (!RULES.includes(edge.rule)) {
			return `baseline edge ${index} has an invalid rule ${JSON.stringify(edge.rule)}`;
		}
		if (!KINDS.includes(edge.kind)) {
			return `baseline edge ${index} has an invalid kind ${JSON.stringify(edge.kind)}`;
		}
		const sourceScope = scopeOf(edge.source);
		const targetScope = scopeOf(edge.target);
		if (edge.rule === "core-to-modes" && (sourceScope !== "core" || targetScope !== "modes")) {
			return `baseline edge ${index} core-to-modes source/target are outside the expected core -> modes scope`;
		}
		if (edge.rule === "presentation-to-modes" && (sourceScope !== "presentation" || targetScope !== "modes")) {
			return `baseline edge ${index} presentation-to-modes source/target are outside the expected presentation -> modes scope`;
		}
		if (
			edge.rule === "runtime-presentation-to-core" &&
			(sourceScope !== "presentation" || targetScope !== "core" || edge.kind !== "runtime")
		) {
			return `baseline edge ${index} runtime-presentation-to-core is not a runtime presentation -> core edge`;
		}
		const identity = edgeKey(edge);
		if (identities.has(identity)) return `baseline contains a duplicate edge identity: ${edgeLabel(edge)}`;
		identities.add(identity);
	}
	return undefined;
}

function loadBaseline(root, baselinePath) {
	const displayed = displayPath(root, baselinePath);
	if (!existsSync(baselinePath)) {
		return {
			error: `Baseline ${displayed} is missing; run node scripts/check-presentation-boundaries.mjs --update after reviewing boundaries.`,
		};
	}
	try {
		const value = JSON.parse(readFileSync(baselinePath, "utf8"));
		const invalid = validatePresentationBoundaryBaseline(value);
		return invalid ? { error: `Baseline ${displayed} is invalid: ${invalid}` } : { baseline: value };
	} catch (error) {
		return { error: `Baseline ${displayed} is not valid JSON: ${messageOf(error)}` };
	}
}

function firstOccurrenceMap(occurrences) {
	const map = new Map();
	for (const occurrence of occurrences) {
		const key = edgeKey(occurrence);
		if (!map.has(key)) map.set(key, occurrence);
	}
	return map;
}

function printEdgeSection(title, edges, occurrences) {
	console.log(`  ${title} (${edges.length}):`);
	if (edges.length === 0) {
		console.log("    none");
		return;
	}
	for (const edge of edges) {
		const occurrence = occurrences.get(edgeKey(edge));
		const location = occurrence ? `${edge.source}:${occurrence.line}:${occurrence.column}` : edge.source;
		console.log(`    ${location} -> ${edge.target} [${edge.rule}, ${edge.kind}]`);
	}
}

function printReport(root, result, baselinePath) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	console.log(
		"Presentation boundary report (advisory; no source or baseline was modified). Checks direct core -> modes and presentation -> modes imports/reexports, plus runtime presentation -> core imports. Type-only presentation -> core dependencies and modes -> presentation compatibility reexports are allowed.",
	);
	if (errors.length > 0) {
		console.log(`Scan incomplete: ${errors.length} error(s) prevented a complete conclusion.`);
		for (const error of errors) console.error(`  ${error.message}`);
	}
	const occurrenceMap = firstOccurrenceMap(result.occurrences);
	if (result.edges.length > 0) {
		console.log("Boundary edges detected:");
		for (const edge of result.edges) {
			const occurrence = occurrenceMap.get(edgeKey(edge));
			const location = occurrence ? `${edge.source}:${occurrence.line}:${occurrence.column}` : edge.source;
			console.log(`  ${location} -> ${edge.target} [${edge.rule}, ${edge.kind}]`);
		}
	} else if (errors.length === 0) {
		console.log("No presentation boundary edges detected.");
	} else {
		console.log("No definite presentation boundary edges were identified by the incomplete scan.");
	}
	console.log(
		`Scanned ${result.filesScanned} production source file(s) under ${CORE_DIRECTORY} and ${PRESENTATION_DIRECTORY}; ${result.edges.length} edge(s), ${result.occurrences.length} occurrence(s).`,
	);
	if (result.incomplete) {
		console.log(
			"Incremental comparison skipped because the scan is incomplete; no conclusion about new boundaries was reached. No files changed.",
		);
		return;
	}
	const loaded = loadBaseline(root, baselinePath);
	if (loaded.error) {
		console.error(loaded.error);
		console.log("Incremental comparison skipped; no conclusion about new boundaries was reached. No files changed.");
		return;
	}
	const changes = presentationBoundaryChanges(result.snapshot, loaded.baseline);
	console.log(`Incremental comparison against ${displayPath(root, baselinePath)}:`);
	printEdgeSection("New boundary edges", changes.added, occurrenceMap);
	printEdgeSection("Removed baseline boundary edges", changes.removed, occurrenceMap);
	printEdgeSection("Unchanged boundary edges", changes.unchanged, occurrenceMap);
	console.log("No files changed.");
}

function runUpdate(root, result, baselinePath) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) {
		console.error("Refusing to update the presentation boundary baseline from an incomplete scan:");
		for (const error of errors) console.error(`  ${error.message}`);
		console.error("No files changed.");
		process.exitCode = 1;
		return;
	}
	try {
		mkdirSync(dirname(baselinePath), { recursive: true });
		writeFileSync(baselinePath, `${JSON.stringify(result.snapshot, null, "\t")}\n`);
	} catch (error) {
		console.error(
			`Failed to write presentation boundary baseline ${displayPath(root, baselinePath)}: ${messageOf(error)}`,
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		`Updated advisory presentation boundary baseline (${result.edges.length} edge(s)). Review the diff before committing.`,
	);
}

function parseCli(args) {
	let rootInput = process.cwd();
	let baselineInput = BASELINE_FILE;
	let update = false;
	let rootSet = false;
	let baselineSet = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--update") {
			if (update) return { error: "--update was provided more than once" };
			update = true;
			continue;
		}
		if (argument === "--root" || argument === "--baseline") {
			if (argument === "--root" && rootSet) return { error: "--root was provided more than once" };
			if (argument === "--baseline" && baselineSet) return { error: "--baseline was provided more than once" };
			const value = args[index + 1];
			if (!value || value.startsWith("--")) return { error: `${argument} requires a path` };
			index++;
			if (argument === "--root") {
				rootInput = value;
				rootSet = true;
			} else {
				baselineInput = value;
				baselineSet = true;
			}
			continue;
		}
		return { error: `Unknown argument ${JSON.stringify(argument)}` };
	}
	const root = resolve(process.cwd(), rootInput);
	const baselinePath = isAbsolute(baselineInput) ? baselineInput : resolve(root, baselineInput);
	return { root, baselinePath, update };
}

function main() {
	const parsed = parseCli(process.argv.slice(2));
	if (parsed.error) {
		console.error(parsed.error);
		console.error(
			"Usage: node scripts/check-presentation-boundaries.mjs [--root <dir>] [--baseline <file>] [--update]",
		);
		process.exitCode = 2;
		return;
	}
	let result;
	try {
		result = scanPresentationBoundaries(parsed.root);
	} catch (error) {
		console.error(`Presentation boundary scan failed: ${messageOf(error)}`);
		console.error("Scan incomplete; no conclusion was reached. No files changed.");
		if (parsed.update) process.exitCode = 1;
		return;
	}
	try {
		if (parsed.update) runUpdate(parsed.root, result, parsed.baselinePath);
		else printReport(parsed.root, result, parsed.baselinePath);
	} catch (error) {
		console.error(`Presentation boundary report failed: ${messageOf(error)}`);
		console.error("Scan incomplete; no conclusion was reached. No files changed.");
		if (parsed.update) process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
