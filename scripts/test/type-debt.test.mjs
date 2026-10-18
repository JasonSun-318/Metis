import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanTypeDebt, typeDebtChanges, validateTypeDebtBaseline } from "../check-type-debt.mjs";

const script = fileURLToPath(new URL("../check-type-debt.mjs", import.meta.url));
const baselineFile = "scripts/baselines/type-debt.json";

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-type-debt-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (file, contents) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	};
	for (const [file, contents] of Object.entries(files)) write(file, contents);
	return {
		root,
		write,
		read: (file) => readFileSync(join(root, file), "utf8"),
		exists: (file) => existsSync(join(root, file)),
		scan: (options) => scanTypeDebt(root, options),
		run: (args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" }),
	};
}

function countOf(result, file, category) {
	return result.counts.find((count) => count.file === file && count.category === category)?.count ?? 0;
}

function baseline(counts) {
	return { version: 1, counts };
}

test("AST nodes are counted without reading strings, templates, regexes or prose as code", (t) => {
	const { scan, run } = fixture(t, {
		"packages/example/src/asts.ts": [
			'const text = "any as any ! // biome-ignore lint/suspicious/noExplicitAny: string";',
			"const template = `any as any ! // biome-ignore-all lint/suspicious/noExplicitAny: template`;",
			"const regex = /any|as any|!|\\/\\/ biome-ignore lint\\/suspicious\\/noExplicitAny/;",
			"// biome-ignore is not a directive and mentions lint/suspicious/noExplicitAny in prose.",
			"declare const value: unknown;",
			"export const assertion = value as any;",
			"export const angle = <any>value;",
			"export const nonNull = value!;",
			"export const view = { text, template, regex };",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(countOf(result, "packages/example/src/asts.ts", "explicit-any"), 2);
	assert.equal(countOf(result, "packages/example/src/asts.ts", "as-any"), 2);
	assert.equal(countOf(result, "packages/example/src/asts.ts", "non-null-assertion"), 1);
	assert.equal(
		result.counts.some((count) => count.category.startsWith("suppression:")),
		false,
	);
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Explicit-any counts every any type node, including the any in as-any/);
});

test("real comment trivia counts ignore, ignore-all and ignore-start but not ignore-end", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/suppressions.ts": [
			"// biome-ignore lint/suspicious/noExplicitAny: line comment",
			"/* biome-ignore-all lint/style/noNonNullAssertion: block comment */",
			"/*",
			" * biome-ignore-start format: multiline block comment",
			" * biome-ignore-end format: closing directive is not another suppression",
			" */",
			"export const value = 1;",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(
		countOf(result, "packages/example/src/suppressions.ts", "suppression:lint/suspicious/noExplicitAny"),
		1,
	);
	assert.equal(
		countOf(result, "packages/example/src/suppressions.ts", "suppression:lint/style/noNonNullAssertion"),
		1,
	);
	assert.equal(countOf(result, "packages/example/src/suppressions.ts", "suppression:format"), 1);
	assert.equal(result.counts.filter((count) => count.category.startsWith("suppression:")).length, 3);
});

test("JSX text, raw template text and regex literals stay out while JSX comments count", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/view.tsx": [
			'const text = "// biome-ignore lint/suspicious/noExplicitAny: string";',
			"const template = `// biome-ignore lint/suspicious/noExplicitAny: raw template`;",
			"const regex = /\\/\\/ biome-ignore lint\\/suspicious\\/noExplicitAny/;",
			"declare const value: unknown;",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture template literal syntax
			"export const interpolated = `${value as any}`;",
			"export const view = (",
			"  <div>",
			"    // biome-ignore lint/suspicious/noExplicitAny: JSX text",
			"    {/* biome-ignore lint/correctness/useExhaustiveDependencies(dep): real JSX comment */}",
			"    {value as any}",
			"    {text}{template}{regex}{interpolated}",
			"  </div>",
			");",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(countOf(result, "packages/example/src/view.tsx", "explicit-any"), 2);
	assert.equal(countOf(result, "packages/example/src/view.tsx", "as-any"), 2);
	assert.equal(
		countOf(result, "packages/example/src/view.tsx", "suppression:lint/correctness/useExhaustiveDependencies"),
		1,
	);
	assert.equal(
		result.counts.some((count) => count.category.includes("noExplicitAny")),
		false,
	);
});

