import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { emitSources, emittedProgram, portablePath, workspaceProgram } from "./lib/source-program.mjs";

function targetPaths(target) {
	if (typeof target === "string") return [target];
	if (target === null || target === undefined) return [];
	return Object.values(target).flatMap(targetPaths);
}

function exportedSymbols(program, file) {
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(file);
	if (!source) throw new Error(`Missing public source: ${file}`);
	const module = checker.getSymbolAtLocation(source);
	return (module ? checker.getExportsOfModule(module) : []).map((symbol) => {
		const declaration = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
		return { name: symbol.getName(), flags: declaration.flags, declaration };
	});
}

function checkHostMirror(program, directory, entries) {
	for (const root of Object.keys(entries.get(".") ?? {})) {
		const exports = new Map(
			exportedSymbols(program, join(directory, root)).map((symbol) => [symbol.name, symbol.declaration]),
		);
		for (const host of Object.keys(entries.get("./host") ?? {})) {
			for (const symbol of exportedSymbols(program, join(directory, host))) {
				if (exports.has(symbol.name) && exports.get(symbol.name) !== symbol.declaration) {
					throw new Error(`Public host mirror differs from the root export: ${symbol.name}`);
				}
			}
		}
	}
}

function surface(program, runtime, file) {
	if (program.getSourceFile(file).impliedNodeFormat === ts.ModuleKind.CommonJS) {
		throw new Error(`CommonJS public entrypoints are not supported by this surface gate: ${file}`);
	}
	const symbols = exportedSymbols(program, file);
	const names = new Set(symbols.map((symbol) => symbol.name));
	const values = exportedSymbols(runtime, file)
		// Exclude compiler-generated CommonJS markers such as __esModule.
		.filter((symbol) => names.has(symbol.name) && symbol.flags & ts.SymbolFlags.Value)
		.map((symbol) => symbol.name)
		.sort();
	const types = symbols
		.filter(
			(symbol) => symbol.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace) || !values.includes(symbol.name),
		)
		.map((symbol) => symbol.name)
		.sort();
	return { values, types };
}

export function publicApiSnapshot(root) {
	const workspace = workspaceProgram(root);
	const emitted = emitSources(workspace);
	const runtime = emittedProgram(workspace, emitted);
	const packages = {};
	for (const pkg of workspace.packages.filter((pkg) => !pkg.manifest.private)) {
		const { manifest, directory } = pkg;
		const exports = manifest.exports;
		const subpaths =
			exports && typeof exports === "object" && Object.keys(exports).some((key) => key.startsWith("."))
				? exports
				: { ".": exports ?? [manifest.types, manifest.main] };
		const entries = new Map();
		for (const [subpath, target] of Object.entries(subpaths)) {
			for (const output of new Set(targetPaths(target))) {
				if (!/\.(?:[cm]?js|jsx|(?:d\.)?[cm]?ts|tsx)$/.test(output)) continue;
				const stem = output
					.replace(/^\.\//, "")
					.replace(/^dist\//, "src/")
					.replace(/\.(?:d\.)?(?:[cm]?[jt]s|[jt]sx)$/, "");
				const [prefix, suffix] = stem.split("*");
				let matches = 0;
				for (const file of pkg.files) {
					// Ambient .d.ts inputs do not produce dist entrypoints.
					if (!emitted.has(file)) continue;
					const source = portablePath(directory, file);
					const sourceStem = source.replace(/\.(?:[cm]?ts|tsx)$/, "");
					const match =
						suffix === undefined
							? sourceStem === stem
							: sourceStem.length >= prefix.length + suffix.length &&
								sourceStem.startsWith(prefix) &&
								sourceStem.endsWith(suffix);
					if (!match) continue;
					matches++;
					const name =
						suffix === undefined
							? subpath
							: subpath.replaceAll("*", sourceStem.slice(prefix.length, sourceStem.length - suffix.length));
					if (!entries.has(name)) entries.set(name, {});
					entries.get(name)[source] = surface(workspace.program, runtime, file);
				}
				if (!matches) throw new Error(`No source file for ${manifest.name} ${subpath}: ${output}`);
			}
		}
		if (manifest.name === "@metis/coding-agent") checkHostMirror(workspace.program, directory, entries);
		packages[manifest.name] = {
			main: manifest.main ?? null,
			types: manifest.types ?? null,
			exports: exports ?? null,
			entrypoints: Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b, "en"))),
		};
	}
	return {
		version: 1,
		packages: Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b, "en"))),
	};
}

// Exact surface changes require a deliberate baseline review, including additions.
// This protects names/kinds/subpaths; existing type tests still cover signature compatibility.
export function publicApiChanges(actual, baseline, path = "API") {
	if (JSON.stringify(actual) === JSON.stringify(baseline)) return [];
	// Conditional export and fallback order affects Node resolution.
	if (path.endsWith("/exports")) {
		const orderedSubpaths = (value) =>
			value &&
			!Array.isArray(value) &&
			typeof value === "object" &&
			Object.keys(value).some((key) => key.startsWith("."))
				? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")))
				: value;
		if (JSON.stringify(orderedSubpaths(actual)) === JSON.stringify(orderedSubpaths(baseline))) return [];
		return [`${path}: ${JSON.stringify(baseline)} -> ${JSON.stringify(actual)}`];
	}
	if (Array.isArray(actual) && Array.isArray(baseline)) {
		return [
			...baseline.filter((name) => !actual.includes(name)).map((name) => `${path}: removed ${name}`),
			...actual.filter((name) => !baseline.includes(name)).map((name) => `${path}: added ${name}`),
		];
	}
	if (actual && baseline && typeof actual === "object" && typeof baseline === "object") {
		return [...new Set([...Object.keys(actual), ...Object.keys(baseline)])]
			.sort()
			.flatMap((key) => publicApiChanges(actual[key], baseline[key], `${path}/${key}`));
	}
	return [`${path}: ${JSON.stringify(baseline)} -> ${JSON.stringify(actual)}`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const baselinePath = join(process.cwd(), "scripts/baselines/public-api.json");
	const snapshot = publicApiSnapshot(process.cwd());
	if (process.argv.slice(2).join(" ") === "--update") {
		writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, "\t")}\n`);
		console.log("Updated public API surface baseline; review the diff before committing.");
	} else {
		if (process.argv.length > 2) throw new Error("Usage: node scripts/check-public-api.mjs [--update]");
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
		const changes = publicApiChanges(snapshot, baseline);
		if (changes.length) {
			console.error(`Public API surface changed:\n${changes.map((change) => `  ${change}`).join("\n")}`);
			process.exitCode = 1;
		} else {
			console.log(`Public API surface check passed (${Object.keys(snapshot.packages).length} packages).`);
		}
	}
}
