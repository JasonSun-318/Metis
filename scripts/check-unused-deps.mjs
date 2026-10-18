import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const BASELINE_VERSION = 1;
const BASELINE_FILE = "scripts/baselines/unused-deps.json";
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SECTION_ORDER = new Map(DEPENDENCY_SECTIONS.map((section, index) => [section, index]));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
	".artifacts",
	".cache",
	".claude",
	".codegraph",
	".cursor",
	".devin",
	".git",
	".github",
	".native-tools-cache",
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
const BUILT_IN_BINS = new Map([
	["biome", "@biomejs/biome"],
	["electron-forge", "@electron-forge/cli"],
	["esbuild", "esbuild"],
	["husky", "husky"],
	["jiti", "jiti"],
	["playwright", "@playwright/test"],
	["shx", "shx"],
	["tsc", "typescript"],
	["tsgo", "@typescript/native-preview"],
	["tsserver", "typescript"],
	["tsx", "tsx"],
	["vitest", "vitest"],
]);
const PLATFORM_PACKAGE_PATTERNS = [
	/^fsevents$/,
	/^node-pty$/,
	/^@esbuild\//,
	/^@rollup\/rollup-/,
	/^@swc\/core-/,
	/^@silvia-odwyer\/photon-node$/,
];

const portablePath = (root, file) => relative(root, file).replaceAll("\\", "/");

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function flattenDiagnostic(diagnostic) {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function workspacePatterns(value) {
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
	if (isRecord(value) && Array.isArray(value.packages)) {
		return value.packages.filter((entry) => typeof entry === "string");
	}
	return [];
}

function globToRegExp(pattern) {
	const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	let source = "";
	for (let index = 0; index < normalized.length; index++) {
		const character = normalized[index];
		if (character === "*" && normalized[index + 1] === "*") {
			if (normalized[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index += 1;
			}
		} else if (character === "*") {
			source += "[^/]*";
		} else if (character === "?") {
			source += "[^/]";
		} else {
			source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

function expandWorkspaceDirectories(baseDirectory, patterns) {
	const positive = [];
	const negative = [];
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) negative.push(globToRegExp(pattern.slice(1)));
		else if (pattern && pattern !== ".") positive.push(globToRegExp(pattern));
	}
	if (positive.length === 0) return [];
	const found = new Set();
	function walk(directory, depth) {
		if (depth > 16) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
			const child = join(directory, entry.name);
			const relativePath = portablePath(baseDirectory, child);
			if (positive.some((pattern) => pattern.test(relativePath)) && existsSync(join(child, "package.json"))) {
				found.add(resolve(child));
			}
			walk(child, depth + 1);
		}
	}
	walk(baseDirectory, 0);
	for (const pattern of negative) {
		for (const directory of [...found]) {
			if (pattern.test(portablePath(baseDirectory, directory))) found.delete(directory);
		}
	}
	return [...found].sort();
}

function discoverManifests(root, diagnostics) {
	const rootDirectory = resolve(root);
	const records = [];
	const seen = new Set();
	const queue = [{ directory: rootDirectory, manifestPath: join(rootDirectory, "package.json"), root: true }];
	while (queue.length > 0) {
		const current = queue.shift();
		if (seen.has(current.directory)) continue;
		seen.add(current.directory);
		const relativePath = portablePath(rootDirectory, current.manifestPath);
		let manifest;
		try {
			manifest = readJsonFile(current.manifestPath);
		} catch (error) {
			diagnostics.push({ severity: "error", message: `Cannot read manifest ${relativePath}: ${messageOf(error)}` });
			records.push({
				directory: current.directory,
				path: current.manifestPath,
				relativePath,
				manifest: null,
				root: current.root,
			});
			continue;
		}
		if (!isRecord(manifest)) {
			diagnostics.push({ severity: "error", message: `Manifest ${relativePath} does not contain a JSON object` });
			records.push({
				directory: current.directory,
				path: current.manifestPath,
				relativePath,
				manifest: null,
				root: current.root,
			});
			continue;
		}
		records.push({
			directory: current.directory,
			path: current.manifestPath,
			relativePath,
			manifest,
			root: current.root,
		});
		for (const directory of expandWorkspaceDirectories(current.directory, workspacePatterns(manifest.workspaces))) {
			queue.push({ directory, manifestPath: join(directory, "package.json"), root: false });
		}
	}
	return records.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

function installedManifest(root, fromDirectory, name, cache) {
	const cacheKey = `${resolve(fromDirectory)}\0${name}`;
	if (cache.has(cacheKey)) return cache.get(cacheKey);
	const parts = name.split("/");
	const stop = resolve(root);
	let directory = resolve(fromDirectory);
	let result = null;
	while (true) {
		const candidate = join(directory, "node_modules", ...parts, "package.json");
		if (existsSync(candidate)) {
			try {
				const manifest = readJsonFile(candidate);
				if (isRecord(manifest)) result = { path: candidate, manifest };
				break;
			} catch {
				break;
			}
		}
		if (directory === stop) break;
		const parent = dirname(directory);
		if (parent === directory || !directory.startsWith(`${stop}${sep}`)) break;
		directory = parent;
	}
	cache.set(cacheKey, result);
	return result;
}

function binNames(bin, packageName) {
	if (typeof bin === "string" && bin) {
		return [packageName.startsWith("@") ? (packageName.split("/")[1] ?? packageName) : packageName];
	}
	if (isRecord(bin)) return Object.keys(bin);
	return [];
}

function collectInstalledInformation(root, manifests) {
	const cache = new Map();
	const bins = new Map();
	const addBin = (bin, packageName) => {
		if (typeof bin !== "string" || !bin) return;
		if (!bins.has(bin)) bins.set(bin, new Set());
		bins.get(bin).add(packageName);
	};
	const addManifestBins = (manifest, packageName) => {
		for (const bin of binNames(manifest.bin, packageName)) addBin(bin, packageName);
	};
	for (const record of manifests) {
		if (!record.manifest) continue;
		const packageName = typeof record.manifest.name === "string" ? record.manifest.name : record.relativePath;
		addManifestBins(record.manifest, packageName);
	}
	for (const record of manifests) {
		if (!record.manifest) continue;
		for (const section of DEPENDENCY_SECTIONS) {
			const dependencies = record.manifest[section];
			if (!isRecord(dependencies)) continue;
			for (const name of Object.keys(dependencies)) {
				const installed = installedManifest(root, record.directory, name, cache);
				if (installed?.manifest) addManifestBins(installed.manifest, name);
			}
		}
	}
	for (const [bin, packageName] of BUILT_IN_BINS) addBin(bin, packageName);
	return { cache, bins };
}

function resolveExtends(specifier, fromDirectory) {
	if (typeof specifier !== "string" || !specifier) return null;
	if (specifier.startsWith(".") || specifier.startsWith("/")) {
		const base = resolve(fromDirectory, specifier);
		for (const candidate of [base, `${base}.json`, join(base, "tsconfig.json")]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	try {
		const require = createRequire(join(fromDirectory, "__metis_tsconfig__.cjs"));
		return require.resolve(specifier);
	} catch {
		const candidate = join(fromDirectory, "node_modules", ...specifier.split("/"));
		for (const path of [candidate, `${candidate}.json`, join(candidate, "tsconfig.json")]) {
			if (existsSync(path) && statSync(path).isFile()) return path;
		}
		return null;
	}
}

function readTsconfigOptions(root, file, diagnostics, seen = new Set()) {
	const relativePath = portablePath(root, file);
	if (seen.has(file)) return { options: {}, extendsPackages: new Set() };
	seen.add(file);
	let read;
	try {
		read = ts.readConfigFile(file, ts.sys.readFile);
	} catch (error) {
		diagnostics.push({ severity: "error", message: `Cannot read ${relativePath}: ${messageOf(error)}` });
		return { options: {}, extendsPackages: new Set() };
	}
	if (read.error) {
		diagnostics.push({ severity: "error", message: `Cannot read ${relativePath}: ${flattenDiagnostic(read.error)}` });
		return { options: {}, extendsPackages: new Set() };
	}
	const config = isRecord(read.config) ? read.config : {};
	const inheritedOptions = {};
	const extendsPackages = new Set();
	const extended = Array.isArray(config.extends) ? config.extends : [config.extends];
	for (const entry of extended) {
		if (typeof entry !== "string") continue;
		if (!entry.startsWith(".") && !entry.startsWith("/")) {
			const packageName = packageNameFromSpecifier(entry);
			if (packageName) extendsPackages.add(packageName);
		}
		const extendedPath = resolveExtends(entry, dirname(file));
		if (!extendedPath) continue;
		const inherited = readTsconfigOptions(root, extendedPath, diagnostics, seen);
		Object.assign(inheritedOptions, inherited.options);
		for (const packageName of inherited.extendsPackages) extendsPackages.add(packageName);
	}
	const options = isRecord(config.compilerOptions) ? config.compilerOptions : {};
	return { options: { ...inheritedOptions, ...options }, extendsPackages };
}

function typePackageNames(typeName) {
	if (typeof typeName !== "string") return [];
	const base = packageNameFromSpecifier(typeName);
	if (!base) return [];
	const names = [base];
	if (base.startsWith("@types/")) return names;
	if (base.startsWith("@")) {
		const [scope, name] = base.slice(1).split("/");
		if (scope && name) names.push(`@types/${scope}__${name}`);
	} else {
		names.push(`@types/${base}`);
	}
	return names;
}

function isIgnoredFile(fileName) {
	const lower = fileName.toLowerCase();
	return (
		/\.generated\.[^/]+$/.test(lower) ||
		/(?:^|[.-])generated[.-]/.test(lower) ||
		/\.min\.(?:js|mjs|cjs)$/.test(lower) ||
		/\.report\.[^/]+$/.test(lower) ||
		/\.(?:map|snap)$/.test(lower)
	);
}

function isTsconfig(fileName) {
	return /^tsconfig(?:\..+)?\.json$/i.test(basename(fileName));
}

function collectOwnerFiles(root, owner, manifests) {
	const nested = new Set(
		manifests
			.filter(
				(record) => record.directory !== owner.directory && record.directory.startsWith(`${owner.directory}${sep}`),
			)
			.map((record) => resolve(record.directory)),
	);
	const sources = [];
	const tsconfigs = [];
	const jsonConfigs = [];
	function walk(directory) {
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			owner.diagnostics.push({
				severity: "error",
				message: `Cannot read directory ${portablePath(root, directory)}: ${messageOf(error)}`,
			});
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name) || nested.has(resolve(path)))
					continue;
				walk(path);
				continue;
			}
			if (!entry.isFile()) continue;
			const relativePath = portablePath(owner.directory, path);
			if (isIgnoredFile(relativePath)) continue;
			if (isTsconfig(path)) {
				tsconfigs.push(path);
				continue;
			}
			if (extname(entry.name) === ".json" && isConfigFile(path)) {
				jsonConfigs.push(path);
				continue;
			}
			if (SOURCE_EXTENSIONS.has(extname(entry.name))) sources.push(path);
		}
	}
	walk(owner.directory);
	return { sources: sources.sort(), tsconfigs: tsconfigs.sort(), jsonConfigs: jsonConfigs.sort() };
}

function scriptKind(fileName) {
	switch (extname(fileName)) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
			return ts.ScriptKind.JSX;
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function literalText(node) {
	if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
	return undefined;
}

function startsWithRelativeLiteral(node) {
	let current = node;
	while (ts.isParenthesizedExpression(current)) current = current.expression;
	if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		return startsWithRelativeLiteral(current.left);
	}
	if (ts.isTemplateExpression(current)) return current.head.text.startsWith(".") || current.head.text.startsWith("/");
	const text = literalText(current);
	return text !== undefined && (text.startsWith(".") || text.startsWith("/"));
}

function isJsxNode(node) {
	return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node);
}