test("real comments immediately before raw literal tokens are not dropped", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/literals.ts": [
			"const text =",
			"  // biome-ignore lint/suspicious/noExplicitAny: before string",
			'  "// biome-ignore lint/suspicious/noExplicitAny: fake string";',
			"const template =",
			"  // biome-ignore-start lint/style/noNonNullAssertion: before template",
			"  `// biome-ignore lint/suspicious/noExplicitAny: fake template`;",
			"const regex =",
			"  // biome-ignore lint/correctness/useExhaustiveDependencies(dep): before regex",
			"  /\\/\\/ biome-ignore lint\\/suspicious\\/noExplicitAny/;",
			"export const view = { text, template, regex };",
		].join("\n"),
		"packages/example/src/literals.tsx": [
			"export const view = (",
			"  <div>",
			'    {/* biome-ignore lint/suspicious/noArrayIndexKey: before JSX string */ "// biome-ignore lint/suspicious/noExplicitAny: fake JSX string"}',
			"  </div>",
			");",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	const ts = "packages/example/src/literals.ts";
	assert.equal(countOf(result, ts, "suppression:lint/suspicious/noExplicitAny"), 1);
	assert.equal(countOf(result, ts, "suppression:lint/style/noNonNullAssertion"), 1);
	assert.equal(countOf(result, ts, "suppression:lint/correctness/useExhaustiveDependencies"), 1);
	assert.equal(countOf(result, "packages/example/src/literals.tsx", "suppression:lint/suspicious/noArrayIndexKey"), 1);
	assert.equal(
		result.counts
			.filter((count) => count.category === "suppression:lint/suspicious/noExplicitAny")
			.reduce((sum, count) => sum + count.count, 0),
		1,
	);
});

test("one directive can suppress multiple Biome categories", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/multi.ts": [
			"// biome-ignore lint/suspicious/noExplicitAny, lint/style/noNonNullAssertion: comma separated",
			"// biome-ignore-all lint/a11y/noStaticElementInteractions lint/suspicious/noArrayIndexKey: whitespace separated",
			"// biome-ignore-start lint/correctness/useExhaustiveDependencies(dep), format: args and format",
			"export const value = 1;",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	const file = "packages/example/src/multi.ts";
	for (const rule of [
		"suppression:lint/suspicious/noExplicitAny",
		"suppression:lint/style/noNonNullAssertion",
		"suppression:lint/a11y/noStaticElementInteractions",
		"suppression:lint/suspicious/noArrayIndexKey",
		"suppression:lint/correctness/useExhaustiveDependencies",
		"suppression:format",
	]) {
		assert.equal(countOf(result, file, rule), 1, rule);
	}
	assert.equal(result.counts.filter((count) => count.file === file).length, 6);
});

