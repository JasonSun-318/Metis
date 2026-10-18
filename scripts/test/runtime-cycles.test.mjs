import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findCycleEdges, newCycleEdges, runtimeCycleSnapshot } from "../check-runtime-cycles.mjs";

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-cycles-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sources = {
		"package.json": JSON.stringify({ type: "module" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				types: [],
				paths: { "@fixture/*": ["./packages/example/src/*.ts"] },
			},
		}),
		"packages/example/package.json": JSON.stringify({ name: "@fixture/example", type: "module" }),
		...files,
	};
	for (const [file, source] of Object.entries(sources)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
	}
	return { root, ...runtimeCycleSnapshot(root) };
}

const path = (name) => `packages/example/src/${name}.ts`;

test("erased explicit and implicit type imports do not create runtime cycles", (t) => {
	const snapshot = fixture(t, {
		[path("a")]: 'import { B } from "./b.ts"; export interface A { b: B }',
		[path("b")]: 'import type { A } from "./a.ts"; export interface B { a: A }',
	});
	assert.deepEqual(snapshot.edges, []);
});

test("runtime barrel exports and path aliases participate in cycles", (t) => {
	const snapshot = fixture(t, {
		[path("a")]: 'export { b } from "./barrel.ts"; export const a = 1;',
		[path("barrel")]: 'export * from "@fixture/b";',
		[path("b")]: 'import { a } from "./a.ts"; export const b = () => a;',
	});
	assert.deepEqual(snapshot.edges, [
		[path("a"), path("barrel")],
		[path("b"), path("a")],
		[path("barrel"), path("b")],
	]);
});

test("side-effect imports form cycles, lazy dynamic imports do not", (t) => {
	const snapshot = fixture(t, {
		[path("a")]: 'import "./b.ts"; export const load = () => import("./lazy.ts");',
		[path("b")]: 'import "./a.ts";',
		[path("lazy")]: 'import "./a.ts";',
	});
	assert.deepEqual(snapshot.edges, [
		[path("a"), path("b")],
		[path("b"), path("a")],
	]);
});

test("literal CommonJS require dependencies are checked", (t) => {
	const snapshot = fixture(t, {
		"packages/example/src/a.cts": 'const b = require("./b.cjs"); export const a = () => b.b;',
		"packages/example/src/b.cts": 'const a = require("./a.cjs"); export const b = () => a.a;',
	});
	assert.deepEqual(snapshot.edges, [
		["packages/example/src/a.cts", "packages/example/src/b.cts"],
		["packages/example/src/b.cts", "packages/example/src/a.cts"],
	]);
});

test("the baseline rejects new edges even inside an existing component and allows removals", () => {
	const baseline = [
		["a", "b"],
		["b", "c"],
		["c", "a"],
	];
	assert.deepEqual(newCycleEdges([...baseline, ["a", "c"]], baseline), [["a", "c"]]);
	assert.deepEqual(newCycleEdges([], baseline), []);
	assert.deepEqual(newCycleEdges([["x", "x"]], baseline), [["x", "x"]]);
});

test("only edges within strongly connected components are baselined", () => {
	const graph = new Map([
		["a", new Set(["b", "out"])],
		["b", new Set(["a"])],
		["in", new Set(["a"])],
		["self", new Set(["self"])],
		["out", new Set()],
	]);
	assert.deepEqual(findCycleEdges(graph), [
		["a", "b"],
		["b", "a"],
		["self", "self"],
	]);
});

test("the CLI rejects new cycles without updating its baseline", (t) => {
	const { root, edges } = fixture(t, {
		[path("a")]: "export const a = 1;",
		[path("b")]: 'import { a } from "./a.ts"; export const b = () => a;',
	});
	const baselineFile = join(root, "scripts/baselines/runtime-cycles.json");
	mkdirSync(dirname(baselineFile), { recursive: true });
	const baseline = JSON.stringify({ version: 1, edges });
	writeFileSync(baselineFile, baseline);
	writeFileSync(join(root, path("a")), 'export { b } from "./b.ts"; export const a = 1;');
	const script = fileURLToPath(new URL("../check-runtime-cycles.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 1, result.stdout || result.stderr);
	assert.match(result.stderr, /New runtime cycle edges/);
	assert.equal(readFileSync(baselineFile, "utf8"), baseline);
});
