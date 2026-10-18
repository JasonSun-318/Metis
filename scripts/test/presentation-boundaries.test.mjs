import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	presentationBoundaryChanges,
	scanPresentationBoundaries,
	validatePresentationBoundaryBaseline,
} from "../check-presentation-boundaries.mjs";

const checkerScript = fileURLToPath(new URL("../check-presentation-boundaries.mjs", import.meta.url));
const BASELINE = "scripts/baselines/presentation-boundaries.json";

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-presentation-boundaries-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const sources = {
		"packages/coding-agent/src/core/.gitkeep": "",
		"packages/coding-agent/src/presentation/.gitkeep": "",
		"packages/coding-agent/src/modes/.gitkeep": "",
		...files,
	};
	for (const [file, source] of Object.entries(sources)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
	}
	return root;
}

function writeBaseline(root, baseline, path = BASELINE) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, typeof baseline === "string" ? baseline : `${JSON.stringify(baseline, null, "\t")}\n`);
	return target;
}

function runCli(root, args) {
	return spawnSync(process.execPath, [checkerScript, "--root", root, ...args], { cwd: root, encoding: "utf8" });
}

function listFiles(root) {
	const files = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) walk(absolute);
			else files.push(relative(root, absolute).replaceAll("\\", "/"));
		}
	};
	walk(root);
	return files.sort();
}

function edge(source, target, rule, kind) {
	return { source, target, rule, kind };
}

function labels(result) {
	return result.edges.map((entry) => `${entry.source} -> ${entry.target} [${entry.rule}, ${entry.kind}]`);
}

const modeValue = "packages/coding-agent/src/modes/value.ts";
const modeTypes = "packages/coding-agent/src/modes/types.ts";
const coreSourceInfo = "packages/coding-agent/src/core/source-info.ts";

test("scanner reports the three rules and distinguishes type/runtime/default imports", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;\nexport interface ModeValue {}",
		[modeTypes]: "export interface ModeType {}\nexport interface AnotherType {}",
		"packages/coding-agent/src/core/runtime-value.ts": "export const runtimeValue = 1;",
		"packages/coding-agent/src/core/rules.ts": [
			'import modeValue from "../modes/value.ts";',
			'import type { ModeType } from "../modes/types.ts";',
			'import { type AnotherType } from "../modes/types.ts";',
			"export const value = modeValue;",
			"export type Combined = ModeType | AnotherType;",
		].join("\n"),
		"packages/coding-agent/src/presentation/rules.ts": [
			'export * from "../modes/value.ts";',
			'export type { ModeType } from "../modes/types.ts";',
			'import type { SourceInfo } from "../core/source-info.ts";',
			"export type Source = SourceInfo;",
		].join("\n"),
		[coreSourceInfo]: "export interface SourceInfo { path: string }",
		"packages/coding-agent/src/presentation/runtime-core.ts": [
			'import { runtimeValue } from "../core/runtime-value.ts";',
			"export const value = runtimeValue;",
		].join("\n"),
		"packages/coding-agent/src/core/import-types.ts": [
			'type A = import("../modes/value.ts").ModeValue;',
			'type B = typeof import("../modes/value.ts");',
			'const lazy = () => import("../modes/value.ts");',
			'const required = require("../modes/value.ts");',
			"export type { A, B };",
			"export const load = [lazy, required];",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(labels(result), [
		"packages/coding-agent/src/core/import-types.ts -> packages/coding-agent/src/modes/value.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/core/import-types.ts -> packages/coding-agent/src/modes/value.ts [core-to-modes, type]",
		"packages/coding-agent/src/core/rules.ts -> packages/coding-agent/src/modes/types.ts [core-to-modes, type]",
		"packages/coding-agent/src/core/rules.ts -> packages/coding-agent/src/modes/value.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/presentation/rules.ts -> packages/coding-agent/src/modes/types.ts [presentation-to-modes, type]",
		"packages/coding-agent/src/presentation/rules.ts -> packages/coding-agent/src/modes/value.ts [presentation-to-modes, runtime]",
		"packages/coding-agent/src/presentation/runtime-core.ts -> packages/coding-agent/src/core/runtime-value.ts [runtime-presentation-to-core, runtime]",
	]);
});

