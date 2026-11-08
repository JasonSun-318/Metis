import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHECK_STEPS,
	cacheKeyFor,
	filterRelevantStatusLines,
	isLocalOnlyPath,
	parseConcurrency,
	statusPath,
} from "../run-checks.mjs";

test("the plan formats first and runs every check exactly once", () => {
	assert.equal(CHECK_STEPS[0].label, "format");
	const scripts = CHECK_STEPS.map((step) => step.script);
	assert.equal(new Set(scripts).size, scripts.length);
	for (const expected of [
		"check:format",
		"check:structure",
		"check:scripts",
		"check:types",
		"check:desktop",
		"check:generated",
		"check:shrinkwrap",
		"check:install-lock:coding-agent",
		"check:browser-smoke",
	]) {
		assert.ok(scripts.includes(expected), `${expected} missing`);
	}
});

test("concurrency is bounded and respects the environment override", () => {
	assert.equal(parseConcurrency(undefined, 10), 4);
	assert.equal(parseConcurrency(undefined, 4), 2);
	assert.equal(parseConcurrency(undefined, 64), 4);
	assert.equal(parseConcurrency("1", 10), 1);
	assert.equal(parseConcurrency("7", 10), 7);
	assert.equal(parseConcurrency("99", 10), 16);
	assert.equal(parseConcurrency("nope", 10), 4);
	assert.equal(parseConcurrency("0", 10), 4);
});

test("local-only material does not invalidate the cache", () => {
	for (const path of [
		"docs/review.md",
		"artifacts/wave/acceptance.md",
		"plans/next.md",
		".devin/notes.md",
		".codegraph/codegraph.db",
		".cache/checks/v1/a.json",
		"AGENTS.md",
		"packages/desktop/out/Metis/app",
		"node_modules/example/index.js",
		"debug.log",
	]) {
		assert.equal(isLocalOnlyPath(path), true, path);
	}
	for (const path of [
		"packages/agent/src/agent.ts",
		"packages/desktop/src/main/main.ts",
		"package.json",
		"scripts/check-fast.mjs",
	]) {
		assert.equal(isLocalOnlyPath(path), false, path);
	}
});

test("relevant tracked and untracked changes survive status filtering", () => {
	const lines = [
		" M packages/agent/src/agent.ts",
		"?? packages/agent/src/new.ts",
		"?? AGENTS.md",
		" M docs/review.md",
		"?? artifacts/w2/x.md",
		"?? .cache/checks/v1/x.json",
		" M package.json",
		"R  packages/old.ts -> packages/new.ts",
	];
	assert.deepEqual(filterRelevantStatusLines(lines), [
		" M packages/agent/src/agent.ts",
		"?? packages/agent/src/new.ts",
		" M package.json",
		"R  packages/old.ts -> packages/new.ts",
	]);
});

test("renamed status paths are taken from the destination", () => {
	assert.equal(statusPath("R  packages/old.ts -> packages/new.ts"), "packages/new.ts");
	assert.equal(statusPath('?? "packages/with space.ts"'), "packages/with space.ts");
});

test("cache keys cover the repository state, step and runtime", () => {
	const runtime = { node: "v22.23.2", platform: "darwin-arm64" };
	const base = cacheKeyFor("head+status", "structure", runtime);
	assert.equal(base, cacheKeyFor("head+status", "structure", runtime));
	assert.notEqual(base, cacheKeyFor("head+status2", "structure", runtime));
	assert.notEqual(base, cacheKeyFor("head+status", "types", runtime));
	assert.notEqual(base, cacheKeyFor("head+status", "structure", { node: "v24.0.0", platform: "darwin-arm64" }));
	assert.notEqual(base, cacheKeyFor("head+status", "structure", { node: "v22.23.2", platform: "linux-x64" }));
});