function callKind(node) {
	if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return "dynamic import";
	let expression = node.expression;
	while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
	if (ts.isIdentifier(expression) && expression.text === "require") return "require";
	if (ts.isPropertyAccessExpression(expression)) {
		if (
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === "require" &&
			expression.name.text === "resolve"
		) {
			return "require.resolve";
		}
		if (
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === "module" &&
			expression.name.text === "require"
		) {
			return "module.require";
		}
		if (
			expression.name.text === "resolve" &&
			ts.isMetaProperty(expression.expression) &&
			expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
			expression.expression.name.text === "meta"
		) {
			return "import.meta.resolve";
		}
	}
	return undefined;
}

function sourceEvidence(sourceFile, text) {
	const specifiers = [];
	const typeReferences = [];
	const uncertainties = [];
	const coverageProviders = [];
	const stringLiterals = [];
	const environments = [];
	let hasJsx = false;
	function addSpecifier(node) {
		const value = literalText(node);
		if (value !== undefined) {
			specifiers.push(value);
			return;
		}
		uncertainties.push({ node, kind: "non-literal module specifier" });
	}
	function visit(node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) addSpecifier(node.moduleSpecifier);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression
		) {
			addSpecifier(node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			if (ts.isLiteralTypeNode(argument)) addSpecifier(argument.literal);
			else uncertainties.push({ node, kind: "non-literal import type" });
		} else if (ts.isCallExpression(node)) {
			const kind = callKind(node);
			if (kind) {
				const argument = node.arguments[0];
				const value = argument ? literalText(argument) : undefined;
				if (value !== undefined) specifiers.push(value);
				else if (argument && !startsWithRelativeLiteral(argument)) uncertainties.push({ node, kind });
			}
		}
		if (ts.isPropertyAssignment(node)) {
			const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
			if (name === "provider") {
				const provider = literalText(node.initializer);
				if (provider) coverageProviders.push(provider);
			}
		}
		if (ts.isStringLiteralLike(node)) stringLiterals.push(node.text);
		if (isJsxNode(node)) hasJsx = true;
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	for (const directive of sourceFile.typeReferenceDirectives) typeReferences.push(directive.fileName);
	for (const match of text.matchAll(/@vitest-environment\s+([^\s*]+)/g)) environments.push(match[1]);
	return {
		specifiers,
		typeReferences,
		coverageProviders,
		stringLiterals,
		environments,
		uncertainties: uncertainties.map(({ node, kind }) => {
			const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			return { kind, line: position.line + 1, column: position.character + 1 };
		}),
		hasJsx,
		jsxImportSource: /@jsxImportSource\s+([^\s*]+)/.exec(text.slice(0, 4000))?.[1],
	};
}

