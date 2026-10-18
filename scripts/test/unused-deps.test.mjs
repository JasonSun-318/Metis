import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareUnusedDependencies, scanUnusedDependencies } from "../check-unused-deps.mjs";

const script = fileURLToPath(new URL("../check-unused-deps.mjs", import.meta.url));
const baselineFile = "scripts/baselines/unused-deps.json";

function packageDocument(name, fields = {}) {
	return { name, version: "1.0.0", private: true, ...fields };
}

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "metis-unused-deps-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (file, contents) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(
			join(root, file),
			typeof contents === "string" ? contents : `${JSON.stringify(contents, null, "\t")}\n`,
		);
	};
	for (const [file, contents] of Object.entries(files)) write(file, contents);
	return {
		root,
		write,
		read: (file) => readFileSync(join(root, file), "utf8"),
		scan: () => scanUnusedDependencies(root),
	};
}

function candidateKeys(result) {
	return result.snapshot.candidates.map((candidate) => candidateKey(candidate));
}

function candidateKey(candidate) {
	return `${candidate.manifest}:${candidate.section}:${candidate.package}`;
}

function retained(result, name) {
	return result.retained.find((entry) => entry.package === name);
}

function run(root, args = []) {
	return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

function rootWithWorkspaces(fields = {}) {
	return packageDocument("fixture", { workspaces: ["packages/*"], ...fields });
}

test("Node preload flags and cross-env retain their packages without counting script arguments", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces({
			devDependencies: {
				"cross-env": "1.0.0",
				tsx: "1.0.0",
				"source-map-support": "1.0.0",
				"custom-loader": "1.0.0",
				unused: "1.0.0",
			},
			scripts: {
				run: "cross-env MODE=test node --import tsx main.ts",
				debug: "node --require=source-map-support/register main.js",
				legacy: "node -rsource-map-support/register --loader custom-loader main.js",
				args: "node main.js --import unused",
			},
		}),
	});
	assert.deepEqual(candidateKeys(scan()), ["package.json:devDependencies:unused"]);
});

test("npm alias declarations require use of the installed alias name", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces({
			dependencies: { alias: "npm:target@1.0.0", usedAlias: "npm:target@1.0.0", target: "1.0.0" },
		}),
		"src/index.ts": 'import "target"; import "usedAlias/subpath";',
	});
	assert.deepEqual(candidateKeys(scan()), ["package.json:dependencies:alias"]);
});

test("incomplete scans do not claim baseline candidates have been resolved", (t) => {
	const { root, write } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { unused: "1.0.0" } }),
	});
	assert.equal(run(root, ["--update"]).status, 0);
	write("package.json", "{invalid");
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /Incremental comparison skipped/);
	assert.doesNotMatch(result.stdout, /no longer unused|No new or removed candidates/);
});

test("static, type-only, side-effect, dynamic, require, resolve and re-export imports are evidence", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces({
			dependencies: {
				alpha: "1.0.0",
				beta: "1.0.0",
				"side-effect": "1.0.0",
				reexported: "1.0.0",
				dynamic: "1.0.0",
				common: "1.0.0",
				resolved: "1.0.0",
				"meta-resolved": "1.0.0",
				unused: "1.0.0",
			},
		}),
		"src/index.ts": [
			'import alpha from "alpha";',
			'import type { Beta } from "beta";',
			'import "side-effect";',
			'export { thing } from "reexported";',
			'const dynamicValue = await import("dynamic");',
			'const commonValue = require("common");',
			'const resolvedValue = require.resolve("resolved");',
			'const metaValue = import.meta.resolve("meta-resolved");',
			"export { alpha, commonValue, dynamicValue, metaValue, resolvedValue };",
		].join("\n"),
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), ["package.json:dependencies:unused"]);
	assert.equal(result.snapshot.candidates.length, 1);
});