test("comments, strings, and regex literals do not create boundary edges", (t) => {
	const root = fixture(t, {
		"packages/coding-agent/src/core/noise.ts": [
			'// import { hidden } from "../modes/value.ts";',
			'/* require("../modes/value.ts") */',
			"const single = 'import { hidden } from \"../modes/value.ts\"';",
			'const template = `export * from "../modes/value.ts"`;',
			'const pattern = /require\\("\\.\\.\\/modes\\/value\\.ts"\\)/;',
			"export const noise = [single, template, pattern];",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.deepEqual(result.edges, []);
	assert.deepEqual(result.occurrences, []);
	assert.deepEqual(result.diagnostics, []);
});

test("legacy modes shims and type-only or implicitly erased presentation core imports are allowed", (t) => {
	const root = fixture(t, {
		[coreSourceInfo]: "export interface SourceInfo { path: string }",
		"packages/coding-agent/src/modes/legacy.ts": 'export * from "../presentation/theme.ts";',
		"packages/coding-agent/src/modes/index.ts": 'export * from "./legacy.ts";',
		"packages/coding-agent/src/presentation/theme.ts": [
			'import type { SourceInfo } from "../core/source-info.ts";',
			'export type { SourceInfo } from "../core/source-info.ts";',
			"export type ThemeSource = SourceInfo;",
		].join("\n"),
		"packages/coding-agent/src/presentation/implicit.ts": [
			'import { SourceInfo } from "../core/source-info.ts";',
			"export type ImplicitSource = SourceInfo;",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(result.edges, []);
});

test("type-aware emit distinguishes implicit type reexports from value reexports", (t) => {
	const root = fixture(t, {
		[coreSourceInfo]: "export interface SourceInfo { path: string }",
		"packages/coding-agent/src/core/runtime-value.ts": "export const runtimeValue = 1;",
		[modeTypes]: "export interface ModeType {}",
		[modeValue]: "export const modeValue = 1;",
		"packages/coding-agent/src/presentation/reexport-type.ts": [
			'import { SourceInfo as ImplicitSource } from "../core/source-info.ts";',
			"export type ImplicitAlias = ImplicitSource;",
			'export { SourceInfo } from "../core/source-info.ts";',
		].join("\n"),
		"packages/coding-agent/src/presentation/reexport-value.ts": [
			'import { runtimeValue as rv } from "../core/runtime-value.ts";',
			"export const rv2 = rv;",
			'export { runtimeValue } from "../core/runtime-value.ts";',
		].join("\n"),
		"packages/coding-agent/src/core/reexport-type.ts": 'export { ModeType } from "../modes/types.ts";',
		"packages/coding-agent/src/core/reexport-value.ts": 'export { modeValue } from "../modes/value.ts";',
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(labels(result), [
		"packages/coding-agent/src/core/reexport-type.ts -> packages/coding-agent/src/modes/types.ts [core-to-modes, type]",
		"packages/coding-agent/src/core/reexport-value.ts -> packages/coding-agent/src/modes/value.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/presentation/reexport-value.ts -> packages/coding-agent/src/core/runtime-value.ts [runtime-presentation-to-core, runtime]",
	]);
});

test("import-equals declarations are type-only when erased and runtime when required", (t) => {
	const root = fixture(t, {
		[coreSourceInfo]: "export interface SourceInfo { path: string }",
		"packages/coding-agent/src/core/runtime-value.ts": "export const runtimeValue = 1;",
		[modeValue]: "export const modeValue = 1;",
		"packages/coding-agent/src/presentation/implicit-require.ts": [
			'import sourceInfo = require("../core/source-info.ts");',
			"export type P = typeof sourceInfo;",
		].join("\n"),
		"packages/coding-agent/src/core/require-equals.ts": [
			'import modeValue = require("../modes/value.ts");',
			"export const value = modeValue.modeValue;",
		].join("\n"),
		"packages/coding-agent/src/presentation/require-equals.ts": [
			'import runtime = require("../core/runtime-value.ts");',
			"export const value = runtime.runtimeValue;",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(labels(result), [
		"packages/coding-agent/src/core/require-equals.ts -> packages/coding-agent/src/modes/value.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/presentation/require-equals.ts -> packages/coding-agent/src/core/runtime-value.ts [runtime-presentation-to-core, runtime]",
	]);
});

test("root tsconfig emitDecoratorMetadata keeps decorated parameter classes runtime", (t) => {
	const root = fixture(t, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				experimentalDecorators: true,
				emitDecoratorMetadata: true,
				types: [],
			},
		}),
		"packages/coding-agent/src/modes/service.ts": "export class Service {}",
		"packages/coding-agent/src/core/decorated.ts": [
			'import { Service } from "../modes/service.ts";',
			"function Inject(): ParameterDecorator {",
			"  return () => {};",
			"}",
			"class Consumer {",
			"  constructor(@Inject() service: Service) {}",
			"}",
			"export const consumer = Consumer;",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(labels(result), [
		"packages/coding-agent/src/core/decorated.ts -> packages/coding-agent/src/modes/service.ts [core-to-modes, runtime]",
	]);
});

test("decorator metadata erases imported interfaces without false runtime presentation edges", (t) => {
	const root = fixture(t, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true },
		}),
		"packages/coding-agent/src/core/model.ts": "export interface Model { value: string }",
		"packages/coding-agent/src/presentation/view.ts": [
			'import { Model } from "../core/model.ts";',
			"function inject(): ParameterDecorator { return () => {}; }",
			"class View { constructor(@inject() model: Model) {} }",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(result.edges, []);
});

test("relative extensions and directory indexes normalize to canonical source targets", (t) => {
	const root = fixture(t, {
		"packages/coding-agent/src/core/paths.ts": [
			'import { a } from "../modes/a.js";',
			'import { b } from "../modes/b";',
			'import { c } from "../modes/dir";',
			'import { d } from "../modes/dir/index.js";',
			"export const values = [a, b, c, d];",
		].join("\n"),
		"packages/coding-agent/src/core/tsx-paths.tsx": [
			'import { component } from "../modes/component.jsx";',
			"export const render = component;",
		].join("\n"),
		"packages/coding-agent/src/modes/a.ts": "export const a = 1;",
		"packages/coding-agent/src/modes/b.ts": "export const b = 2;",
		"packages/coding-agent/src/modes/component.tsx": "export const component = () => null;",
		"packages/coding-agent/src/modes/dir/index.ts": "export const c = 3;\nexport const d = 4;",
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, false, JSON.stringify(result.diagnostics));
	assert.deepEqual(labels(result), [
		"packages/coding-agent/src/core/paths.ts -> packages/coding-agent/src/modes/a.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/core/paths.ts -> packages/coding-agent/src/modes/b.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/core/paths.ts -> packages/coding-agent/src/modes/dir/index.ts [core-to-modes, runtime]",
		"packages/coding-agent/src/core/tsx-paths.tsx -> packages/coding-agent/src/modes/component.tsx [core-to-modes, runtime]",
	]);
	assert.equal(result.occurrences.filter((occurrence) => occurrence.target.endsWith("/modes/dir/index.ts")).length, 2);
});

test("line moves change occurrences but not incremental edge identity", (t) => {
	const file = "packages/coding-agent/src/core/move.ts";
	const source = 'import { modeValue } from "../modes/value.ts";\nexport const value = modeValue;';
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;",
		[file]: source,
	});
	const before = scanPresentationBoundaries(root);
	const baseline = before.snapshot;
	writeFileSync(join(root, file), `\n\n\n${source}`);
	const after = scanPresentationBoundaries(root);
	const changes = presentationBoundaryChanges(after.snapshot, baseline);
	assert.equal(changes.added.length, 0);
	assert.equal(changes.removed.length, 0);
	assert.equal(changes.unchanged.length, 1);
	assert.ok(after.occurrences[0].line > before.occurrences[0].line);
});

test("comparator reports new, removed, and unchanged entries separately", () => {
	const unchanged = edge(
		"packages/coding-agent/src/core/a.ts",
		"packages/coding-agent/src/modes/one.ts",
		"core-to-modes",
		"runtime",
	);
	const removed = edge(
		"packages/coding-agent/src/core/a.ts",
		"packages/coding-agent/src/modes/two.ts",
		"core-to-modes",
		"type",
	);
	const added = edge(
		"packages/coding-agent/src/presentation/b.ts",
		"packages/coding-agent/src/modes/one.ts",
		"presentation-to-modes",
		"runtime",
	);
	const changes = presentationBoundaryChanges([unchanged, added], { version: 1, edges: [unchanged, removed] });
	assert.deepEqual(changes.added, [added]);
	assert.deepEqual(changes.removed, [removed]);
	assert.deepEqual(changes.unchanged, [unchanged]);
});

test("duplicate occurrences collapse per source/target/rule/kind while type and runtime stay distinct", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const a = 1;\nexport const b = 2;\nexport interface T {}",
		"packages/coding-agent/src/core/duplicates.ts": [
			'import { a } from "../modes/value.ts";',
			'import { b } from "../modes/value.ts";',
			'import type { T } from "../modes/value.ts";',
			"export const total = a + b;",
			"export type X = T;",
		].join("\n"),
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.edges.length, 2);
	assert.deepEqual(
		result.edges.map((entry) => entry.kind),
		["runtime", "type"],
	);
	assert.equal(result.occurrences.length, 3);
});

test("normal CLI findings exit 0 and do not mutate the baseline", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;",
		"packages/coding-agent/src/core/findings.ts": [
			'import { modeValue } from "../modes/value.ts";',
			"export const value = modeValue;",
		].join("\n"),
	});
	const baselinePath = writeBaseline(root, { version: 1, edges: [] });
	const beforeBaseline = readFileSync(baselinePath, "utf8");
	const beforeFiles = listFiles(root);
	const result = runCli(root, ["--baseline", BASELINE]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /New boundary edges \(1\):/);
	assert.match(result.stdout, /Removed baseline boundary edges \(0\):/);
	assert.match(result.stdout, /Unchanged boundary edges \(0\):/);
	assert.equal(readFileSync(baselinePath, "utf8"), beforeBaseline);
	assert.deepEqual(listFiles(root), beforeFiles);
});

test("a missing baseline is diagnostic only and writes nothing", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;",
		"packages/coding-agent/src/core/missing-baseline.ts": [
			'import { modeValue } from "../modes/value.ts";',
			"export const value = modeValue;",
		].join("\n"),
	});
	const result = runCli(root, []);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /is missing/);
	assert.match(result.stdout, /Incremental comparison skipped/);
	assert.equal(existsSync(join(root, BASELINE)), false);
});

