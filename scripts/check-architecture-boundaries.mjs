import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = process.cwd();
if (!existsSync(join(root, "packages"))) {
	console.error("check:boundaries must run from the repository root (packages/ not found)");
	process.exit(1);
}
const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules", "out"]);
const files = [];

function collectSourceFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectSourceFiles(join(directory, entry.name));
			continue;
		}
		if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
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

function violates(file, specifier) {
	const path = relative(root, file).replaceAll("\\", "/");
	// Relative imports may not reach into a different package; that bypasses
	// package export boundaries entirely (e.g. the curated /host surface).
	if (specifier.startsWith(".")) {
		const pkg = packageRoot(path);
		if (!pkg) return false;
		const resolved = relative(join(root, pkg), resolve(dirname(file), specifier)).replaceAll("\\", "/");
		return resolved.startsWith("..");
	}
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
			return specifier !== "@metis/coding-agent/host" && !specifier.startsWith("@metis/coding-agent/host/");
		}
		return ["agent-core", "ai", "desktop", "tui"].some((name) => isMetisSpecifier(specifier, name));
	}
	if (path.startsWith("packages/desktop/src/") || path.startsWith("packages/desktop/test/")) {
		return ["agent-core", "ai", "app-server", "coding-agent", "tui"].some((name) =>
			isMetisSpecifier(specifier, name),
		);
	}
	return false;
}

for (const directory of ["packages/ai", "packages/agent", "packages/tui", "packages/app-protocol", "packages/coding-agent/src", "packages/app-server", "packages/desktop/src", "packages/desktop/test"]) {
	collectSourceFiles(join(root, directory));
}

const failures = [];

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

	const sourceLines = sourceText.split("\n");

	function checkSpecifier(node) {
		if (!violates(file, node.text)) return;
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		if (sourceLines[line]?.includes("boundary-allow")) return;
		failures.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			checkSpecifier(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			checkSpecifier(node.arguments[0]);
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