function stringLeaves(value) {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringLeaves);
	if (isRecord(value)) return Object.values(value).flatMap(stringLeaves);
	return [];
}

function aliasMatch(pattern, specifier) {
	if (!pattern.includes("*")) return pattern === specifier ? "" : undefined;
	const [prefix, suffix] = pattern.split("*");
	if (specifier.length < prefix.length + suffix.length) return undefined;
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
	return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function applyAlias(pattern, replacement, specifier) {
	const captured = aliasMatch(pattern, specifier);
	if (captured === undefined) return [];
	return stringLeaves(replacement).map((target) => target.replaceAll("*", captured));
}

function importAliasTargets(specifier, manifest) {
	if (!specifier.startsWith("#") || !isRecord(manifest.imports)) return [];
	const targets = [];
	for (const [pattern, replacement] of Object.entries(manifest.imports)) {
		targets.push(...applyAlias(pattern, replacement, specifier));
	}
	return targets;
}

function pathAliasTargets(specifier, owner) {
	const targets = [];
	for (const [pattern, replacements] of owner.paths) {
		targets.push(...applyAlias(pattern, replacements, specifier));
	}
	return targets;
}

function cleanSpecifier(specifier) {
	const trimmed = specifier.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("#")) return undefined;
	const withoutQuery = trimmed.replace(/[?#].*$/, "");
	if (!withoutQuery) return undefined;
	if (withoutQuery.startsWith(".") || withoutQuery.startsWith("/") || withoutQuery.startsWith("\\")) return undefined;
	return withoutQuery;
}

function packageNameFromSpecifier(specifier) {
	const cleaned = cleanSpecifier(specifier);
	if (!cleaned) return undefined;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)) return undefined;
	if (isBuiltin(cleaned)) return undefined;
	if (cleaned.startsWith("@")) {
		const [scope, name] = cleaned.split("/");
		return scope && name ? `${scope}/${name}` : cleaned;
	}
	return cleaned.split("/")[0];
}