test("malformed and invalid baselines remain advisory and unchanged", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;",
		"packages/coding-agent/src/core/baseline.ts": [
			'import { modeValue } from "../modes/value.ts";',
			"export const value = modeValue;",
		].join("\n"),
	});
	const malformedPath = writeBaseline(root, "{not json", "scripts/baselines/malformed.json");
	const malformed = readFileSync(malformedPath, "utf8");
	const malformedRun = runCli(root, ["--baseline", "scripts/baselines/malformed.json"]);
	assert.equal(malformedRun.status, 0, malformedRun.stderr);
	assert.match(malformedRun.stderr, /not valid JSON/);
	assert.equal(readFileSync(malformedPath, "utf8"), malformed);

	const invalidPath = writeBaseline(
		root,
		{
			version: 1,
			edges: [
				{
					source: "packages/coding-agent/src/core/baseline.ts",
					target: "packages/coding-agent/src/presentation/theme.ts",
					rule: "core-to-modes",
					kind: "runtime",
				},
			],
		},
		"scripts/baselines/invalid.json",
	);
	const invalid = readFileSync(invalidPath, "utf8");
	const invalidRun = runCli(root, ["--baseline", "scripts/baselines/invalid.json"]);
	assert.equal(invalidRun.status, 0, invalidRun.stderr);
	assert.match(invalidRun.stderr, /is invalid/);
	assert.equal(readFileSync(invalidPath, "utf8"), invalid);
});

