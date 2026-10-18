import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	baselineFromSnapshot,
	DUPLICATE_THRESHOLD,
	duplicateChanges,
	duplicateSnapshot,
} from "../check-duplicates.mjs";

const script = fileURLToPath(new URL("../check-duplicates.mjs", import.meta.url));

function write(root, file, source) {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), source);
}

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-duplicates-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const [file, source] of Object.entries(files)) write(root, file, source);
	return root;
}

function run(root, args = []) {
	return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

function baselineFile(root) {
	return join(root, "scripts/baselines/duplicates.json");
}

function writeBaseline(root, baseline) {
	write(root, "scripts/baselines/duplicates.json", `${JSON.stringify(baseline, null, "\t")}\n`);
}

function implementation({ ident = "value", literal = "one", offset = 1, quote = '"' } = {}) {
	const statements = [`let ${ident} = input + ${offset};`];
	for (let index = 1; index <= 18; index++) {
		statements.push(`${ident} = ${ident} * ${index} + ${index};`);
	}
	statements.push(`if (${ident} > 100) { ${ident} = ${ident} - ${offset}; }`);
	statements.push(`return ${ident} + ${quote}${literal}${quote}.length;`);
	return statements;
}

function functionSource(name, options = {}) {
	return `export function ${name}(input: number) {\n\t${implementation(options).join("\n\t")}\n}\n`;
}

function reformattedFunctionSource(name, options = {}) {
	const statements = implementation({ ...options, quote: "'" });
	return `/** Documentation is not implementation. */\nexport function ${name}(\n\tinput: number,\n) {\n\t// Comments and whitespace are normalized away.\n\t/* block comment */\n\t${statements.map((statement) => statement.replaceAll(";", "")).join("\n\n\t")}\n}\n`;
}

function arrowSource(name, options = {}) {
	return `export const ${name} = (input: number) => {\n\t${implementation(options).join("\n\t")}\n};\n`;
}

function expressionSource(name, options = {}) {
	return `export const ${name} = function (input: number) {\n\t${implementation(options).join("\n\t")}\n};\n`;
}

function propertySource(name, options = {}) {
	return `export const ${name} = {\n\tcompute: (input: number) => {\n\t\t${implementation(options).join("\n\t\t")}\n\t},\n};\n`;
}

function methodSource(className, options = {}) {
	return `export class ${className} {\n\tcompute(input: number) {\n\t\t${implementation(options).join("\n\t\t")}\n\t}\n}\n`;
}

function templateSource(name, text) {
	const statements = implementation();
	statements.splice(statements.length - 1, 0, `const label = \`${text} \${input}\`;`);
	statements[statements.length - 1] = "return value + label.length + input;";
	return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
}

function jsxSource(name, text) {
	const statements = implementation();
	statements.splice(statements.length - 1, 0, `const node = <div title="same">${text}</div>;`);
	statements[statements.length - 1] = "return node;";
	return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
}

function parameterVariantSource(name, { parameter = "input", type = "number", initializer = "", modifier = "" } = {}) {
	const statements = implementation().map((statement) => statement.replaceAll("input", "42"));
	return `export ${modifier}function ${name}(${parameter}: ${type}${initializer}) {\n\t${statements.join("\n\t")}\n}\n`;
}

function optionalChainSource(name, grouped) {
	const statements = implementation();
	statements.splice(
		statements.length - 1,
		0,
		grouped ? "const result = (obj?.method)();" : "const result = obj?.method();",
	);
	statements[statements.length - 1] = "return result ?? value;";
	return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
}

function taggedTemplateSource(name, rawText) {
	const statements = implementation();
	statements.splice(statements.length - 1, 0, `const raw = String.raw\`${rawText}\`;`);
	statements[statements.length - 1] = "return value + raw.length + input;";
	return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
}

test("formatting, comments, quote style and optional semicolons do not change a duplicate", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": functionSource("alpha"),
			"packages/example/src/b.ts": reformattedFunctionSource("alpha"),
		}),
	);
	assert.equal(snapshot.clusters.length, 1);
	assert.ok(snapshot.clusters[0].tokens >= DUPLICATE_THRESHOLD);
	assert.deepEqual(
		snapshot.clusters[0].occurrences.map(({ file, symbol }) => ({ file, symbol })),
		[
			{ file: "packages/example/src/a.ts", symbol: "alpha" },
			{ file: "packages/example/src/b.ts", symbol: "alpha" },
		],
	);
});