test("scoped packages, deep subpaths, package imports aliases and tsconfig path aliases normalize to the declaration", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			imports: { "#internal-tool": "aliased-dependency" },
			dependencies: {
				"@scope/used": "1.0.0",
				"@scope/unused": "1.0.0",
				"plain-pkg": "1.0.0",
				"plain-unused": "1.0.0",
				"aliased-dependency": "1.0.0",
				"path-mapped": "1.0.0",
			},
		}),
		"packages/app/tsconfig.json": {
			compilerOptions: { paths: { "~mapped": ["path-mapped"] } },
		},
		"packages/app/src/index.ts": [
			'import { used } from "@scope/used/deep/path";',
			'import { plain } from "plain-pkg/sub/path";',
			'import { aliased } from "#internal-tool";',
			'import { mapped } from "~mapped";',
			"export { aliased, mapped, plain, used };",
		].join("\n"),
	});
	assert.deepEqual(
		candidateKeys(scan()).sort(),
		[
			"packages/app/package.json:dependencies:@scope/unused",
			"packages/app/package.json:dependencies:plain-unused",
		].sort(),
	);
});

test("literal CLI bins, package config strings and config source imports retain dependencies", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			scripts: { build: "only-bin --output dist" },
			config: { extraTools: ["config-string-dep --watch"] },
			devDependencies: {
				"only-bin": "1.0.0",
				"config-dep": "1.0.0",
				"config-string-dep": "1.0.0",
				unused: "1.0.0",
			},
		}),
		"node_modules/only-bin/package.json": packageDocument("only-bin", { bin: { "only-bin": "./cli.js" } }),
		"packages/app/build.config.mjs": 'import "config-dep";\n',
		"packages/app/src/index.ts": "export const value = 1;\n",
	});
	assert.deepEqual(candidateKeys(scan()), ["packages/app/package.json:devDependencies:unused"]);
});

test("stable CLI bin forms, including npx/npm exec aliases and string bins, retain their packages", (t) => {
	const { root, scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			scripts: {
				types: "tsc --noEmit",
				npxTypes: "npx tsc --noEmit",
				execTypes: "npm exec -- tsc --noEmit",
				stringBin: "string-bin --check",
			},
			devDependencies: { typescript: "5.9.3", "string-bin": "1.0.0", unused: "1.0.0" },
		}),
		"node_modules/string-bin/package.json": packageDocument("string-bin", { bin: "./cli.js" }),
	});
	assert.deepEqual(candidateKeys(scan()), ["packages/app/package.json:devDependencies:unused"]);
	assert.equal(run(root).status, 0);
});

test("@types supplements, tsconfig types, peers and optional dependencies are retained separately from unused packages", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			dependencies: { thing: "1.0.0" },
			devDependencies: { "@types/thing": "1.0.0", "@types/node": "1.0.0", "@types/unused": "1.0.0" },
			peerDependencies: { "peer-tool": "1.0.0" },
			optionalDependencies: { "optional-tool": "1.0.0" },
		}),
		"packages/app/tsconfig.json": { compilerOptions: { types: ["node"] } },
		"packages/app/src/index.ts": 'import thing from "thing";\nexport { thing };\n',
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), ["packages/app/package.json:devDependencies:@types/unused"]);
	assert.match(retained(result, "peer-tool").reason, /peer dependency/);
	assert.match(retained(result, "optional-tool").reason, /optional dependency/);
});

test("JSX implicit runtime retains the configured runtime package without an explicit import", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			dependencies: { react: "19.0.0", "unused-ui": "1.0.0" },
		}),
		"packages/app/tsconfig.json": { compilerOptions: { jsx: "react-jsx" } },
		"packages/app/src/index.tsx": "export const view = <main>hello</main>;\n",
	});
	assert.deepEqual(candidateKeys(scan()), ["packages/app/package.json:dependencies:unused-ui"]);
});

test("vitest coverage configuration and --coverage scripts retain their provider packages", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/config/package.json": packageDocument("config-coverage", {
			devDependencies: {
				"@vitest/coverage-v8": "4.1.9",
				"@vitest/coverage-istanbul": "4.1.9",
				"unused-config": "1.0.0",
			},
		}),
		"packages/config/vitest.config.ts": 'export default { test: { coverage: { provider: "v8" } } };\n',
		"packages/script/package.json": packageDocument("script-coverage", {
			scripts: { coverage: "vitest --run --coverage" },
			devDependencies: { "@vitest/coverage-v8": "4.1.9", "unused-script": "1.0.0" },
		}),
	});
	assert.deepEqual(
		candidateKeys(scan()).sort(),
		[
			"packages/config/package.json:devDependencies:@vitest/coverage-istanbul",
			"packages/config/package.json:devDependencies:unused-config",
			"packages/script/package.json:devDependencies:unused-script",
		].sort(),
	);
});