test("source read errors make the scan incomplete", (t) => {
	const root = fixture(t, {
		"packages/coding-agent/src/core/unreadable.ts": "export const value = 1;",
	});
	const result = scanPresentationBoundaries(root, {
		readFile: () => {
			throw new Error("permission denied");
		},
	});
	assert.equal(result.incomplete, true);
	assert.match(result.diagnostics[0].message, /Cannot read source file/);
});

test("missing type-aware emit output makes classification incomplete", (t) => {
	const root = fixture(t, {
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "AMD",
				moduleResolution: "Bundler",
				outFile: "bundle.js",
				allowImportingTsExtensions: true,
				rewriteRelativeImportExtensions: true,
				types: [],
			},
		}),
		[modeTypes]: "export interface ModeType {}",
		"packages/coding-agent/src/core/reexport.ts": 'export { ModeType } from "../modes/types.ts";',
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, true);
	assert.match(
		result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
		/Type-aware emit (?:produced no output|failed)/,
	);
	const normal = runCli(root, []);
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete:/);
	assert.equal(existsSync(join(root, BASELINE)), false);
	const update = runCli(root, ["--update"]);
	assert.equal(update.status, 1, update.stderr);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(existsSync(join(root, BASELINE)), false);
});

test("invalid root tsconfig makes classification incomplete and refuses update", (t) => {
	const root = fixture(t, {
		"tsconfig.json": "{not json",
		[modeTypes]: "export interface ModeType {}",
		"packages/coding-agent/src/core/reexport.ts": 'export { ModeType } from "../modes/types.ts";',
	});
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, true);
	assert.match(
		result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
		/Cannot (?:read|parse) .*tsconfig\.json/,
	);
	const normal = runCli(root, []);
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete:/);
	const update = runCli(root, ["--update"]);
	assert.equal(update.status, 1, update.stderr);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(existsSync(join(root, BASELINE)), false);
});