test("renamed copies with identical signatures and bodies are duplicates", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": functionSource("firstCopy"),
			"packages/example/src/b.ts": functionSource("secondCopy"),
		}),
	);
	assert.equal(snapshot.clusters.length, 1);
	assert.deepEqual(
		snapshot.clusters[0].occurrences.map((occurrence) => occurrence.symbol),
		["firstCopy", "secondCopy"],
	);

	const root = fixture(t, {
		"packages/example/src/a.ts": functionSource("original"),
		"packages/example/src/b.ts": functionSource("original"),
	});
	const baseline = baselineFromSnapshot(duplicateSnapshot(root));
	write(root, "packages/example/src/b.ts", functionSource("renamed"));
	const changes = duplicateChanges(duplicateSnapshot(root), baseline);
	assert.equal(changes.added.length, 1);
	assert.deepEqual(
		changes.added.map(({ file, symbol }) => ({ file, symbol })),
		[{ file: "packages/example/src/b.ts", symbol: "renamed" }],
	);
});

test("nested callable names remain significant", (t) => {
	const source = (name, nestedName) => {
		const statements = implementation();
		statements.splice(statements.length - 1, 0, `function ${nestedName}() { return 1; }`);
		statements[statements.length - 1] = "return value + input;";
		return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
	};
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": source("outer", "nestedOne"),
			"packages/example/src/b.ts": source("outer", "nestedTwo"),
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
});

test("parameter names, modifiers, types and defaults remain significant", (t) => {
	const changes = [
		["parameter", { parameter: "input" }, { parameter: "seed" }],
		["modifier", { modifier: "" }, { modifier: "async " }],
		["type", { type: "number" }, { type: "string" }],
		["default", { initializer: "" }, { initializer: " = 1" }],
	];
	for (const [label, left, right] of changes) {
		const snapshot = duplicateSnapshot(
			fixture(t, {
				"packages/example/src/a.ts": parameterVariantSource("changed", left),
				"packages/example/src/b.ts": parameterVariantSource("changed", right),
			}),
		);
		assert.deepEqual(snapshot.clusters, [], label);
	}
});

test("parenthesized optional-chain grouping stays significant", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": optionalChainSource("optionalChain", true),
			"packages/example/src/b.ts": optionalChainSource("optionalChain", false),
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
});

test("tagged template raw escapes stay significant", (t) => {
	const different = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": taggedTemplateSource("tagged", "\\n"),
			"packages/example/src/b.ts": taggedTemplateSource("tagged", "\n"),
		}),
	);
	assert.deepEqual(different.clusters, []);
	const same = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": taggedTemplateSource("tagged", "\\n"),
			"packages/example/src/b.ts": taggedTemplateSource("tagged", "\\n"),
		}),
	);
	assert.equal(same.clusters.length, 1);
});

test("whitespace inside string literals stays significant", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": functionSource("stringCase", { literal: "a  b" }),
			"packages/example/src/b.ts": functionSource("stringCase", { literal: "a b" }),
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
});

test("whitespace inside template literals stays significant", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": templateSource("templateCase", "a  b"),
			"packages/example/src/b.ts": templateSource("templateCase", "a b"),
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
});

test("whitespace inside JSX text stays significant", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.tsx": jsxSource("jsxCase", "a  b"),
			"packages/example/src/b.tsx": jsxSource("jsxCase", "a b"),
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
});

test("literal and identifier changes are not duplicate implementations", (t) => {
	const changes = [
		["literal", { literal: "one" }, { literal: "two" }],
		["number", { offset: 1 }, { offset: 2 }],
		["identifier", { ident: "value" }, { ident: "total" }],
	];
	for (const [label, left, right] of changes) {
		const snapshot = duplicateSnapshot(
			fixture(t, {
				"packages/example/src/a.ts": functionSource("changed", left),
				"packages/example/src/b.ts": functionSource("changed", right),
			}),
		);
		assert.deepEqual(snapshot.clusters, [], label);
	}
});