function resolvedSpecifierNames(specifier, owner) {
	const names = [];
	const seen = new Set();
	const queue = [specifier];
	const addName = (candidate) => {
		const name = packageNameFromSpecifier(candidate);
		if (name) names.push(name);
	};
	while (queue.length > 0) {
		const current = queue.shift();
		if (typeof current !== "string" || seen.has(current)) continue;
		seen.add(current);
		const cleaned = cleanSpecifier(current);
		if (cleaned && (cleaned.startsWith("node:") || isBuiltin(cleaned))) {
			owner.usesNodeBuiltin = true;
			continue;
		}
		addName(current);
		if (current.startsWith("#")) {
			for (const target of importAliasTargets(current, owner.manifest)) {
				if (target.startsWith("#")) queue.push(target);
				else addName(target);
			}
		}
		if (current === specifier) {
			for (const target of pathAliasTargets(current, owner)) {
				if (target.startsWith("#")) queue.push(target);
				else addName(target);
			}
		}
	}
	return [...new Set(names)];
}

function markTypes(owner, typeNames, rootOwner) {
	for (const typeName of typeNames) {
		for (const name of typePackageNames(typeName)) {
			owner.used.add(name);
			if (rootOwner && owner !== rootOwner) rootOwner.used.add(name);
		}
	}
}

function isConfigFile(fileName) {
	const lower = basename(fileName).toLowerCase();
	return (
		/(?:^|[._-])(?:config|conf)(?:[._-]|$)/.test(lower) ||
		/^(?:babel|electron-builder|esbuild|forge|jest|playwright|rollup|swc|tsup|vite|vitest|webpack)[.-]/.test(lower) ||
		/\.config\./.test(lower)
	);
}

function isScriptFile(owner, fileName) {
	const segments = portablePath(owner.directory, fileName).split("/");
	return segments.slice(0, -1).includes("scripts");
}

function splitCommandSegments(value) {
	return value.split(/\r?\n|&&|\|\||;|\|/);
}

function commandTokens(segment) {
	const tokens = [];
	const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
	for (;;) {
		const match = pattern.exec(segment);
		if (!match) break;
		tokens.push(match[1] ?? match[2] ?? match[3]);
	}
	return tokens;
}

function commandPackageToken(token) {
	if (!token || token.startsWith("-") || token.startsWith("$") || token.startsWith(".") || token.startsWith("/")) {
		return undefined;
	}
	const unversioned = token.startsWith("@")
		? token.slice(0, token.indexOf("@", 1) === -1 ? token.length : token.indexOf("@", 1))
		: token.split("@")[0];
	return packageNameFromSpecifier(unversioned);
}

