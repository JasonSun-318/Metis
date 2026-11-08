import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPlan, isCheckRelevant } from "../check-fast.mjs";

const labels = (staged) => buildPlan(staged).map((step) => step.label);
const hasStep = (staged, label) => labels(staged).some((value) => value === label || value.startsWith(`${label} `));

const ALWAYS_STEPS = [
	"check:pinned-deps",
	"check:boundaries",
	"check:ts-imports",
	"check:shrinkwrap",
	"check:install-lock:coding-agent",
	"check:generated",
];

test("documentation, workflow and changelog edits are not check-relevant", () => {
	for (const file of [
		"README.md",
		"docs/review.md",
		"packages/desktop/README.md",
		"packages/desktop/changelog.darwin.json",
		".github/workflows/desktop.yml",
	]) {
		assert.equal(isCheckRelevant(file), false, file);
	}
});

test("source, test, e2e, script, example and manifest edits are check-relevant", () => {
	for (const file of [
		"packages/agent/src/agent.ts",
		"packages/desktop/src/renderer/App.tsx",
		"packages/desktop/test/security.test.ts",
		"packages/app-server/e2e/flow.spec.ts",
		"scripts/check-fast.mjs",
		"scripts/test/check-fast.test.mjs",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
		"packages/ai/package.json",
		"packages/coding-agent/npm-shrinkwrap.json",
		"packages/coding-agent/install-lock/package-lock.json",
		"packages/coding-agent/examples/sdk/example.ts",
	]) {
		assert.equal(isCheckRelevant(file), true, file);
	}
});

test("every plan keeps the cheap whole-repository checks", () => {
	const plan = labels(["packages/app-server/src/app-server.ts"]);
	for (const step of ALWAYS_STEPS) assert.ok(plan.includes(step), `${step} missing`);
});

test("an agent source change runs types and the browser smoke check only", () => {
	const staged = ["packages/agent/src/agent.ts"];
	assert.ok(hasStep(staged, "biome"));
	assert.ok(hasStep(staged, "check:types"));
	assert.ok(hasStep(staged, "check:browser-smoke"));
	assert.equal(hasStep(staged, "check:desktop"), false);
	assert.equal(hasStep(staged, "check:scripts"), false);
});

test("a desktop change runs the desktop type check but not the browser smoke check", () => {
	const staged = ["packages/desktop/src/main/main.ts"];
	assert.ok(hasStep(staged, "check:desktop"));
	assert.equal(hasStep(staged, "check:browser-smoke"), false);
});

test("an app-protocol change invalidates the desktop type check", () => {
	assert.ok(hasStep(["packages/app-protocol/src/methods.ts"], "check:desktop"));
});

test("checker source changes run the checker regressions, baseline refreshes do not", () => {
	assert.ok(hasStep(["scripts/check-fast.mjs"], "check:scripts"));
	assert.ok(hasStep(["scripts/test/check-fast.test.mjs"], "check:scripts"));
	assert.equal(hasStep(["scripts/baselines/public-api.json"], "check:scripts"), false);
});

test("root manifest changes run types, desktop types and the browser smoke check", () => {
	const staged = ["package.json"];
	for (const step of ["check:types", "check:desktop", "check:browser-smoke"]) {
		assert.ok(hasStep(staged, step), step);
	}
});

test("generated catalogs are not passed to biome but still trigger type checking", () => {
	const staged = ["packages/ai/src/models.generated.ts"];
	assert.equal(hasStep(staged, "biome"), false);
	assert.ok(hasStep(staged, "check:types"));
});

test("the plan only rewrites staged files Biome owns", () => {
	const biomeStep = buildPlan(["packages/agent/src/agent.ts", "README.md"]).find((step) =>
		step.label.startsWith("biome"),
	);
	assert.ok(biomeStep);
	assert.deepEqual(biomeStep.commandArgs.slice(0, 3), ["check", "--write", "--error-on-warnings"]);
	assert.deepEqual(biomeStep.commandArgs.slice(3), ["packages/agent/src/agent.ts"]);
});