test("small trivial functions remain below the conservative threshold", (t) => {
	const source = "export function tiny(value: number) {\n\treturn value + 1;\n}\n";
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": source,
			"packages/example/src/b.ts": source,
		}),
	);
	assert.deepEqual(snapshot.clusters, []);
	assert.equal(snapshot.functionsScanned, 2);
	assert.equal(snapshot.eligibleFunctions, 0);
});

test("arrow functions, function expressions and methods are compared", (t) => {
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/arrow-a.ts": arrowSource("compute"),
			"packages/example/src/arrow-b.ts": arrowSource("compute"),
			"packages/example/src/expression-a.ts": expressionSource("compute"),
			"packages/example/src/expression-b.ts": expressionSource("compute"),
			"packages/example/src/method-a.ts": methodSource("Alpha"),
			"packages/example/src/method-b.ts": methodSource("Beta"),
		}),
	);
	assert.equal(snapshot.clusters.length, 3);
	const files = snapshot.clusters.map((cluster) => cluster.occurrences.map((occurrence) => occurrence.file).join(","));
	assert.deepEqual(files.sort(), [
		"packages/example/src/arrow-a.ts,packages/example/src/arrow-b.ts",
		"packages/example/src/expression-a.ts,packages/example/src/expression-b.ts",
		"packages/example/src/method-a.ts,packages/example/src/method-b.ts",
	]);
	assert.ok(
		snapshot.clusters.some((cluster) =>
			cluster.occurrences.every((occurrence) => occurrence.symbol.includes(".compute")),
		),
	);
});

test("a callback that is almost the whole parent is not reported separately", (t) => {
	const source = (name) =>
		`export function ${name}(input: number) {\n\treturn (value: number) => {\n\t\t${implementation().join("\n\t\t")}\n\t};\n}\n`;
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": source("outer"),
			"packages/example/src/b.ts": source("outer"),
		}),
	);
	assert.equal(snapshot.clusters.length, 1);
	assert.deepEqual(
		snapshot.clusters[0].occurrences.map((occurrence) => occurrence.symbol),
		["outer", "outer"],
	);
});

test("nested callbacks covered by a duplicated parent are not extra findings", (t) => {
	const source = (name) => {
		const statements = implementation();
		statements.splice(
			statements.length - 1,
			0,
			`const callback = (item: number) => {\n\t\t${implementation({ ident: "inner" }).join("\n\t\t")}\n\t};`,
		);
		statements[statements.length - 1] = "return callback(value);";
		return `export function ${name}(input: number) {\n\t${statements.join("\n\t")}\n}\n`;
	};
	const snapshot = duplicateSnapshot(
		fixture(t, {
			"packages/example/src/a.ts": source("outer"),
			"packages/example/src/b.ts": source("outer"),
		}),
	);
	assert.equal(snapshot.clusters.length, 1);
	assert.deepEqual(
		snapshot.clusters[0].occurrences.map((occurrence) => occurrence.symbol),
		["outer", "outer"],
	);
});

test("test, fixture, declaration and generated sources are excluded", (t) => {
	const generated = `// This file is auto-generated by a script. Do not edit manually.\n${functionSource("copy")}`;
	const root = fixture(t, {
		"packages/example/src/included.ts": functionSource("included"),
		"packages/example/src/copy.test.ts": functionSource("copy"),
		"packages/example/src/copy.spec.ts": functionSource("copy"),
		"packages/example/src/copy.fixture.ts": functionSource("copy"),
		"packages/example/src/copy.generated.ts": functionSource("copy"),
		"packages/example/src/declarations.d.ts": "declare function copy(input: number): number;\n",
		"packages/example/src/header.ts": generated,
		"packages/example/src/__tests__/copy.ts": functionSource("copy"),
		"packages/example/src/test/copy.ts": functionSource("copy"),
		"packages/example/src/tests/copy.ts": functionSource("copy"),
		"packages/example/src/fixtures/copy.ts": functionSource("copy"),
		"packages/example/src/generated/copy.ts": functionSource("copy"),
		"packages/example/src/__generated__/copy.ts": functionSource("copy"),
		"packages/example/test/outside.ts": functionSource("copy"),
	});
	const snapshot = duplicateSnapshot(root);
	assert.equal(snapshot.filesScanned, 1);
	assert.equal(snapshot.functionsScanned, 1);
	assert.equal(snapshot.eligibleFunctions, 1);
	assert.deepEqual(snapshot.clusters, []);
});