function markScripts(owner, manifest, rootOwner) {
	if (!isRecord(manifest.scripts)) return;
	const markUse = (name) => {
		if (!name) return;
		owner.used.add(name);
		if (rootOwner && owner !== rootOwner) rootOwner.used.add(name);
	};
	const markCommand = (command) => {
		const bin = basename(command.replaceAll("\\", "/")).replace(/\.(?:cmd|exe|ps1)$/i, "");
		if (!bin || bin.startsWith("$")) return;
		owner.commands.add(bin);
		if (rootOwner && owner !== rootOwner) rootOwner.commands.add(bin);
	};
	const markRunner = (token) => {
		const name = commandPackageToken(token);
		if (!name) return;
		markUse(name);
		markCommand(name);
	};
	for (const script of Object.values(manifest.scripts)) {
		if (typeof script !== "string") continue;
		for (const segment of splitCommandSegments(script)) {
			const tokens = commandTokens(segment);
			while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
			let command = tokens.shift();
			if (!command) continue;
			if (command === "cross-env") {
				markUse("cross-env");
				while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
				command = tokens.shift();
			}
			if (!command) continue;
			const packageRunner = command === "npx" || command === "pnpx" || command === "bunx";
			if (packageRunner) {
				const index = tokens.findIndex((token) => !token.startsWith("-"));
				if (index !== -1) markRunner(tokens[index]);
				continue;
			}
			if (command === "npm" || command === "pnpm" || command === "yarn" || command === "bun") {
				const subcommand = tokens.shift();
				if (subcommand !== "exec" && subcommand !== "dlx" && !(command === "bun" && subcommand === "x")) continue;
				const index = tokens.findIndex((token) => !token.startsWith("-"));
				if (index !== -1) markRunner(tokens[index]);
				continue;
			}
			markCommand(command);
			const bin = basename(command.replaceAll("\\", "/")).replace(/\.(?:cmd|exe|ps1)$/i, "");
			if (bin === "node" || bin === "nodejs") {
				for (let index = 0; index < tokens.length; index++) {
					const token = tokens[index];
					// Arguments after the entrypoint belong to the application, not Node.
					if (!token.startsWith("-") || token === "--") break;
					if (["-e", "--eval", "-p", "--print"].includes(token)) break;
					if (["--import", "--require", "-r", "--loader", "--experimental-loader"].includes(token)) {
						const specifier = tokens[++index];
						if (specifier) markUse(packageNameFromSpecifier(specifier));
					} else {
						const inline = /^(?:--(?:import|require|loader|experimental-loader)=|-r)(.+)$/.exec(token);
						if (inline) markUse(packageNameFromSpecifier(inline[1]));
					}
				}
			}
			if (bin === "vitest" && tokens.some((token) => token === "--coverage" || token.startsWith("--coverage."))) {
				markUse("@vitest/coverage-v8");
				markUse("@vitest/coverage-istanbul");
			}
		}
	}
}