test("webpack/config string references, JSON config references, tsconfig extends and vitest environment directives are evidence", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			devDependencies: {
				"css-loader": "7.1.4",
				"ts-loader": "9.6.2",
				jsdom: "29.1.1",
				"@tsconfig/node22": "22.0.0",
				"json-config-tool": "1.0.0",
				unused: "1.0.0",
			},
		}),
		"packages/app/webpack.config.ts":
			'export default { module: { rules: [{ use: ["css-loader", "ts-loader"] }] } };\n',
		"packages/app/tooling.config.json": { loader: "json-config-tool" },
		"packages/app/tsconfig.json": { extends: "@tsconfig/node22/tsconfig.json", compilerOptions: {} },
		"packages/app/test/example.test.ts": "// @vitest-environment jsdom\nexport {};\n",
	});
	assert.deepEqual(candidateKeys(scan()), ["packages/app/package.json:devDependencies:unused"]);
});

test("nested workspaces own their sources and siblings cannot mask each other's unused dependencies", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/a/package.json": packageDocument("a", {
			workspaces: ["nested/*"],
			dependencies: {
				shared: "1.0.0",
				"nested-only": "1.0.0",
				"parent-use": "1.0.0",
			},
		}),
		"packages/a/src/index.ts": 'import "parent-use";\n',
		"packages/a/nested/child/package.json": packageDocument("child", {
			dependencies: { shared: "1.0.0", "child-unused": "1.0.0" },
		}),
		"packages/a/nested/child/src/index.ts": 'import "shared";\nimport "nested-only";\n',
		"packages/b/package.json": packageDocument("b", { dependencies: { shared: "1.0.0" } }),
		"packages/b/src/index.ts": 'import "shared";\n',
	});
	assert.deepEqual(
		candidateKeys(scan()).sort(),
		[
			"packages/a/nested/child/package.json:dependencies:child-unused",
			"packages/a/package.json:dependencies:nested-only",
			"packages/a/package.json:dependencies:shared",
		].sort(),
	);
});

test("root development tools may be used by workspace scripts and configs, but not by sibling package sources", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces({
			devDependencies: {
				shx: "0.4.0",
				"root-config-tool": "1.0.0",
				"root-script-tool": "1.0.0",
				"root-source-tool": "1.0.0",
				"unused-root": "1.0.0",
			},
		}),
		"packages/app/package.json": packageDocument("app", { scripts: { clean: "shx rm -rf dist" } }),
		"packages/app/vitest.config.ts": 'import "root-config-tool";\nexport default {};\n',
		"packages/app/scripts/build.ts": 'import "root-script-tool";\n',
		"packages/other/package.json": packageDocument("other"),
		"packages/other/src/index.ts": 'import "root-source-tool";\n',
		"node_modules/shx/package.json": packageDocument("shx", { bin: { shx: "./cli.js" } }),
	});
	assert.deepEqual(
		candidateKeys(scan()).sort(),
		["package.json:devDependencies:root-source-tool", "package.json:devDependencies:unused-root"].sort(),
	);
});

test("optional, peer and platform-specific dependencies are retained with explicit reasons", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", {
			devDependencies: { "native-tool": "1.0.0", unused: "1.0.0" },
			peerDependencies: { "peer-tool": "1.0.0" },
			optionalDependencies: { "optional-tool": "1.0.0" },
		}),
		"node_modules/native-tool/package.json": packageDocument("native-tool", {
			os: ["darwin"],
			cpu: ["arm64"],
		}),
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), ["packages/app/package.json:devDependencies:unused"]);
	assert.match(retained(result, "native-tool").reason, /platform-specific/);
});

