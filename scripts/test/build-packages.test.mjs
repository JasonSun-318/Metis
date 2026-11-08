import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILD_TASKS, buildTiers } from "../build-packages.mjs";

test("build tiers respect every declared dependency", () => {
	const tiers = buildTiers();
	assert.equal(tiers.length, 4);
	assert.deepEqual([...tiers[0]].sort(), ["@metis/ai", "@metis/app-protocol", "@metis/tui"]);
	assert.deepEqual(tiers[1], ["@metis/agent-core"]);
	assert.deepEqual(tiers[2], ["@metis/coding-agent"]);
	assert.deepEqual(tiers[3], ["@metis/app-server"]);

	const seen = new Set();
	for (const tier of tiers) {
		for (const name of tier) {
			const task = BUILD_TASKS.find((candidate) => candidate.name === name);
			assert.ok(task, name);
			for (const dependency of task.dependencies) {
				assert.ok(seen.has(dependency), `${name} started before ${dependency}`);
			}
			seen.add(name);
		}
	}
	assert.equal(seen.size, BUILD_TASKS.length);
});

test("the build plan rejects cycles and unknown dependencies", () => {
	assert.throws(
		() =>
			buildTiers([
				{ name: "a", dependencies: ["b"] },
				{ name: "b", dependencies: ["a"] },
			]),
		/cycle or missing dependency/,
	);
	assert.throws(() => buildTiers([{ name: "a", dependencies: ["missing"] }]), /cycle or missing dependency/);
});
