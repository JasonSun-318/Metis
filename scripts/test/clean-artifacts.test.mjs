import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ARTIFACT_TARGETS, artifactTargets, CACHE_TARGETS, directorySize, formatBytes } from "../clean-artifacts.mjs";

test("artifact targets are unique and caches are opt-in", () => {
	const paths = artifactTargets().map((target) => target.path);
	assert.equal(new Set(paths).size, paths.length);
	assert.deepEqual(
		paths,
		ARTIFACT_TARGETS.map((target) => target.path),
	);
	assert.equal(
		paths.some((path) => CACHE_TARGETS.some((target) => target.path === path)),
		false,
	);
	const withCache = artifactTargets({ includeCache: true }).map((target) => target.path);
	assert.ok(withCache.includes(".cache/checks"));
	assert.ok(withCache.includes("node_modules/.cache/metis-desktop"));
});

test("directory sizes sum nested files and tolerate missing paths", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "metis-clean-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	assert.equal(directorySize(join(directory, "missing")), 0);
	mkdirSync(join(directory, "a", "b"), { recursive: true });
	writeFileSync(join(directory, "a", "x.txt"), "12345");
	writeFileSync(join(directory, "a", "b", "y.txt"), "1234567890");
	assert.equal(directorySize(directory), 15);
});

test("byte formatting keeps reporting compact", () => {
	assert.equal(formatBytes(512), "512 B");
	assert.equal(formatBytes(1536), "1.5 KiB");
	assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MiB");
	assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GiB");
});
