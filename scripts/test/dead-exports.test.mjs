import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deadExportChanges, scanDeadExports, validateDeadExportBaseline } from "../check-dead-exports.mjs";

const script = fileURLToPath(new URL("../check-dead-exports.mjs", import.meta.url));
const baselineFile = "scripts/baselines/dead-exports.json";

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-dead-exports-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const defaults = {
		"package.json": JSON.stringify({ name: "fixture", private: true, type: "module" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				module: "NodeNext",
				moduleResolution: "NodeNext",
				target: "ES2022",
				strict: true,
				allowImportingTsExtensions: true,
				noEmit: true,
				types: [],
				skipLibCheck: true,
			},
		}),
		"packages/example/package.json": JSON.stringify({
			name: "@fixture/example",
			private: true,
			type: "module",
		}),
	};
	const write = (file, contents) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(
			join(root, file),
			typeof contents === "string" ? contents : `${JSON.stringify(contents, null, "\t")}\n`,
		);
	};
	for (const [file, contents] of Object.entries({ ...defaults, ...files })) write(file, contents);
	return {
		root,
		write,
		read: (file) => readFileSync(join(root, file), "utf8"),
		scan: () => scanDeadExports(root),
		run: (args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" }),
	};
}

function candidateKeys(result) {
	return result.candidates.map((candidate) => `${candidate.file}:${candidate.export}:${candidate.category}`).sort();
}

function candidatesByExport(result) {
	return new Map(result.candidates.map((candidate) => [candidate.export, candidate]));
}

function publicPackage(exports) {
	return {
		name: "@fixture/example",
		type: "module",
		main: "./dist/index.js",
		types: "./dist/index.d.ts",
		exports,
	};
}

test("public reexports stay protected after downstream module augmentation", (t) => {
	const { scan } = fixture(t, {
		"packages/example/package.json": publicPackage(undefined),
		"tsconfig.json": {
			compilerOptions: {
				module: "NodeNext",
				moduleResolution: "NodeNext",
				paths: {
					"@fixture/example": ["./packages/example/src/index.ts"],
				},
				types: [],
			},
		},
		"packages/example/src/index.ts": 'export type { Registry } from "./registry.ts";',
		"packages/example/src/registry.ts": "export interface Registry { base: true }",
		"packages/example/src/consumer.ts":
			'import "@fixture/example"; declare module "@fixture/example" { interface Registry { extra: true } }',
	});
	assert.deepEqual(candidateKeys(scan()), []);
});

test("root config references and escaped namespaces are conservatively retained", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/root.ts": "export const configured = 1;",
		"vitest.config.ts": 'import { configured } from "./packages/example/src/root.ts"; void configured;',
		"packages/example/src/escaped.ts": "export const passed = 1;",
		"packages/example/src/destructured.ts": "export const extracted = 1;",
		"packages/example/src/use.ts":
			'import * as ns from "./escaped.ts"; import * as destructured from "./destructured.ts"; consume(ns); const { extracted } = destructured; void extracted;',
	});
	assert.deepEqual(candidateKeys(scan()), []);
});

test("namespace barrels and shorthand values keep their distinct reference categories", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/a.ts": "export const value = 1; const object = { value }; void object;",
		"packages/example/src/b.ts": "export const forwarded = 1;",
		"packages/example/src/barrel.ts": 'import * as ns from "./b.ts"; export { ns };',
	});
	assert.deepEqual(candidateKeys(scan()), [
		"packages/example/src/a.ts:value:same-file-only",
		"packages/example/src/b.ts:forwarded:barrel-only",
	]);
});

test("unresolved literal local imports are explicit coverage uncertainty", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/a.ts": "export const candidate = 1;",
		"packages/example/src/use.ts": 'import { value } from "./missing.ts"; void value;',
	});
	const result = scan();
	assert.equal(result.uncertainties.global.length, 1);
	assert.match(result.uncertainties.global[0].kind, /unresolved local module/);
	assert.equal(result.candidates[0].uncertain, true);
});

test("source discovery errors are advisory and prevent baseline updates", (t) => {
	const { run, read } = fixture(t, {
		"packages/example/src/a.ts": "export const candidate = 1;",
		scripts: "unreadable source directory",
	});
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stderr, /scan failed/);
	assert.equal(run(["--update"]).status, 1);
	assert.equal(read("scripts"), "unreadable source directory");
});