test("missing required core/presentation directories are diagnosed and refuse update", (t) => {
	const root = fixture(t, {
		"packages/coding-agent/src/core/one.ts": "export const one = 1;",
	});
	rmSync(join(root, "packages/coding-agent/src/presentation"), { recursive: true, force: true });
	const result = scanPresentationBoundaries(root);
	assert.equal(result.incomplete, true);
	assert.match(
		result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
		/Required source directory packages\/coding-agent\/src\/presentation is missing/,
	);
	const normal = runCli(root, []);
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete:/);
	const update = runCli(root, ["--update"]);
	assert.equal(update.status, 1, update.stderr);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(existsSync(join(root, BASELINE)), false);
});

test("baseline validation rejects unsafe paths, unknown rules/kinds, and duplicates", () => {
	const valid = edge(
		"packages/coding-agent/src/core/a.ts",
		"packages/coding-agent/src/modes/one.ts",
		"core-to-modes",
		"runtime",
	);
	assert.equal(validatePresentationBoundaryBaseline({ version: 1, edges: [valid] }), undefined);
	assert.match(validatePresentationBoundaryBaseline({ version: 2, edges: [] }), /unsupported baseline version/);
	assert.match(
		validatePresentationBoundaryBaseline({ version: 1, edges: [{ ...valid, source: "../core/a.ts" }] }),
		/unsafe or non-relative source path/,
	);
	assert.match(
		validatePresentationBoundaryBaseline({ version: 1, edges: [{ ...valid, rule: "unknown" }] }),
		/invalid rule/,
	);
	assert.match(
		validatePresentationBoundaryBaseline({ version: 1, edges: [{ ...valid, kind: "value" }] }),
		/invalid kind/,
	);
	assert.match(
		validatePresentationBoundaryBaseline({ version: 1, edges: [valid, { ...valid }] }),
		/duplicate edge identity/,
	);
});

