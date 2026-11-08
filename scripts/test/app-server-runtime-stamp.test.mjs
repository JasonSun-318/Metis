import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	readRuntimeStamp,
	runtimeInputFiles,
	runtimeInputFingerprint,
	runtimeStampPath,
	stampMatches,
	writeRuntimeStamp,
} from "../../packages/desktop/scripts/app-server-runtime-stamp.mjs";

function fixture(t) {
	const repoRoot = mkdtempSync(join(tmpdir(), "metis-runtime-stamp-"));
	t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
	const packageDirectory = join(repoRoot, "packages", "example");
	const write = (file, contents) => {
		mkdirSync(dirname(join(repoRoot, file)), { recursive: true });
		writeFileSync(join(repoRoot, file), contents);
	};
	write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", type: "module" }));
	write("packages/example/tsconfig.json", JSON.stringify({ compilerOptions: { noEmit: true } }));
	write("packages/example/src/index.ts", "export const value = 1;\n");
	write("packages/example/unrelated.txt", "not a build input\n");
	const extraFiles = [join(repoRoot, "tsconfig.base.json"), join(repoRoot, "package-lock.json")];
	write("tsconfig.base.json", JSON.stringify({ compilerOptions: {} }));
	write("package-lock.json", JSON.stringify({ lockfileVersion: 3 }));
	return {
		repoRoot,
		packageDirectory,
		write,
		extraFiles,
		fingerprint: () =>
			runtimeInputFingerprint({
				repoRoot,
				packageDirectories: [packageDirectory],
				extraFiles,
			}),
	};
}

test("the fingerprint covers package sources, manifests, tsconfigs and extra inputs", async (t) => {
	const { repoRoot, packageDirectory, extraFiles } = fixture(t);
	const files = await runtimeInputFiles({ packageDirectories: [packageDirectory], extraFiles });
	assert.deepEqual(files.map((file) => file.slice(repoRoot.length + 1)).sort(), [
		"package-lock.json",
		"packages/example/package.json",
		"packages/example/src/index.ts",
		"packages/example/tsconfig.json",
		"tsconfig.base.json",
	]);
});

test("source, manifest and extra-input changes invalidate the fingerprint", async (t) => {
	const { write, fingerprint } = fixture(t);
	const baseline = await fingerprint();
	assert.equal((await fingerprint()).fingerprint, baseline.fingerprint);

	write("packages/example/src/index.ts", "export const value = 2;\n");
	const sourceChanged = await fingerprint();
	assert.notEqual(sourceChanged.fingerprint, baseline.fingerprint);

	write("packages/example/package.json", JSON.stringify({ name: "@fixture/example", version: "1.0.1" }));
	const manifestChanged = await fingerprint();
	assert.notEqual(manifestChanged.fingerprint, sourceChanged.fingerprint);

	write("tsconfig.base.json", JSON.stringify({ compilerOptions: { strict: true } }));
	const extraChanged = await fingerprint();
	assert.notEqual(extraChanged.fingerprint, manifestChanged.fingerprint);
});

test("unrelated files are not build inputs", async (t) => {
	const { write, fingerprint } = fixture(t);
	const baseline = await fingerprint();
	write("packages/example/unrelated.txt", "changed\n");
	assert.equal((await fingerprint()).fingerprint, baseline.fingerprint);
});

test("stamps match only the same fingerprint and environment", () => {
	const environment = { platform: "darwin", arch: "arm64", nativeTarget: "" };
	const stamp = { version: 1, fingerprint: "abc", ...environment };
	assert.equal(stampMatches(stamp, "abc", environment), true);
	assert.equal(stampMatches(stamp, "other", environment), false);
	assert.equal(stampMatches(stamp, "abc", { ...environment, platform: "linux" }), false);
	assert.equal(stampMatches(stamp, "abc", { ...environment, arch: "x64" }), false);
	assert.equal(stampMatches(stamp, "abc", { ...environment, nativeTarget: "darwin-arm64" }), false);
	assert.equal(stampMatches({ ...stamp, version: 2 }, "abc", environment), false);
	assert.equal(stampMatches(undefined, "abc", environment), false);
});

test("a written stamp can be read back from the cache directory", async (t) => {
	const { repoRoot } = fixture(t);
	const file = runtimeStampPath(repoRoot);
	assert.equal(file, join(repoRoot, "node_modules", ".cache", "metis-desktop", "app-server-build.json"));
	assert.equal(await readRuntimeStamp(file), undefined);
	await writeRuntimeStamp(file, { fingerprint: "abc", platform: "darwin", arch: "arm64", nativeTarget: "" });
	assert.deepEqual(await readRuntimeStamp(file), {
		version: 1,
		fingerprint: "abc",
		platform: "darwin",
		arch: "arm64",
		nativeTarget: "",
	});
});