test("unresolved public signature types prevent incomplete baseline updates", (t) => {
	const { run, read } = fixture(t, {
		"packages/example/package.json": publicPackage(undefined),
		"packages/example/src/index.ts": 'export function api(): import("./missing.ts").Missing { throw 0; }',
		[baselineFile]: { version: 1, candidates: [] },
	});
	const baseline = read(baselineFile);
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete/);
	assert.equal(run(["--update"]).status, 1);
	assert.equal(read(baselineFile), baseline);
});

test("generated sources, declarations and fixtures are excluded as candidates", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/actual.ts": "export const candidate = 1;",
		"packages/example/src/api.generated.ts": "export const generated = 1;",
		"packages/example/src/marked.ts": "// @generated\nexport const marked = 1;",
		"packages/example/src/ambient.d.ts": "export declare const ambient: number;",
		"packages/example/src/__fixtures__/fixture.ts": "export const fixture = 1;",
	});
	assert.deepEqual(candidateKeys(scan()), ["packages/example/src/actual.ts:candidate:zero-reference"]);
});

test("public entrypoints protect wildcard subpaths, namespace exports and reexport aliases", (t) => {
	const { scan } = fixture(t, {
		"packages/example/package.json": JSON.stringify(
			publicPackage({
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./providers/*": { types: "./dist/providers/*.d.ts", import: "./dist/providers/*.js" },
			}),
		),
		"packages/example/src/index.ts": [
			'export * from "./internal.ts";',
			'export * as ns from "./namespace.ts";',
			'export { alias as renamed } from "./alias.ts";',
		].join("\n"),
		"packages/example/src/internal.ts": "export const publicViaStar = 1;\nexport const alsoPublicViaStar = 2;\n",
		"packages/example/src/namespace.ts": "export const namespaceValue = 1;\nexport const alsoNamespacePublic = 2;\n",
		"packages/example/src/alias.ts": "export const alias = 1;\nexport const aliasDead = 2;\n",
		"packages/example/src/providers/first.ts":
			"export const providerPublic = 1;\nexport const alsoProviderPublic = 2;\n",
		"packages/example/src/other.ts": "export const zero = 1;\n",
	});
	const result = scan();
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(candidateKeys(result), [
		"packages/example/src/alias.ts:aliasDead:zero-reference",
		"packages/example/src/other.ts:zero:zero-reference",
	]);
	assert.ok(result.publicEntrypoints >= 2);
});

test("alias chains and type-only references are actual uses, while alias-only exports stay candidates", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/a.ts": [
			"export const chained = 1;",
			"export const unusedInA = 2;",
			"export interface UsedType { x: number }",
			"export interface DeadType { y: number }",
		].join("\n"),
		"packages/example/src/b.ts": 'export { chained as mid } from "./a.ts";\n',
		"packages/example/src/c.ts": 'export { mid as final } from "./b.ts";\n',
		"packages/example/src/use.ts": 'import { final } from "./c.ts";\nvoid final;\n',
		"packages/example/src/type-use.ts":
			'import type { UsedType } from "./a.ts";\nconst value: UsedType = { x: 1 };\nvoid value;\n',
		"packages/example/src/alias-only.ts": "const local = 1;\nexport { local as aliasOnly };\n",
		"packages/example/src/type-barrel.ts": 'export type { DeadType } from "./a.ts";\n',
	});
	assert.deepEqual(candidateKeys(scan()), [
		"packages/example/src/a.ts:DeadType:barrel-only",
		"packages/example/src/a.ts:unusedInA:zero-reference",
		"packages/example/src/alias-only.ts:aliasOnly:zero-reference",
	]);
});

test("types used in public signatures, including inferred declaration types, are protected", (t) => {
	const { scan } = fixture(t, {
		"packages/example/package.json": JSON.stringify(publicPackage(undefined)),
		"packages/example/src/index.ts": [
			'export { createThing, type PublicOptions, type PublicResult } from "./api.ts";',
			'import { makeValue } from "./api.ts";',
			"export const inferred = makeValue();",
		].join("\n"),
		"packages/example/src/api.ts": [
			"export interface PublicOptions { mode: Mode; nested?: Nested }",
			"export interface PublicResult { value: Value }",
			"export interface Mode { tag: string }",
			"export interface Nested { deep: boolean }",
			"export interface Value { amount: number }",
			"export interface Inferred { tag: string }",
			"export interface Unrelated { x: number }",
			"export type UnrelatedType = string;",
			"export function createThing(options: PublicOptions): PublicResult {",
			"  return { value: { amount: options.mode.tag.length } };",
			"}",
			'export function makeValue(): Inferred { return { tag: "x" }; }',
		].join("\n"),
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), [
		"packages/example/src/api.ts:Unrelated:zero-reference",
		"packages/example/src/api.ts:UnrelatedType:zero-reference",
	]);
});

test("literal dynamic imports and namespace property access count as uses", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/literal.ts": "export const viaLiteral = 1;\nexport const literalOther = 2;\n",
		"packages/example/src/use-literal.ts": 'const module = await import("./literal.ts");\nvoid module.viaLiteral;\n',
		"packages/example/src/namespace.ts": "export const viaNamespace = 1;\nexport const namespaceOther = 2;\n",
		"packages/example/src/use-namespace.ts":
			'import * as namespace from "./namespace.ts";\nvoid namespace.viaNamespace;\n',
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), ["packages/example/src/namespace.ts:namespaceOther:zero-reference"]);
});

test("computed namespace access is coverage uncertainty, not proof that an export is dead", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/computed.ts": "export const viaComputed = 1;\nexport const computedOther = 2;\n",
		"packages/example/src/use-computed.ts":
			'import * as namespace from "./computed.ts";\nconst key: string = "viaComputed";\nvoid namespace[key];\n',
	});
	const result = scan();
	assert.deepEqual(result.uncertainties.global, []);
	assert.equal(result.uncertainties.modules.length, 1);
	assert.match(result.uncertainties.modules[0].module, /computed\.ts$/);
	const candidates = candidatesByExport(result);
	assert.equal(candidates.get("viaComputed").uncertain, true);
	assert.equal(candidates.get("computedOther").uncertain, true);
	assert.match(candidates.get("viaComputed").review, /computed namespace/);
});

test("unresolved dynamic imports produce global uncertainty and never a clean conclusion", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/dead.ts": "export const globalDead = 1;\n",
		"packages/example/src/use-dynamic.ts": 'const path: string = process.env.MODULE ?? "";\nawait import(path);\n',
	});
	const result = scan();
	assert.equal(result.uncertainties.global.length, 1);
	assert.match(result.uncertainties.global[0].kind, /unresolved dynamic import/);
	const candidate = candidatesByExport(result).get("globalDead");
	assert.equal(candidate.category, "zero-reference");
	assert.equal(candidate.uncertain, true);
});

test("candidate categories distinguish zero, same-file, test-only and barrel-only references", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/categories.ts": [
			"export const zero = 1;",
			"const same = 1;",
			"export { same as sameFile };",
			"function readsSame() { return same; }",
			"void readsSame;",
			"export const testOnly = 1;",
			"export const barrelOnly = 1;",
			"export const used = 1;",
			"export const scriptUsed = 1;",
			"export const configUsed = 1;",
		].join("\n"),
		"packages/example/src/barrel.ts": 'export { barrelOnly } from "./categories.ts";\n',
		"packages/example/src/use.ts": 'import { used } from "./categories.ts";\nvoid used;\n',
		"packages/example/test/categories.test.ts": 'import { testOnly } from "../src/categories.ts";\nvoid testOnly;\n',
		"scripts/use.ts": 'import { scriptUsed } from "../packages/example/src/categories.ts";\nvoid scriptUsed;\n',
		"packages/example/vitest.config.ts": 'import { configUsed } from "./src/categories.ts";\nvoid configUsed;\n',
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), [
		"packages/example/src/categories.ts:barrelOnly:barrel-only",
		"packages/example/src/categories.ts:sameFile:same-file-only",
		"packages/example/src/categories.ts:testOnly:test-only",
		"packages/example/src/categories.ts:zero:zero-reference",
	]);
});

test("baseline identities stay stable across line moves and report new or resolved candidates explicitly", (t) => {
	const { scan, write } = fixture(t, {
		"packages/example/src/a.ts": "export const one = 1;\nexport const two = 2;\n",
	});
	const initial = scan();
	assert.deepEqual(initial.snapshot.candidates, [
		{ file: "packages/example/src/a.ts", export: "one", category: "zero-reference" },
		{ file: "packages/example/src/a.ts", export: "two", category: "zero-reference" },
	]);
	write("packages/example/src/a.ts", "// moved and padded\nexport const one = 1;\n\n\nexport const two = 2;\n");
	assert.deepEqual(scan().snapshot, initial.snapshot);

	write(
		"packages/example/src/a.ts",
		"// moved and padded\nexport const one = 1;\n\n\nexport const two = 2;\nexport const three = 3;\n",
	);
	const added = scan();
	assert.deepEqual(deadExportChanges(added.snapshot, initial.snapshot).added, [
		{ file: "packages/example/src/a.ts", export: "three", category: "zero-reference" },
	]);
	assert.deepEqual(deadExportChanges(added.snapshot, initial.snapshot).removed, []);

	write("packages/example/src/a.ts", "export const two = 2;\n");
	write("packages/example/src/use.ts", 'import { one } from "./a.ts";\nvoid one;\n');
	const resolved = scan();
	const changes = deadExportChanges(resolved.snapshot, added.snapshot);
	assert.deepEqual(changes.added, []);
	assert.deepEqual(changes.removed, [
		{ file: "packages/example/src/a.ts", export: "one", category: "zero-reference" },
		{ file: "packages/example/src/a.ts", export: "three", category: "zero-reference" },
	]);
});

test("normal reports are advisory, never write files and tolerate missing or invalid baselines", (t) => {
	const { root, read, write, run } = fixture(t, {
		"packages/example/src/a.ts": "export const dead = 1;\n",
	});
	const missing = run();
	assert.equal(missing.status, 0, missing.stderr);
	assert.match(missing.stdout, /Dead export candidates/);
	assert.match(missing.stdout, /No files changed/);
	assert.match(missing.stderr, /is missing/);
	assert.equal(existsSync(join(root, baselineFile)), false);

	write(baselineFile, "{invalid");
	const invalid = run();
	assert.equal(invalid.status, 0, invalid.stderr);
	assert.match(invalid.stderr, /not valid JSON/);
	assert.equal(read(baselineFile), "{invalid");
	write(baselineFile, { version: 1, candidates: [{ file: "a.ts", export: "x", category: "invalid" }] });
	const invalidShape = read(baselineFile);
	const invalidSchema = run();
	assert.equal(invalidSchema.status, 0, invalidSchema.stderr);
	assert.match(invalidSchema.stderr, /invalid category/);
	assert.equal(read(baselineFile), invalidShape);

	write(
		baselineFile,
		JSON.stringify({ version: 1, candidates: [{ file: "a.ts", export: "x", category: "not-a-category" }] }),
	);
	const structurallyInvalid = run();
	assert.equal(structurallyInvalid.status, 0, structurallyInvalid.stderr);
	assert.match(structurallyInvalid.stderr, /invalid category/);

	const update = run(["--update"]);
	assert.equal(update.status, 0, update.stderr);
	const baseline = read(baselineFile);
	assert.equal(validateDeadExportBaseline(JSON.parse(baseline)), undefined);
	const before = run();
	assert.equal(before.status, 0, before.stderr);
	assert.equal(read(baselineFile), baseline);
	const secondUpdate = run(["--update"]);
	assert.equal(secondUpdate.status, 0, secondUpdate.stderr);
	assert.equal(read(baselineFile), baseline);
	assert.equal(read("packages/example/src/a.ts"), "export const dead = 1;\n");
});

test("malformed scans keep normal reports nonblocking but refuse baseline updates", (t) => {
	const { root, read, write, run } = fixture(t, {
		"packages/example/src/a.ts": "export const dead = 1;\n",
	});
	assert.equal(run(["--update"]).status, 0);
	const baseline = read(baselineFile);
	write("packages/example/src/bad.ts", "export const broken = ;\n");
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stderr, /scan failed/);
	assert.equal(read(baselineFile), baseline);
	const update = run(["--update"]);
	assert.equal(update.status, 1);
	assert.match(update.stderr, /Refusing to update|scan failed/);
	assert.equal(read(baselineFile), baseline);
	assert.equal(existsSync(join(root, baselineFile)), true);
});

test("importing the checker and exporting its API has no side effects", (t) => {
	const { root } = fixture(t, {
		"packages/example/src/a.ts": "export const dead = 1;\n",
	});
	const imported = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const module = await import(${JSON.stringify(script)}); console.log(typeof module.scanDeadExports, typeof module.deadExportChanges, typeof module.validateDeadExportBaseline);`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout.trim(), "function function function");
	assert.equal(existsSync(join(root, baselineFile)), false);
	assert.equal(existsSync(join(root, "scripts")), false);
});
