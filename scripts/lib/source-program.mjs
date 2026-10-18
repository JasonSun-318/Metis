import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

export const portablePath = (root, file) => relative(root, file).replaceAll("\\", "/");

function sourceFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
		return entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

// Compile in memory: no build artifacts, execution of entrypoints, or dependency additions.
export function workspaceProgram(root) {
	root = resolve(root);
	const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
		.map((entry) => {
			const directory = join(root, "packages", entry.name);
			return {
				directory,
				manifest: JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
				files: sourceFiles(join(directory, "src")).sort(),
			};
		});
	const configPath = join(root, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
	if (parsed.errors.length) {
		throw new Error(
			parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"),
		);
	}
	const options = {
		...parsed.options,
		jsx: parsed.options.jsx ?? ts.JsxEmit.ReactJSX,
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
	};
	const files = packages.flatMap((pkg) => pkg.files);
	const program = ts.createProgram(files, options);
	const diagnostics = program.getSyntacticDiagnostics();
	if (diagnostics.length) {
		throw new Error(diagnostics.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
	}
	return { root, packages, files, options, program };
}

export function emitSources(workspace) {
	const emitted = new Map();
	const files = new Set(workspace.files);
	workspace.program.emit(undefined, (fileName, text, _bom, _error, sources) => {
		if (/\.(?:[cm]?js|jsx)$/.test(fileName) && sources?.length === 1 && files.has(resolve(sources[0].fileName))) {
			emitted.set(resolve(sources[0].fileName), text);
		}
	});
	for (const file of workspace.files) {
		if (!workspace.program.getSourceFile(file)?.isDeclarationFile && !emitted.has(file)) {
			throw new Error(`No JavaScript emitted for ${portablePath(workspace.root, file)}`);
		}
	}
	return emitted;
}

export function emittedProgram(workspace, emitted) {
	const host = ts.createCompilerHost(workspace.options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
		const text = emitted.get(resolve(fileName));
		return text === undefined
			? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
			: ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.JS);
	};
	return ts.createProgram(workspace.files, { ...workspace.options, noEmit: true }, host);
}
