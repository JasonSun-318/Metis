import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanDeadExports } from "../check-dead-exports.mjs";
import { publicApiSnapshot } from "../check-public-api.mjs";
import { runtimeCycleSnapshot } from "../check-runtime-cycles.mjs";
import { structurePrograms } from "../lib/source-program.mjs";

const script = fileURLToPath(new URL("../check-structure.mjs", import.meta.url));

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-structure-"));
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
				rewriteRelativeImportExtensions: true,
				noEmit: true,
				types: [],
				skipLibCheck: true,
			},
		}),
		"packages/example/package.json": JSON.stringify({
			name: "@fixture/example",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		}),
		"packages/example/src/index.ts": 'export { value } from "./value.ts";\nexport class PublicShape {}\n',
		"packages/example/src/value.ts": "export const value = 1;\n",
		"packages/example/src/extra.ts": "export class UnusedExport {}\n",
	};
	const write = (file, contents) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), typeof contents === "string" ? contents : JSON.stringify(contents));
	};
	for (const [file, contents] of Object.entries({ ...defaults, ...files })) write(file, contents);
	return {
		root,
		write,
		run: (args = []) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" }),
	};
}

test("the shared structure context produces the same snapshots as the standalone checkers", (t) => {
	const { root } = fixture(t);
	const context = structurePrograms(root);

	assert.deepEqual(runtimeCycleSnapshot(root, context), runtimeCycleSnapshot(root));
	assert.deepEqual(publicApiSnapshot(root, context), publicApiSnapshot(root));

	const standalone = scanDeadExports(root);
	const shared = scanDeadExports(root, context);
	// Candidate objects carry AST declarations, so compare their stable identity
	// and the persisted snapshot rather than deep-equal object graphs.
	assert.deepEqual(shared.snapshot, standalone.snapshot);
	const identities = (result) =>
		result.candidates.map((candidate) => `${candidate.file}:${candidate.export}:${candidate.category}`).sort();
	assert.deepEqual(identities(shared), identities(standalone));
	assert.deepEqual(shared.counts, standalone.counts);
});

test("the CLI updates every structural baseline and passes on a clean fixture", (t) => {
	const { run } = fixture(t);
	const update = run(["--update"]);
	assert.equal(update.status, 0, update.stderr);
	assert.match(update.stdout, /Updated runtime-cycle baseline/);
	assert.match(update.stdout, /Updated public API surface baseline/);
	assert.match(update.stdout, /Updated advisory dead export baseline/);

	const check = run();
	assert.equal(check.status, 0, check.stderr);
	assert.match(check.stdout, /Runtime cycle check passed/);
	assert.match(check.stdout, /Public API surface check passed/);
	assert.match(check.stdout, /Dead export report:/);
});

test("dead export changes stay advisory while new runtime cycles fail the gate", (t) => {
	const { write, run } = fixture(t);
	assert.equal(run(["--update"]).status, 0);

	write("packages/example/src/another-unused.ts", "export class AnotherUnused {}\n");
	const advisory = run();
	assert.equal(advisory.status, 0, advisory.stderr);
	assert.match(advisory.stdout, /New candidate: .*AnotherUnused/);

	write("packages/example/src/cycle-a.ts", 'import { cycleB } from "./cycle-b.ts";\nexport const cycleA = cycleB;\n');
	write("packages/example/src/cycle-b.ts", 'import { cycleA } from "./cycle-a.ts";\nexport const cycleB = cycleA;\n');
	const hard = run();
	assert.equal(hard.status, 1, hard.stderr);
	assert.match(hard.stderr, /New runtime cycle edges/);
});