test("computed imports keep unreferenced dependencies as review candidates only within their owner", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/uncertain/package.json": packageDocument("uncertain", {
			dependencies: { mystery: "1.0.0", "static-used": "1.0.0", "newly-unused": "1.0.0" },
		}),
		"packages/uncertain/src/index.ts":
			'import "static-used";\nconst target = process.env.DEPENDENCY;\nawait import(target);\nawait import("./" + target);\n',
		"packages/definite/package.json": packageDocument("definite", {
			dependencies: { "definitely-unused": "1.0.0" },
		}),
	});
	const result = scan();
	assert.deepEqual(candidateKeys(result), [
		"packages/definite/package.json:dependencies:definitely-unused",
		"packages/uncertain/package.json:dependencies:mystery",
		"packages/uncertain/package.json:dependencies:newly-unused",
	]);
	assert.equal(result.uncertainties.length, 1);
	assert.match(result.uncertainties[0].file, /packages\/uncertain\/src\/index\.ts$/);
	for (const name of ["mystery", "newly-unused"]) {
		const candidate = result.candidates.find((entry) => entry.package === name);
		assert.equal(candidate.uncertain, true);
		assert.match(candidate.review, /unresolved computed module reference/);
	}
});

test("a newly added unused dependency is still reported next to a computed import", (t) => {
	const { root, read, write, scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", { dependencies: { used: "1.0.0" } }),
		"packages/app/src/index.ts": 'import "used";\nconst target = process.env.DEPENDENCY;\nawait import(target);\n',
	});
	const before = scan();
	assert.deepEqual(candidateKeys(before), []);
	write(
		"packages/app/package.json",
		packageDocument("app", { dependencies: { used: "1.0.0", "newly-unused": "1.0.0" } }),
	);
	const after = scan();
	assert.deepEqual(candidateKeys(after), ["packages/app/package.json:dependencies:newly-unused"]);
	assert.deepEqual(compareUnusedDependencies(after.snapshot, before.snapshot).added.map(candidateKey), [
		"packages/app/package.json:dependencies:newly-unused",
	]);
	assert.equal(after.candidates[0].uncertain, true);
	assert.equal(run(root, ["--update"]).status, 0);
	const baseline = JSON.parse(read(baselineFile));
	assert.deepEqual(baseline.candidates, after.snapshot.candidates);
	assert.equal("uncertain" in baseline.candidates[0], false);
	assert.equal("review" in baseline.candidates[0], false);
	const normal = run(root);
	assert.equal(normal.status, 0);
	assert.match(normal.stdout, /newly-unused.*needs review: unresolved computed module reference/);
	assert.match(normal.stdout, /Coverage limitation/);
});

test("docs, reports, generated output, build output and dependency declarations are not usage evidence", (t) => {
	const { scan } = fixture(t, {
		"package.json": rootWithWorkspaces({
			dependencies: {
				"doc-only": "1.0.0",
				"report-only": "1.0.0",
				"generated-only": "1.0.0",
				"dist-only": "1.0.0",
				"real-used": "1.0.0",
				unused: "1.0.0",
			},
		}),
		"docs/example.ts": 'import "doc-only";\n',
		"reports/run.ts": 'import "report-only";\n',
		"src/generated/example.ts": 'import "generated-only";\n',
		"src/models.generated.ts": 'import "generated-only";\n',
		"dist/example.js": 'import "dist-only";\n',
		"src/index.ts": 'import "real-used";\n',
	});
	assert.deepEqual(
		candidateKeys(scan()).sort(),
		[
			"package.json:dependencies:doc-only",
			"package.json:dependencies:dist-only",
			"package.json:dependencies:generated-only",
			"package.json:dependencies:report-only",
			"package.json:dependencies:unused",
		].sort(),
	);
});

test("snapshots are deterministic and comparison reports added and removed candidate identities", (t) => {
	const { root, write, scan } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { old: "1.0.0", current: "1.0.0" } }),
		"src/index.ts": 'import "old";\n',
	});
	assert.deepEqual(scan().snapshot, scan().snapshot);
	const before = scan();
	assert.deepEqual(candidateKeys(before), ["package.json:dependencies:current"]);
	write("src/index.ts", "export {};\n");
	const afterLoss = scan();
	assert.deepEqual(compareUnusedDependencies(afterLoss.snapshot, before.snapshot).added.map(candidateKey), [
		"package.json:dependencies:old",
	]);
	write("package.json", rootWithWorkspaces({ dependencies: { old: "1.0.0", current: "1.0.0", newly: "1.0.0" } }));
	const afterAddition = scan();
	assert.deepEqual(compareUnusedDependencies(afterAddition.snapshot, afterLoss.snapshot).added.map(candidateKey), [
		"package.json:dependencies:newly",
	]);
	assert.deepEqual(compareUnusedDependencies(before.snapshot, afterLoss.snapshot).removed.map(candidateKey), [
		"package.json:dependencies:old",
	]);
	assert.equal(run(root, ["--update"]).status, 0);
});

