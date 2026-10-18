import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
if (!existsSync(join(root, "packages"))) {
	console.error("check:boundaries must run from the repository root (packages/ not found)");
	process.exit(1);
}
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "out"]);
const files = [];
const workspaceExports = new Map();

for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const manifestPath = join(root, "packages", entry.name, "package.json");
	if (!existsSync(manifestPath)) continue;
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const exports = manifest.exports;
	workspaceExports.set(
		manifest.name,
		exports && typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."))
			? exports
			: exports
				? { ".": exports }
				: { ".": true, "./package.json": true },
	);
}

function isPublicPackageSpecifier(specifier) {
	const name = specifier.split("/").slice(0, 2).join("/");
	const exports = workspaceExports.get(name);
	if (!exports) return false;
	const subpath = `.${specifier.slice(name.length)}`;
	if (Object.hasOwn(exports, subpath)) return exports[subpath] !== null;
	return Object.entries(exports).some(([path, target]) => {
		if (target === null || !path.includes("*")) return false;
		const [prefix, suffix] = path.split("*");
		return subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= path.length - 1;
	});
}

function collectSourceFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectSourceFiles(join(directory, entry.name));
			continue;
		}
		if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) {
			files.push(join(directory, entry.name));
		}
	}
}

function isMetisSpecifier(specifier, packageName) {
	return specifier === `@metis/${packageName}` || specifier.startsWith(`@metis/${packageName}/`);
}

function packageRoot(path) {
	const match = /^packages\/[^/]+\//.exec(path);
	return match?.[0];
}

function isWithinPath(path, directory) {
	return path === directory || path.startsWith(`${directory}/`);
}

function violates(file, specifier) {
	const path = relative(root, file).replaceAll("\\", "/");
	const renderer = path.startsWith("packages/desktop/src/renderer/");
	const shared = path.startsWith("packages/desktop/src/shared/");
	const protocol = path.startsWith("packages/app-protocol/src/");
	if (
		(renderer || shared || protocol) &&
		(isBuiltin(specifier) ||
			specifier.startsWith("node:") ||
			specifier === "electron" ||
			specifier.startsWith("electron/"))
	) {
		return true;
	}
	// Relative imports may not reach into a different package; that bypasses
	// package export boundaries entirely (e.g. the curated /host surface).
	if (specifier.startsWith(".") || isAbsolute(specifier)) {
		const pkg = packageRoot(path);
		if (!pkg) return false;
		const resolved = relative(join(root, pkg), resolve(dirname(file), specifier)).replaceAll("\\", "/");
		if (resolved === ".." || resolved.startsWith("../")) return true;
		const target = resolved.replace(/\.(?:[cm]?ts|tsx)$/, "");
		if (renderer && (isWithinPath(target, "src/main") || target === "src/preload")) return true;
		if (shared && !isWithinPath(target, "src/shared")) return true;
		if (path.startsWith("packages/desktop/src/main/") && isWithinPath(target, "src/renderer")) return true;
		return false;
	}
	if (specifier.startsWith("@metis/") && !isPublicPackageSpecifier(specifier)) return true;
	const hasForbiddenMetisImport = (allowed) =>
		specifier.startsWith("@metis/") && !allowed.some((name) => isMetisSpecifier(specifier, name));

	if (path.startsWith("packages/ai/")) {
		return hasForbiddenMetisImport(["ai"]);
	}
	if (path.startsWith("packages/agent/")) {
		return hasForbiddenMetisImport(["agent-core", "ai"]);
	}
	if (path.startsWith("packages/tui/")) {
		return hasForbiddenMetisImport(["tui"]);
	}
	if (path.startsWith("packages/app-protocol/")) {
		return hasForbiddenMetisImport(["app-protocol"]);
	}
	if (path.startsWith("packages/coding-agent/src/")) {
		return ["app-protocol", "app-server", "desktop"].some((name) => isMetisSpecifier(specifier, name));
	}
	if (path.startsWith("packages/app-server/")) {
		if (isMetisSpecifier(specifier, "coding-agent")) {
			return specifier !== "@metis/coding-agent/host";
		}
		return ["agent-core", "ai", "desktop", "tui"].some((name) => isMetisSpecifier(specifier, name));
	}
	if (
		path.startsWith("packages/desktop/src/") ||
		path.startsWith("packages/desktop/test/") ||
		path.startsWith("packages/desktop/e2e/")
	) {
		return ["agent-core", "ai", "app-server", "coding-agent", "tui"].some((name) =>
			isMetisSpecifier(specifier, name),
		);
	}
	return false;
}

for (const directory of [
	"packages/ai",
	"packages/agent",
	"packages/tui",
	"packages/app-protocol",
	"packages/coding-agent/src",
	"packages/app-server",
	"packages/desktop/src",
	"packages/desktop/test",
	"packages/desktop/e2e",
]) {
	collectSourceFiles(join(root, directory));
}

const failures = [];

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

	function checkSpecifier(node) {
		if (!violates(file, node.text)) return;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		let statement = node;
		while (!ts.isStatement(statement) && statement.parent) statement = statement.parent;
		const comments = ts.getTrailingCommentRanges(sourceText, statement.end) ?? [];
		if (comments.some((comment) => /^\/\/\s*boundary-allow:\s*\S/.test(sourceText.slice(comment.pos, comment.end))))
			return;
		failures.push(`${relative(root, file).replaceAll("\\", "/")}:${line + 1}:${character + 1}: ${node.text}`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			checkSpecifier(node.arguments[0]);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression &&
			ts.isStringLiteralLike(node.moduleReference.expression)
		) {
			checkSpecifier(node.moduleReference.expression);
		} else if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
				checkSpecifier(argument.literal);
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

if (failures.length > 0) {
	console.error("Architecture boundary violations:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