test("a new copy inside an existing cluster and file is a new instance", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": propertySource("first"),
		"packages/example/src/b.ts": propertySource("second"),
	});
	const before = duplicateSnapshot(root);
	assert.equal(before.clusters.length, 1);
	const baseline = baselineFromSnapshot(before);
	const serialized = JSON.stringify(baseline);
	write(root, "packages/example/src/a.ts", `${propertySource("first")}\n${propertySource("third")}`);

	const changes = duplicateChanges(duplicateSnapshot(root), baseline);
	assert.equal(changes.added.length, 1);
	assert.deepEqual(
		changes.added.map(({ file, symbol }) => ({ file, symbol })),
		[{ file: "packages/example/src/a.ts", symbol: "compute" }],
	);
	assert.equal(changes.addedGroups[0].newCluster, false);
	assert.equal(changes.addedGroups[0].baselineCount, 1);
	assert.equal(changes.addedGroups[0].actualCount, 2);
	assert.equal(changes.removedCount, 0);
	assert.equal(JSON.stringify(baseline), serialized);
});

test("removing a duplicate is not reported as a new finding", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
		"packages/example/src/c.ts": arrowSource("third"),
	});
	const baseline = baselineFromSnapshot(duplicateSnapshot(root));
	write(root, "packages/example/src/c.ts", "export const unrelated = 1;\n");

	const changes = duplicateChanges(duplicateSnapshot(root), baseline);
	assert.deepEqual(changes.added, []);
	assert.equal(changes.removedCount, 1);
	assert.deepEqual(
		changes.removed.map(({ file, symbol }) => ({ file, symbol })),
		[{ file: "packages/example/src/c.ts", symbol: "third" }],
	);
});

test("line movement does not create a new instance", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
	});
	const before = duplicateSnapshot(root);
	const baseline = baselineFromSnapshot(before);
	write(root, "packages/example/src/a.ts", `// moved down\n\n\n${arrowSource("first")}`);

	const after = duplicateSnapshot(root);
	assert.deepEqual(duplicateChanges(after, baseline).added, []);
	const line = (snapshot) =>
		snapshot.clusters[0].occurrences.find((occurrence) => occurrence.file.endsWith("/a.ts")).line;
	assert.ok(line(after) > line(before));
});

test("baseline output is deterministic", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
		"packages/example/src/c.ts": arrowSource("third", { literal: "other" }),
		"packages/example/src/d.ts": arrowSource("fourth", { literal: "other" }),
	});
	const first = `${JSON.stringify(baselineFromSnapshot(duplicateSnapshot(root)), null, "\t")}\n`;
	const second = `${JSON.stringify(baselineFromSnapshot(duplicateSnapshot(root)), null, "\t")}\n`;
	assert.equal(first, second);
	const baseline = JSON.parse(first);
	assert.equal(baseline.version, 1);
	assert.equal(baseline.threshold, DUPLICATE_THRESHOLD);
	assert.equal(baseline.clusters.length, 2);
	assert.deepEqual(
		baseline.clusters[0].occurrences.map((occurrence) => occurrence.file),
		[...baseline.clusters[0].occurrences.map((occurrence) => occurrence.file)].sort(),
	);
});