const incompleteCases = {
	"unresolved relative import": 'import { missing } from "../modes/missing.ts";\nexport const value = missing;',
	"syntax error": "export const = ;",
	"computed dynamic import": 'const target = "./value.ts";\nexport const load = () => import(target);',
	"computed require": 'const target = "./value.ts";\nexport const load = () => require(target);',
};

for (const [name, source] of Object.entries(incompleteCases)) {
	test(`incomplete scan is advisory normally and refuses --update: ${name}`, (t) => {
		const root = fixture(t, {
			[modeValue]: "export const modeValue = 1;",
			"packages/coding-agent/src/core/incomplete.ts": source,
		});
		const normal = runCli(root, []);
		assert.equal(normal.status, 0, normal.stderr);
		assert.match(normal.stdout, /Scan incomplete:/);
		assert.equal(existsSync(join(root, BASELINE)), false);

		const update = runCli(root, ["--update"]);
		assert.equal(update.status, 1, update.stderr);
		assert.match(update.stderr, /Refusing to update the presentation boundary baseline/);
		assert.equal(existsSync(join(root, BASELINE)), false);
	});
}

test("--update writes a deterministic line-free baseline and normal runs compare it", (t) => {
	const root = fixture(t, {
		[modeValue]: "export const modeValue = 1;",
		[modeTypes]: "export interface ModeType {}",
		"packages/coding-agent/src/core/update.ts": [
			'import { modeValue } from "../modes/value.ts";',
			'import type { ModeType } from "../modes/types.ts";',
			"export const value = modeValue;",
			"export type T = ModeType;",
		].join("\n"),
	});
	const customBaseline = "scripts/baselines/custom-presentation-boundaries.json";
	const update = runCli(root, ["--update", "--baseline", customBaseline]);
	assert.equal(update.status, 0, update.stderr);
	const baselinePath = join(root, customBaseline);
	const baselineText = readFileSync(baselinePath, "utf8");
	const baseline = JSON.parse(baselineText);
	assert.deepEqual(baseline, scanPresentationBoundaries(root).snapshot);
	assert.deepEqual(Object.keys(baseline), ["version", "edges"]);
	assert.deepEqual(Object.keys(baseline.edges[0]), ["source", "target", "rule", "kind"]);
	assert.equal(
		baseline.edges.some((entry) => "line" in entry),
		false,
	);

	const normal = runCli(root, ["--baseline", customBaseline]);
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /New boundary edges \(0\):/);
	assert.match(normal.stdout, /Removed baseline boundary edges \(0\):/);
	assert.match(normal.stdout, /Unchanged boundary edges \(2\):/);
	assert.equal(readFileSync(baselinePath, "utf8"), baselineText);
});

test("CLI usage errors are the only nonzero normal-path exits", (t) => {
	const root = fixture(t, {});
	const result = runCli(root, ["--unknown"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Unknown argument/);
	assert.match(result.stderr, /Usage: node scripts\/check-presentation-boundaries\.mjs/);
});