function markPackageConfigStrings(owner, manifest, rootOwner) {
	if (!isRecord(manifest.config)) return;
	const visit = (value) => {
		if (typeof value === "string") {
			for (const segment of splitCommandSegments(value)) {
				for (const token of commandTokens(segment)) {
					const name = commandPackageToken(token);
					if (!name) continue;
					owner.used.add(name);
					if (rootOwner && owner !== rootOwner) rootOwner.used.add(name);
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
		} else if (isRecord(value)) {
			for (const entry of Object.values(value)) visit(entry);
		}
	};
	for (const value of Object.values(manifest.config)) visit(value);
}

function createOwner(root, record, diagnostics) {
	const manifest = record.manifest ?? {};
	const owner = {
		record,
		directory: record.directory,
		relativePath: record.relativePath,
		manifest,
		diagnostics,
		used: new Set(),
		commands: new Set(),
		uncertainties: [],
		paths: [],
		jsxImportSources: new Set(),
		usesNodeBuiltin: false,
		filesScanned: 0,
	};
	const files = collectOwnerFiles(root, owner, record.allManifests);
	for (const file of files.tsconfigs) {
		const parsed = readTsconfigOptions(root, file, diagnostics, new Set());
		for (const packageName of parsed.extendsPackages) owner.used.add(packageName);
		const options = parsed.options;
		if (Array.isArray(options.types))
			markTypes(
				owner,
				options.types.filter((entry) => typeof entry === "string"),
			);
		if (typeof options.jsxImportSource === "string") owner.jsxImportSources.add(options.jsxImportSource);
		if (isRecord(options.paths)) {
			for (const [pattern, replacements] of Object.entries(options.paths)) owner.paths.push([pattern, replacements]);
		}
	}
	return { owner, files };
}

function scanOwner(root, owner, files, rootOwner) {
	const markUse = (name, rootVisible) => {
		if (!name) return;
		owner.used.add(name);
		if (rootOwner && owner !== rootOwner && rootVisible) rootOwner.used.add(name);
	};
	for (const file of files.jsonConfigs) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			owner.diagnostics.push({
				severity: "error",
				message: `Cannot read ${portablePath(root, file)}: ${messageOf(error)}`,
			});
			continue;
		}
		const parsed = ts.parseConfigFileTextToJson(file, text);
		if (parsed.error) {
			owner.diagnostics.push({
				severity: "error",
				message: `Cannot parse ${portablePath(root, file)}: ${flattenDiagnostic(parsed.error)}`,
			});
			continue;
		}
		for (const value of stringLeaves(parsed.config)) {
			markUse(packageNameFromSpecifier(value), true);
		}
	}
	for (const file of files.sources) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			owner.diagnostics.push({
				severity: "error",
				message: `Cannot read ${portablePath(root, file)}: ${messageOf(error)}`,
			});
			continue;
		}
		owner.filesScanned += 1;
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
		for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
			const position =
				typeof diagnostic.start === "number"
					? sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
					: { line: 0, character: 0 };
			owner.diagnostics.push({
				severity: "error",
				message: `Syntax error in ${portablePath(root, file)}:${position.line + 1}:${position.character + 1}: ${flattenDiagnostic(diagnostic)}`,
			});
		}
		const evidence = sourceEvidence(sourceFile, text);
		const config = isConfigFile(file);
		const rootVisible = config || isScriptFile(owner, file);
		for (const specifier of evidence.specifiers) {
			for (const name of resolvedSpecifierNames(specifier, owner)) markUse(name, rootVisible);
		}
		markTypes(owner, evidence.typeReferences);
		if (rootOwner && owner !== rootOwner && rootVisible) markTypes(rootOwner, evidence.typeReferences);
		if (config) {
			for (const literal of new Set(evidence.stringLiterals)) {
				markUse(packageNameFromSpecifier(literal), true);
			}
		}
		for (const environment of evidence.environments) {
			markUse(packageNameFromSpecifier(environment), false);
		}
		if (evidence.hasJsx) {
			const sources = owner.jsxImportSources.size > 0 ? owner.jsxImportSources : new Set(["react"]);
			const importSources = new Set(sources);
			if (evidence.jsxImportSource) importSources.add(evidence.jsxImportSource);
			for (const importSource of importSources) {
				markUse(packageNameFromSpecifier(importSource), rootVisible);
			}
		}
		if (basename(file).toLowerCase().includes("vitest")) {
			for (const provider of evidence.coverageProviders) {
				markUse(`@vitest/coverage-${provider}`, rootVisible);
			}
		}
		for (const uncertainty of evidence.uncertainties) {
			const entry = {
				manifest: owner.relativePath,
				file: portablePath(root, file),
				line: uncertainty.line,
				column: uncertainty.column,
				kind: uncertainty.kind,
			};
			owner.uncertainties.push(entry);
			if (rootOwner && owner !== rootOwner && rootVisible) rootOwner.uncertainties.push(entry);
		}
	}
}

function dependencyHasEvidence(owner, name) {
	if (owner.used.has(name)) return true;
	if (name.startsWith("@types/")) {
		const rest = name.slice("@types/".length);
		const base = rest.startsWith("@") ? rest : rest.includes("__") ? `@${rest.replace("__", "/")}` : rest;
		if (owner.used.has(base)) return true;
		if (base === "node" && owner.usesNodeBuiltin) return true;
	}
	return false;
}

function platformReason(name, installed) {
	const manifest = installed?.manifest;
	if (isRecord(manifest)) {
		if (
			(Array.isArray(manifest.os) && manifest.os.length > 0) ||
			(Array.isArray(manifest.cpu) && manifest.cpu.length > 0) ||
			manifest.binary ||
			manifest.gypfile
		) {
			return "platform-specific dependency (retained conservatively)";
		}
	}
	if (PLATFORM_PACKAGE_PATTERNS.some((pattern) => pattern.test(name))) {
		return "known platform-specific dependency (retained conservatively)";
	}
	return undefined;
}