test("normal CLI reports findings, exits 0 and never rewrites the baseline", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
	});
	writeBaseline(root, baselineFromSnapshot(duplicateSnapshot(root)));
	const baselineBytes = readFileSync(baselineFile(root), "utf8");
	write(root, "packages/example/src/a.ts", `${arrowSource("first")}\n${arrowSource("third")}`);

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /New duplicate implementation instances: 1/);
	assert.match(result.stdout, /packages\/example\/src\/a\.ts/);
	assert.match(result.stdout, /packages\/example\/src\/b\.ts:1 second/);
	assert.match(result.stdout, /\+1/);
	assert.equal(readFileSync(baselineFile(root), "utf8"), baselineBytes);
	const again = run(root);
	assert.equal(again.status, 0, again.stderr);
	assert.equal(again.stdout, result.stdout);
});

test("normal CLI exits 0 for line movement and removals without new findings", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
		"packages/example/src/c.ts": arrowSource("third"),
	});
	writeBaseline(root, baselineFromSnapshot(duplicateSnapshot(root)));
	const baselineBytes = readFileSync(baselineFile(root), "utf8");
	write(root, "packages/example/src/a.ts", `// shifted down\n\n${arrowSource("first")}`);
	write(root, "packages/example/src/c.ts", "export const unrelated = 1;\n");

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /No new duplicate implementation instances/);
	assert.match(result.stdout, /Baseline occurrences no longer present: 1/);
	assert.equal(readFileSync(baselineFile(root), "utf8"), baselineBytes);
});

test("normal CLI exits 0 with explicit scan failure diagnostics", (t) => {
	const root = fixture(t, {
		"packages/example/src/broken.ts": "export function broken(input: number) {\n",
	});
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stderr, /Duplicate scan failed:/);
	assert.doesNotMatch(result.stdout, /No new duplicate/);
	assert.equal(existsSync(baselineFile(root)), false);
});

test("normal CLI exits 0 when the baseline is missing", (t) => {
	const root = fixture(t, { "packages/example/src/a.ts": arrowSource("first") });
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stderr, /could not compare:/);
	assert.match(result.stderr, /--update/);
	assert.equal(existsSync(baselineFile(root)), false);
});

test("normal CLI exits 0 with an explicit diagnostic for malformed nested baseline entries", (t) => {
	const root = fixture(t, { "packages/example/src/a.ts": arrowSource("first") });
	writeBaseline(root, {
		version: 1,
		threshold: DUPLICATE_THRESHOLD,
		clusters: [
			{
				hash: "not-a-real-hash",
				tokens: 100,
				occurrences: [{ file: "packages/example/src/a.ts", symbol: "first", count: "one" }],
			},
		],
	});
	const baselineBytes = readFileSync(baselineFile(root), "utf8");
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stderr, /could not compare:/);
	assert.match(result.stderr, /invalid count/);
	assert.equal(readFileSync(baselineFile(root), "utf8"), baselineBytes);
});

test("only --update writes a deterministic versioned baseline", (t) => {
	const root = fixture(t, {
		"packages/example/src/a.ts": arrowSource("first"),
		"packages/example/src/b.ts": arrowSource("second"),
	});
	const update = run(root, ["--update"]);
	assert.equal(update.status, 0, update.stderr);
	const first = readFileSync(baselineFile(root), "utf8");
	const baseline = JSON.parse(first);
	assert.equal(baseline.version, 1);
	assert.equal(baseline.threshold, DUPLICATE_THRESHOLD);
	assert.equal(baseline.clusters.length, 1);

	const second = run(root, ["--update"]);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(readFileSync(baselineFile(root), "utf8"), first);

	const normal = run(root);
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /No new duplicate implementation instances/);
	assert.equal(readFileSync(baselineFile(root), "utf8"), first);
});

test("--update does not overwrite the baseline when the scan fails", (t) => {
	const root = fixture(t, {
		"packages/example/src/broken.ts": "export function broken(input: number) {\n",
	});
	const result = run(root, ["--update"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Duplicate scan failed:/);
	assert.equal(existsSync(baselineFile(root)), false);
});

test("unknown CLI options may fail without scanning", (t) => {
	const root = fixture(t, { "packages/example/src/a.ts": arrowSource("first") });
	const result = run(root, ["--bogus"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Usage:/);
	assert.equal(existsSync(baselineFile(root)), false);
});