test("the CLI reports findings with exit 0, leaves manifests and baselines untouched, and is stable", (t) => {
	const { root, read } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { unused: "1.0.0" } }),
		[baselineFile]: { version: 1, candidates: [] },
	});
	const manifest = read("package.json");
	const baseline = read(baselineFile);
	const first = run(root);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /package\.json.*dependencies.*unused/);
	assert.match(first.stdout, /No files changed/);
	const second = run(root);
	assert.equal(second.status, 0, second.stderr);
	assert.equal(second.stdout, first.stdout);
	assert.equal(read("package.json"), manifest);
	assert.equal(read(baselineFile), baseline);
	assert.equal(existsSync(join(root, "package-lock.json")), false);
});

test("a missing baseline is a diagnostic, not a clean result, and is never created by a normal run", (t) => {
	const { root, read } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { unused: "1.0.0" } }),
	});
	const manifest = read("package.json");
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stderr, /baseline.*(?:missing|not found)/i);
	assert.equal(existsSync(join(root, baselineFile)), false);
	assert.equal(read("package.json"), manifest);
});

test("explicit --update writes a deterministic baseline and leaves package manifests alone", (t) => {
	const { root, read, scan } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { unused: "1.0.0", used: "1.0.0" } }),
		"src/index.ts": 'import "used";\n',
		"packages/nested/package.json": packageDocument("nested", {
			devDependencies: { "nested-unused": "1.0.0" },
		}),
	});
	const manifest = read("package.json");
	const update = run(root, ["--update"]);
	assert.equal(update.status, 0, update.stderr);
	const firstBaseline = read(baselineFile);
	assert.deepEqual(JSON.parse(firstBaseline).candidates, scan().snapshot.candidates);
	const secondUpdate = run(root, ["--update"]);
	assert.equal(secondUpdate.status, 0, secondUpdate.stderr);
	assert.equal(read(baselineFile), firstBaseline);
	assert.equal(read("package.json"), manifest);
});

test("scanner errors are visible and still exit 0 on normal runs, while --update refuses an incomplete baseline", (t) => {
	const { root, read } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/bad/package.json": "{ this is not json",
		"packages/good/package.json": packageDocument("good", { dependencies: { unused: "1.0.0" } }),
		[baselineFile]: { version: 1, candidates: [] },
	});
	const baseline = read(baselineFile);
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /incomplete/i);
	assert.match(result.stderr, /packages\/bad\/package\.json/);
	assert.match(result.stdout, /unused/);
	const update = run(root, ["--update"]);
	assert.notEqual(update.status, 0);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(read(baselineFile), baseline);
});

test("source syntax errors make the scan incomplete and block --update", (t) => {
	const { root, read, scan } = fixture(t, {
		"package.json": rootWithWorkspaces(),
		"packages/app/package.json": packageDocument("app", { dependencies: { unused: "1.0.0" } }),
		"packages/app/src/index.ts": "export const = ;\n",
		[baselineFile]: { version: 1, candidates: [] },
	});
	const baseline = read(baselineFile);
	const result = scan();
	assert.ok(result.diagnostics.some((diagnostic) => /Syntax error/.test(diagnostic.message)));
	const normal = run(root);
	assert.equal(normal.status, 0);
	assert.match(normal.stdout, /incomplete/i);
	assert.match(normal.stderr, /Syntax error/);
	const update = run(root, ["--update"]);
	assert.notEqual(update.status, 0);
	assert.match(update.stderr, /Refusing to update/);
	assert.equal(read(baselineFile), baseline);
});

test("unknown arguments fail without touching the baseline", (t) => {
	const { root, read } = fixture(t, {
		"package.json": rootWithWorkspaces({ dependencies: { unused: "1.0.0" } }),
		[baselineFile]: { version: 1, candidates: [] },
	});
	const baseline = read(baselineFile);
	const result = run(root, ["--unknown"]);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Usage:/);
	assert.equal(read(baselineFile), baseline);
});