function classifyDependencies(manifests, owners, installed) {
	const candidates = [];
	const retained = [];
	for (const record of manifests) {
		if (!record.manifest) continue;
		const owner = owners.get(record.directory);
		if (!owner) continue;
		for (const section of DEPENDENCY_SECTIONS) {
			const dependencies = record.manifest[section];
			if (!isRecord(dependencies)) continue;
			for (const name of Object.keys(dependencies).sort((left, right) => left.localeCompare(right, "en"))) {
				const base = { manifest: record.relativePath, section, package: name };
				if (section === "optionalDependencies") {
					retained.push({ ...base, reason: "optional dependency (retained conservatively)" });
					continue;
				}
				if (section === "peerDependencies") {
					retained.push({ ...base, reason: "peer dependency (retained conservatively)" });
					continue;
				}
				if (
					(section === "dependencies" || section === "devDependencies") &&
					((isRecord(record.manifest.optionalDependencies) &&
						Object.hasOwn(record.manifest.optionalDependencies, name)) ||
						(isRecord(record.manifest.peerDependencies) && Object.hasOwn(record.manifest.peerDependencies, name)))
				) {
					continue;
				}
				if (dependencyHasEvidence(owner, name)) {
					retained.push({ ...base, reason: "referenced" });
					continue;
				}
				const installedInfo = installed.cache.get(`${resolve(owner.directory)}\0${name}`);
				const platform = platformReason(name, installedInfo);
				if (platform) {
					retained.push({ ...base, reason: platform });
					continue;
				}
				if (owner.uncertainties.length > 0) {
					const uncertainty = owner.uncertainties[0];
					candidates.push({
						...base,
						uncertain: true,
						review: `unresolved computed module reference in ${uncertainty.file}:${uncertainty.line}`,
					});
					continue;
				}
				candidates.push(base);
			}
		}
	}
	candidates.sort((left, right) => {
		const manifestOrder = left.manifest.localeCompare(right.manifest, "en");
		if (manifestOrder !== 0) return manifestOrder;
		const sectionOrder = SECTION_ORDER.get(left.section) - SECTION_ORDER.get(right.section);
		if (sectionOrder !== 0) return sectionOrder;
		return left.package.localeCompare(right.package, "en");
	});
	retained.sort((left, right) => {
		const manifestOrder = left.manifest.localeCompare(right.manifest, "en");
		if (manifestOrder !== 0) return manifestOrder;
		const sectionOrder = SECTION_ORDER.get(left.section) - SECTION_ORDER.get(right.section);
		if (sectionOrder !== 0) return sectionOrder;
		return left.package.localeCompare(right.package, "en");
	});
	return { candidates, retained };
}

export function scanUnusedDependencies(rootInput) {
	const root = resolve(rootInput);
	const diagnostics = [];
	const manifests = discoverManifests(root, diagnostics);
	for (const record of manifests) record.allManifests = manifests;
	const installed = collectInstalledInformation(root, manifests);
	const owners = new Map();
	for (const record of manifests) {
		if (!record.manifest) continue;
		const { owner, files } = createOwner(root, record, diagnostics);
		owners.set(record.directory, owner);
		owner.files = files;
	}
	const rootOwner = owners.get(root);
	for (const owner of owners.values()) markScripts(owner, owner.manifest, rootOwner);
	for (const owner of owners.values()) markPackageConfigStrings(owner, owner.manifest, rootOwner);
	for (const owner of owners.values()) {
		if (!owner.files) continue;
		scanOwner(root, owner, owner.files, rootOwner);
	}
	for (const owner of owners.values()) {
		for (const command of owner.commands) {
			const providers = installed.bins.get(command);
			if (!providers) continue;
			for (const provider of providers) owner.used.add(provider);
		}
	}
	const { candidates, retained } = classifyDependencies(manifests, owners, installed);
	const uncertainties = [
		...new Map(
			[...owners.values()]
				.flatMap((owner) => owner.uncertainties)
				.map((entry) => [`${entry.file}\0${entry.line}\0${entry.column}\0${entry.kind}`, entry]),
		).values(),
	].sort(
		(left, right) =>
			left.file.localeCompare(right.file, "en") ||
			left.line - right.line ||
			left.column - right.column ||
			left.kind.localeCompare(right.kind, "en"),
	);
	return {
		root,
		version: BASELINE_VERSION,
		candidates,
		retained,
		uncertainties,
		diagnostics,
		snapshot: {
			version: BASELINE_VERSION,
			candidates: candidates.map(({ manifest, section, package: packageName }) => ({
				manifest,
				section,
				package: packageName,
			})),
		},
		manifests: manifests.filter((record) => record.manifest).length,
		filesScanned: [...owners.values()].reduce((total, owner) => total + owner.filesScanned, 0),
	};
}

function candidateIdentity(candidate) {
	return `${candidate.manifest}\0${candidate.section}\0${candidate.package}`;
}

function candidateList(value) {
	if (Array.isArray(value)) return value;
	if (isRecord(value) && Array.isArray(value.candidates)) return value.candidates;
	return [];
}

export function compareUnusedDependencies(actual, baseline) {
	const actualCandidates = candidateList(actual);
	const baselineCandidates = candidateList(baseline);
	const actualIdentities = new Set(actualCandidates.map(candidateIdentity));
	const baselineIdentities = new Set(baselineCandidates.map(candidateIdentity));
	const byIdentity = (left, right) => candidateIdentity(left).localeCompare(candidateIdentity(right), "en");
	return {
		added: actualCandidates
			.filter((candidate) => !baselineIdentities.has(candidateIdentity(candidate)))
			.sort(byIdentity),
		removed: baselineCandidates
			.filter((candidate) => !actualIdentities.has(candidateIdentity(candidate)))
			.sort(byIdentity),
	};
}

function validateBaseline(value) {
	if (!isRecord(value)) return "baseline must contain a JSON object";
	if (value.version !== BASELINE_VERSION) return `unsupported baseline version ${JSON.stringify(value.version)}`;
	if (!Array.isArray(value.candidates)) return "baseline candidates must be an array";
	for (const candidate of value.candidates) {
		if (
			!isRecord(candidate) ||
			typeof candidate.manifest !== "string" ||
			typeof candidate.section !== "string" ||
			typeof candidate.package !== "string"
		) {
			return "every baseline candidate needs manifest, section and package strings";
		}
	}
	return undefined;
}

