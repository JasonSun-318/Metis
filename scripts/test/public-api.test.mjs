import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { publicApiChanges, publicApiSnapshot } from "../check-public-api.mjs";

function fixture(t, files, exports = { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }) {
	const root = mkdtempSync(join(tmpdir(), "metis-api-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sources = {
		"package.json": JSON.stringify({ type: "module" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", types: [] },
		}),
		"packages/example/package.json": JSON.stringify({ name: "@fixture/example", type: "module", exports }),
		...files,
	};
	const write = (file, source) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
	};
	for (const [file, source] of Object.entries(sources)) write(file, source);
	return { root, write, snapshot: () => publicApiSnapshot(root) };
}

test("public surfaces distinguish values, types, type-only aliases and barrel reexports", (t) => {
	const { snapshot } = fixture(t, {
		"packages/example/src/index.ts":
			'export * from "./values.ts"; export type { Hidden, fn as FnType } from "./hidden.ts";',
		"packages/example/src/values.ts":
			"export class Both {} export interface Shape {} export const value = 1; export function fn() {}",
		"packages/example/src/hidden.ts": "export class Hidden {} export function fn() {}",
	});
	assert.deepEqual(snapshot().packages["@fixture/example"].entrypoints["."]["src/index.ts"], {
		values: ["Both", "fn", "value"],
		types: ["Both", "FnType", "Hidden", "Shape"],
	});
});

test("surface changes catch removed types, renamed values, value-to-type changes and additions", (t) => {
	const { snapshot, write } = fixture(t, {
		"packages/example/src/index.ts": "export interface Shape {} export class Both {} export const value = 1;",
	});
	const before = snapshot();
	write("packages/example/src/index.ts", "export interface Both {} export const renamed = 1;");
	const changes = publicApiChanges(snapshot(), before);
	assert.ok(
		changes.some((change) => change.includes("Shape")),
		changes.join("\n"),
	);
	assert.ok(
		changes.some((change) => change.includes("values") && change.includes("Both")),
		changes.join("\n"),
	);
	assert.ok(
		changes.some((change) => change.includes("value")),
		changes.join("\n"),
	);
	assert.ok(
		changes.some((change) => change.includes("renamed")),
		changes.join("\n"),
	);
});

