import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { emitSources, portablePath, workspaceProgram } from "./lib/source-program.mjs";

// Baseline edges, not component counts: an old component must not grow new cyclic edges.
export function findCycleEdges(graph) {
	let nextIndex = 0;
	const indices = new Map();
	const low = new Map();
	const stack = [];
	const onStack = new Set();
	const components = new Map();
	function visit(node) {
		indices.set(node, nextIndex);
		low.set(node, nextIndex++);
		stack.push(node);
		onStack.add(node);
		for (const target of graph.get(node) ?? []) {
			if (!indices.has(target)) {
				visit(target);
				low.set(node, Math.min(low.get(node), low.get(target)));
			} else if (onStack.has(target)) {
				low.set(node, Math.min(low.get(node), indices.get(target)));
			}
		}
		if (low.get(node) !== indices.get(node)) return;
		let member;
		do {
			member = stack.pop();
			onStack.delete(member);
			components.set(member, node);
		} while (member !== node);
	}
	for (const node of graph.keys()) if (!indices.has(node)) visit(node);
	return [...graph]
		.flatMap(([from, targets]) =>
			[...targets].filter((to) => components.get(from) === components.get(to)).map((to) => [from, to]),
		)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
}

export function newCycleEdges(actual, baseline) {
	const allowed = new Set(baseline.map((edge) => JSON.stringify(edge)));
	return actual.filter((edge) => !allowed.has(JSON.stringify(edge)));
}

export function runtimeCycleSnapshot(root) {
	const workspace = workspaceProgram(root);
	const emitted = emitSources(workspace);
	const graph = new Map([...emitted.keys()].map((file) => [portablePath(workspace.root, file), new Set()]));
	const cache = ts.createModuleResolutionCache(workspace.root, (path) => path, workspace.options);
	for (const [file, text] of emitted) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
		const targets = graph.get(portablePath(workspace.root, file));
		function add(specifier) {
			if (!specifier || !ts.isStringLiteralLike(specifier)) return;
			const resolved = ts.resolveModuleName(specifier.text, file, workspace.options, ts.sys, cache).resolvedModule;
			if (resolved && emitted.has(resolve(resolved.resolvedFileName))) {
				targets.add(portablePath(workspace.root, resolve(resolved.resolvedFileName)));
			}
		}
		function visit(node) {
			if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
			// Literal CommonJS dependencies count; asynchronous import() edges do not.
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
				add(node.arguments[0]);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	return { version: 1, edges: findCycleEdges(graph) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const root = process.cwd();
	const baselinePath = join(root, "scripts/baselines/runtime-cycles.json");
	const snapshot = runtimeCycleSnapshot(root);
	if (process.argv.slice(2).join(" ") === "--update") {
		writeFileSync(baselinePath, `${JSON.stringify(snapshot, null, "\t")}\n`);
		console.log(
			`Updated runtime-cycle baseline (${snapshot.edges.length} edges); review the diff before committing.`,
		);
	} else {
		if (process.argv.length > 2) throw new Error("Usage: node scripts/check-runtime-cycles.mjs [--update]");
		const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
		if (baseline.version !== snapshot.version) throw new Error("Unsupported runtime-cycle baseline version");
		const added = newCycleEdges(snapshot.edges, baseline.edges);
		if (added.length) {
			console.error(`New runtime cycle edges:\n${added.map(([from, to]) => `  ${from} -> ${to}`).join("\n")}`);
			process.exitCode = 1;
		} else {
			console.log(`Runtime cycle check passed (${snapshot.edges.length} existing cyclic edges; no additions).`);
		}
	}
}