function loadBaseline(root, baselinePath) {
	if (!existsSync(baselinePath)) {
		return {
			error: `Baseline ${portablePath(root, baselinePath)} is missing; run node scripts/check-unused-deps.mjs --update after reviewing candidates.`,
		};
	}
	try {
		const value = JSON.parse(readFileSync(baselinePath, "utf8"));
		const invalid = validateBaseline(value);
		return invalid
			? { error: `Baseline ${portablePath(root, baselinePath)} is invalid: ${invalid}` }
			: { baseline: value };
	} catch (error) {
		return {
			error: `Baseline ${portablePath(root, baselinePath)} is not valid JSON: ${messageOf(error)}`,
		};
	}
}

function candidateLine(candidate) {
	const line = `${candidate.manifest} ${candidate.section} ${candidate.package}`;
	return candidate.uncertain ? `${line} [needs review: ${candidate.review}]` : line;
}

function printCandidate(candidate) {
	console.log(`  ${candidateLine(candidate)}`);
}

function printUncertainties(uncertainties) {
	if (uncertainties.length === 0) return;
	console.log(
		`Coverage limitation: ${uncertainties.length} unresolved computed module reference(s); affected candidates are reported but need manual review.`,
	);
	for (const uncertainty of uncertainties) {
		console.log(`  ${uncertainty.file}:${uncertainty.line} ${uncertainty.kind}`);
	}
}

function runUpdate(root, result) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) {
		console.error("Refusing to update the unused dependency baseline from an incomplete scan:");
		for (const error of errors) console.error(`  ${error.message}`);
		console.error("No files changed.");
		process.exitCode = 1;
		return;
	}
	const baselinePath = join(root, BASELINE_FILE);
	mkdirSync(dirname(baselinePath), { recursive: true });
	writeFileSync(baselinePath, `${JSON.stringify(result.snapshot, null, "\t")}\n`);
	console.log(
		`Updated advisory unused dependency baseline (${result.candidates.length} candidate(s)). Review the diff before committing.`,
	);
}

function runReport(root, result) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) {
		console.log(`Scan incomplete: ${errors.length} error(s) prevented a complete conclusion.`);
		for (const error of errors) console.error(`  ${error.message}`);
	}
	printUncertainties(result.uncertainties);
	if (result.candidates.length > 0) {
		console.log("Unused dependency candidates (advisory; no dependencies were removed):");
		for (const candidate of result.candidates) printCandidate(candidate);
	} else if (errors.length === 0 && result.uncertainties.length === 0) {
		console.log("No unused dependency candidates detected.");
	} else if (errors.length === 0) {
		console.log(
			"No definite unused dependency candidates were identified; the uncertainty above is not a clean result.",
		);
	} else {
		console.log("No definite unused dependency candidates were identified by the incomplete scan.");
	}
	if (errors.length > 0) {
		console.log("Incremental comparison skipped because the scan is incomplete. No files changed.");
		return;
	}
	const baselinePath = join(root, BASELINE_FILE);
	const loaded = loadBaseline(root, baselinePath);
	if (loaded.error) {
		console.error(loaded.error);
	} else {
		const changes = compareUnusedDependencies(result.snapshot, loaded.baseline);
		const actualByIdentity = new Map(result.candidates.map((candidate) => [candidateIdentity(candidate), candidate]));
		console.log("Incremental changes since baseline:");
		if (changes.added.length === 0 && changes.removed.length === 0) {
			console.log("  No new or removed candidates.");
		} else {
			for (const candidate of changes.added) {
				console.log(
					`  New unused candidate: ${candidateLine(actualByIdentity.get(candidateIdentity(candidate)) ?? candidate)}`,
				);
			}
			for (const candidate of changes.removed) {
				console.log(
					`  Baseline candidate no longer unused: ${candidate.manifest} ${candidate.section} ${candidate.package}`,
				);
			}
		}
	}
	console.log(
		`Scanned ${result.manifests} manifest(s) and ${result.filesScanned} source file(s); reported ${result.candidates.length} candidate(s). No files changed.`,
	);
}

function main() {
	const args = process.argv.slice(2);
	const update = args.length === 1 && args[0] === "--update";
	if (args.length > 0 && !update) {
		console.error("Usage: node scripts/check-unused-deps.mjs [--update]");
		process.exitCode = 2;
		return;
	}
	const root = resolve(process.cwd());
	let result;
	try {
		result = scanUnusedDependencies(root);
	} catch (error) {
		console.error(`Unused dependency scan failed: ${messageOf(error)}`);
		console.error("Scan incomplete; no conclusion was reached. No files changed.");
		if (update) process.exitCode = 1;
		return;
	}
	if (update) {
		runUpdate(root, result);
		return;
	}
	runReport(root, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