test("wildcard subpaths, conditional targets and the host mirror have their own surfaces", (t) => {
	const { snapshot, write } = fixture(
		t,
		{
			"packages/example/src/index.ts": 'export { value } from "./internal.ts";',
			"packages/example/src/host.ts": 'export { value } from "./internal.ts";',
			"packages/example/src/internal.ts": "export const value = 1;",
			"packages/example/src/providers/first.ts": "export const provider = 1;",
			"packages/example/src/providers/data-json.d.ts":
				'declare module "*.json" { const data: unknown; export default data; }',
		},
		{
			".": "./dist/index.js",
			"./host": { types: "./dist/host.d.ts", import: "./dist/host.js" },
			"./providers/*": { types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" },
			"./package.json": "./package.json",
		},
	);
	const before = snapshot();
	assert.deepEqual(Object.keys(before.packages["@fixture/example"].entrypoints), [".", "./host", "./providers/first"]);
	write("packages/example/src/host.ts", "export {};\n");
	write("packages/example/src/providers/second.ts", "export const second = 2;");
	const changes = publicApiChanges(snapshot(), before);
	assert.ok(
		changes.some((change) => change.includes("./host") && change.includes("value")),
		changes.join("\n"),
	);
	assert.ok(
		changes.some((change) => change.includes("./providers/second")),
		changes.join("\n"),
	);
});

test("package export-map and main/types changes cannot silently change public subpaths", (t) => {
	const { snapshot, write } = fixture(t, { "packages/example/src/index.ts": "export const value = 1;" });
	const before = snapshot();
	write(
		"packages/example/package.json",
		JSON.stringify({ name: "@fixture/example", type: "module", main: "./dist/index.js", types: "./dist/index.d.ts" }),
	);
	const after = snapshot();
	assert.deepEqual(after.packages["@fixture/example"].entrypoints["."]["src/index.ts"].values, ["value"]);
	assert.ok(publicApiChanges(after, before).some((change) => change.includes("exports")));
});

test("unresolvable public targets fail instead of silently disappearing from the baseline", (t) => {
	const { snapshot } = fixture(t, { "packages/example/src/other.ts": "export {};" });
	assert.throws(snapshot, /No source file.*dist\/index/);
});

test("coding-agent host exports keep the same declarations as their root counterparts", (t) => {
	const exports = { ".": "./dist/index.js", "./host": "./dist/host.js" };
	const { snapshot, write } = fixture(
		t,
		{
			"packages/example/src/index.ts": 'export { value } from "./internal.ts";',
			"packages/example/src/host.ts": 'export { value } from "./internal.ts"; export const hostOnly = 2;',
			"packages/example/src/internal.ts": "export const value = 1;",
		},
		exports,
	);
	write("packages/example/package.json", JSON.stringify({ name: "@metis/coding-agent", type: "module", exports }));
	assert.doesNotThrow(snapshot);
	write("packages/example/src/host.ts", "export const value = 1; export const hostOnly = 2;");
	assert.throws(snapshot, /Public host mirror differs.*value/);
});

test("type-only star barrels cannot leak runtime exports", (t) => {
	const { snapshot } = fixture(t, {
		"packages/example/src/index.ts": 'export type * from "./values.ts";',
		"packages/example/src/values.ts": "export class OnlyType {} export const callable = () => 1;",
	});
	assert.deepEqual(snapshot().packages["@fixture/example"].entrypoints["."]["src/index.ts"], {
		values: [],
		types: ["OnlyType", "callable"],
	});
});

for (const source of [
	"export class Both {} export interface Shape {} export const value = 1;",
	"const before = 1; module.exports = { before };",
	"class Foo {} export = Foo;",
]) {
	test(`unsupported CommonJS public entries fail explicitly: ${source}`, (t) => {
		const { snapshot } = fixture(
			t,
			{ "packages/example/src/index.cts": source },
			{ ".": { types: "./dist/index.d.cts", require: "./dist/index.cjs" } },
		);
		assert.throws(snapshot, /CommonJS public entrypoints are not supported/);
	});
}

test("conditional export order and fallback order are part of the public contract", () => {
	const before = { exports: { ".": { node: "./node.js", default: "./default.js" } } };
	const after = { exports: { ".": { default: "./default.js", node: "./node.js" } } };
	assert.equal(publicApiChanges(after, before).length, 1);
	assert.equal(publicApiChanges({ exports: ["b", "a"] }, { exports: ["a", "b"] }).length, 1);
});

test("reordering ordinary export subpaths does not change resolution", () => {
	const before = { exports: { "./a": { node: "./a.js", default: "./b.js" }, "./b": "./b.js" } };
	const after = { exports: { "./b": "./b.js", "./a": { node: "./a.js", default: "./b.js" } } };
	assert.deepEqual(publicApiChanges(after, before), []);
});

test("the CLI only refreshes a changed surface with explicit --update", (t) => {
	const { root, write, snapshot } = fixture(t, {
		"packages/example/src/index.ts": "export interface Shape {} export const value = 1;",
	});
	const baseline = JSON.stringify(snapshot());
	const baselineFile = "scripts/baselines/public-api.json";
	write(baselineFile, baseline);
	write("packages/example/src/index.ts", "export const value = 1;");
	const script = fileURLToPath(new URL("../check-public-api.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
	assert.equal(result.status, 1, result.stdout || result.stderr);
	assert.match(result.stderr, /removed Shape/);
	assert.equal(readFileSync(join(root, baselineFile), "utf8"), baseline);
	const update = spawnSync(process.execPath, [script, "--update"], { cwd: root, encoding: "utf8" });
	assert.equal(update.status, 0, update.stderr);
	assert.deepEqual(JSON.parse(readFileSync(join(root, baselineFile), "utf8")), snapshot());
});