test("non-null assertions are counted from AST syntax only", (t) => {
	const { scan } = fixture(t, {
		"packages/example/src/non-null.ts": [
			'const text = "!";',
			"const template = `!`;",
			"const regex = /!/;",
			"declare const value: string | undefined;",
			"export const fallback = value!;",
			"export const view = { text, template, regex };",
		].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(countOf(result, "packages/example/src/non-null.ts", "non-null-assertion"), 1);
});

test("line shifts keep identities stable and per-file deltas never offset each other", (t) => {
	const a = "packages/example/src/a.ts";
	const b = "packages/example/src/b.ts";
	const sourceA = "declare const value: unknown;\nexport const a = value as any;\n";
	const sourceB = "declare const value: unknown;\nexport const b = value as any;\n";
	const { write, read, run } = fixture(t, { [a]: sourceA, [b]: sourceB });
	const update = run(["--update"]);
	assert.equal(update.status, 0, update.stderr);
	const originalBaseline = read(baselineFile);
	assert.match(originalBaseline, /"category": "as-any"/);

	write(a, `// shifted down\n\n${sourceA}`);
	const shifted = run();
	assert.equal(shifted.status, 0, shifted.stderr);
	assert.match(shifted.stdout, /No new or removed per-file category counts/);
	assert.equal(read(baselineFile), originalBaseline);

	write(a, "declare const value: unknown;\nexport const a = value as any;\nexport const again = value as any;\n");
	write(b, "export const b = 1;\n");
	const changed = run();
	assert.equal(changed.status, 0, changed.stderr);
	assert.match(changed.stdout, /Added: packages\/example\/src\/a\.ts \[as-any\] \+1 \(baseline 1 -> 2\)/);
	assert.match(changed.stdout, /Removed: packages\/example\/src\/b\.ts \[as-any\] -1 \(baseline 1 -> 0\)/);
});

test("declarations, generated files, fixtures and tests are excluded while all source extensions are scanned", (t) => {
	const any = "declare const value: unknown;\nexport const a = value as any;\n";
	const { scan } = fixture(t, {
		"packages/example/src/included.ts": any,
		"packages/example/src/declarations.d.ts": "export declare const value: any;\n",
		"packages/example/src/api.generated.ts": any,
		"packages/example/src/marked.ts": `// @generated\n${any}`,
		"packages/example/src/__fixtures__/fixture.ts": any,
		"packages/example/src/foo.test.ts": any,
		"packages/example/src/generated/inside.ts": any,
		"packages/example/src/node_modules/inside.ts": any,
		"packages/example/src/notes.txt": any,
		"packages/other/src/a.mts": any,
		"packages/other/src/b.cts": any,
		"packages/other/src/view.tsx": "declare const value: unknown;\nexport const view = <div>{value as any}</div>;\n",
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(result.filesScanned, 4);
	assert.equal(
		result.counts.filter((count) => count.category === "explicit-any").reduce((sum, count) => sum + count.count, 0),
		4,
	);
	assert.equal(
		result.counts.filter((count) => count.category === "as-any").reduce((sum, count) => sum + count.count, 0),
		4,
	);
});

test("packages without a src directory are optional", (t) => {
	const { scan } = fixture(t, {
		"packages/with-src/src/a.ts": "declare const value: unknown;\nexport const a = value as any;\n",
		"packages/no-src/package.json": "{}\n",
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(result.filesScanned, 1);
	assert.equal(countOf(result, "packages/with-src/src/a.ts", "explicit-any"), 1);
});

test("unreadable package source paths are incomplete instead of skipped", (t) => {
	if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
		t.skip("requires non-root POSIX permissions");
		return;
	}
	const { root, scan } = fixture(t, {
		"packages/locked/src/a.ts": "declare const value: unknown;\nexport const a = value as any;\n",
		"packages/open/src/b.ts": "export const b = 1;\n",
	});
	const locked = join(root, "packages", "locked");
	chmodSync(locked, 0o000);
	let result;
	try {
		result = scan();
	} finally {
		chmodSync(locked, 0o755);
	}
	assert.equal(result.incomplete, true);
	assert.match(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /packages\/locked\/src/);
});

test("parse and read errors stay advisory, prevent updates and preserve files", (t) => {
	const broken = "packages/example/src/broken.ts";
	const { root, scan, run, read, exists } = fixture(t, {
		[broken]: "export const broken = ;\n",
		"packages/example/src/any.ts": "declare const value: unknown;\nexport const x = value as any;\n",
	});
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete: 1 error/);
	assert.match(normal.stdout, /no conclusion about new debt was reached/);
	assert.equal(normal.stdout.includes("No type debt was counted"), false);
	assert.equal(exists(baselineFile), false);
	const update = run(["--update"]);
	assert.equal(update.status, 1);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(exists(baselineFile), false);
	assert.equal(read(broken), "export const broken = ;\n");

	const readFailure = scan({
		readFile(file, encoding) {
			if (file.endsWith("any.ts")) throw new Error("simulated read failure");
			return readFileSync(file, encoding);
		},
	});
	assert.equal(readFailure.incomplete, true);
	assert.match(
		readFailure.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
		/Cannot read source file packages\/example\/src\/any\.ts: simulated read failure/,
	);

	const missingRoot = scanTypeDebt(join(root, "missing"));
	assert.equal(missingRoot.incomplete, true);
	assert.match(missingRoot.diagnostics[0].message, /Cannot read packages directory/);
});

test("missing packages and wrong roots are incomplete and cannot erase a baseline", (t) => {
	const { root, write, read, run } = fixture(t, {
		"packages/example/src/a.ts": "declare const value: unknown;\nexport const a = value as any;\n",
	});
	write(
		baselineFile,
		JSON.stringify(baseline([{ file: "packages/example/src/a.ts", category: "explicit-any", count: 1 }])),
	);
	const original = read(baselineFile);
	rmSync(join(root, "packages"), { recursive: true, force: true });

	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /Scan incomplete/);
	assert.match(normal.stdout, /no conclusion about new debt was reached/);
	assert.equal(normal.stdout.includes("No type debt was counted"), false);
	assert.equal(read(baselineFile), original);

	const update = run(["--update"]);
	assert.equal(update.status, 1);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(read(baselineFile), original);

	const wrongRoot = spawnSync(
		process.execPath,
		[script, "--root", join(root, "missing-root"), "--baseline", join(root, baselineFile), "--update"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(wrongRoot.status, 1);
	assert.match(wrongRoot.stderr, /Refusing to update/);
	assert.equal(read(baselineFile), original);
});

test("missing and malformed baselines are advisory and validation is strict", (t) => {
	const { write, read, exists, run } = fixture(t, {
		"packages/example/src/a.ts": "declare const value: unknown;\nexport const a = value as any;\n",
	});
	const missing = run();
	assert.equal(missing.status, 0, missing.stderr);
	assert.match(missing.stderr, /is missing/);
	assert.match(missing.stdout, /no conclusion about new debt was reached/);
	assert.equal(exists(baselineFile), false);

	write(baselineFile, "{invalid");
	const malformed = run();
	assert.equal(malformed.status, 0, malformed.stderr);
	assert.match(malformed.stderr, /not valid JSON/);
	assert.equal(read(baselineFile), "{invalid");

	write(baselineFile, JSON.stringify(baseline([{ file: "../escape.ts", category: "explicit-any", count: 1 }])));
	const unsafe = run();
	assert.equal(unsafe.status, 0, unsafe.stderr);
	assert.match(unsafe.stderr, /unsafe or non-relative file path/);

	assert.match(validateTypeDebtBaseline({ version: 2, counts: [] }), /unsupported baseline version/);
	assert.match(validateTypeDebtBaseline({ version: 1, counts: {} }), /counts must be an array/);
	assert.match(
		validateTypeDebtBaseline(baseline([{ file: "/absolute.ts", category: "explicit-any", count: 1 }])),
		/unsafe or non-relative file path/,
	);
	assert.match(
		validateTypeDebtBaseline(
			baseline([{ file: "packages/a/src/a.ts", category: "suppression:not-a-rule", count: 1 }]),
		),
		/invalid category/,
	);
	assert.match(
		validateTypeDebtBaseline(baseline([{ file: "packages/a/src/a.ts", category: "explicit-any", count: -1 }])),
		/finite non-negative integer/,
	);
	assert.match(
		validateTypeDebtBaseline(baseline([{ file: "packages/a/src/a.ts", category: "explicit-any", count: 1.5 }])),
		/finite non-negative integer/,
	);
	assert.match(
		validateTypeDebtBaseline(
			baseline([
				{ file: "packages/a/src/a.ts", category: "explicit-any", count: 1 },
				{ file: "packages/a/src/a.ts", category: "explicit-any", count: 2 },
			]),
		),
		/duplicate file\/category key/,
	);
	assert.equal(
		validateTypeDebtBaseline(baseline([{ file: "packages/a/src/a.ts", category: "suppression:format", count: 0 }])),
		undefined,
	);
});

test("comparison reports additions and removals per file and category", () => {
	const changes = typeDebtChanges(
		baseline([
			{ file: "packages/a/src/a.ts", category: "explicit-any", count: 2 },
			{ file: "packages/a/src/a.ts", category: "non-null-assertion", count: 1 },
		]),
		baseline([
			{ file: "packages/a/src/a.ts", category: "explicit-any", count: 1 },
			{ file: "packages/a/src/b.ts", category: "explicit-any", count: 1 },
		]),
	);
	assert.deepEqual(
		changes.added.map((change) => [change.file, change.category, change.delta, change.previous, change.count]),
		[
			["packages/a/src/a.ts", "explicit-any", 1, 1, 2],
			["packages/a/src/a.ts", "non-null-assertion", 1, 0, 1],
		],
	);
	assert.deepEqual(
		changes.removed.map((change) => [change.file, change.category, change.delta, change.previous, change.count]),
		[["packages/a/src/b.ts", "explicit-any", 1, 1, 0]],
	);
});

test("default reports summarize totals without replaying every per-file count", (t) => {
	const { run } = fixture(t, {
		"packages/example/src/a.ts": [
			"// biome-ignore lint/suspicious/noExplicitAny: total",
			"declare const value: unknown;",
			"export const a = value as any;",
		].join("\n"),
		"packages/example/src/b.ts": "declare const value: string;\nexport const b = value!;\n",
	});
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(
		normal.stdout,
		/Totals: explicit-any 1 \(includes as-any 1\); as-any 1; non-null-assertion 1; Biome suppressions 1 across 1 rule\(s\) in 2 file\(s\)\./,
	);
	assert.match(normal.stdout, /Suppression totals by rule\/category:/);
	assert.match(normal.stdout, / {2}lint\/suspicious\/noExplicitAny: 1/);
	assert.equal(normal.stdout.includes("Counts by file and category:"), false);
	assert.equal(normal.stdout.includes("packages/example/src/a.ts"), false);
	assert.equal(normal.stdout.includes("packages/example/src/b.ts"), false);
});

test("parentheses around any do not hide assertions", (t) => {
	const file = "packages/example/src/assertions.ts";
	const { scan } = fixture(t, {
		[file]: "declare const value: unknown;\nexport const a = value as (any);\nexport const b = <(any)>value;\n",
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(countOf(result, file, "explicit-any"), 2);
	assert.equal(countOf(result, file, "as-any"), 2);
});

test("generated-looking text inside literals does not exclude production code", (t) => {
	const file = "packages/example/src/example.ts";
	const { scan } = fixture(t, {
		[file]: ["const example = `", "// @generated", "`;", "export const value: any = example;"].join("\n"),
	});
	const result = scan();
	assert.equal(result.incomplete, false);
	assert.equal(result.filesScanned, 1);
	assert.equal(countOf(result, file, "explicit-any"), 1);
});

test("normal reports never write and updates are deterministic after a complete scan", (t) => {
	const source = "packages/example/src/a.ts";
	const contents = "declare const value: unknown;\nexport const a = value as any;\n";
	const { read, exists, run } = fixture(t, { [source]: contents });
	const normal = run();
	assert.equal(normal.status, 0, normal.stderr);
	assert.equal(exists(baselineFile), false);
	assert.equal(read(source), contents);

	const update = run(["--update"]);
	assert.equal(update.status, 0, update.stderr);
	assert.equal(exists(baselineFile), true);
	assert.equal(read(source), contents);
	const first = read(baselineFile);
	assert.equal(validateTypeDebtBaseline(JSON.parse(first)), undefined);
	assert.equal(first.endsWith("\n"), true);

	const secondNormal = run();
	assert.equal(secondNormal.status, 0, secondNormal.stderr);
	assert.match(secondNormal.stdout, /No new or removed per-file category counts/);
	assert.equal(read(baselineFile), first);
	assert.equal(read(source), contents);

	const secondUpdate = run(["--update"]);
	assert.equal(secondUpdate.status, 0, secondUpdate.stderr);
	assert.equal(read(baselineFile), first);
	assert.equal(read(source), contents);
});

test("CLI supports --root and --baseline without touching the default baseline", (t) => {
	const source = "packages/example/src/a.ts";
	const contents = "declare const value: unknown;\nexport const a = value as any;\n";
	const { root, read, exists } = fixture(t, { [source]: contents });
	const outside = mkdtempSync(join(tmpdir(), "metis-type-debt-cwd-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	const baselinePath = "reports/type-debt.json";
	const update = spawnSync(process.execPath, [script, "--root", root, "--baseline", baselinePath, "--update"], {
		cwd: outside,
		encoding: "utf8",
	});
	assert.equal(update.status, 0, update.stderr);
	assert.equal(exists(baselinePath), true);
	assert.equal(exists(baselineFile), false);
	const normal = spawnSync(process.execPath, [script, "--root", root, "--baseline", baselinePath], {
		cwd: outside,
		encoding: "utf8",
	});
	assert.equal(normal.status, 0, normal.stderr);
	assert.match(normal.stdout, /No new or removed per-file category counts/);
	assert.equal(read(source), contents);
	const usage = spawnSync(process.execPath, [script, "--root"], { cwd: outside, encoding: "utf8" });
	assert.equal(usage.status, 2);
	assert.match(usage.stderr, /--root requires a path/);
});
