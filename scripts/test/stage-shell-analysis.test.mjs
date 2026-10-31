import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	installedPackageRoot,
	SHELL_ANALYSIS_FILES,
	SHELL_ANALYSIS_NOTICES,
	stageShellAnalysis,
} from "../stage-shell-analysis.mjs";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function temporaryRoot(t) {
	const root = mkdtempSync(join(tmpdir(), "metis-stage-shell-analysis-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function fakePackage(root, options = {}) {
	const packageRoot = join(root, "package");
	mkdirSync(join(packageRoot, "wasm"), { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		`${JSON.stringify({ name: "@vscode/tree-sitter-wasm", version: options.version ?? "0.3.1" })}\n`,
	);
	for (const relative of SHELL_ANALYSIS_FILES) {
		if (options.missing?.includes(relative)) continue;
		writeFileSync(join(packageRoot, relative), `asset:${relative}`);
	}
	for (const relative of SHELL_ANALYSIS_NOTICES) {
		writeFileSync(join(packageRoot, relative), `notice:${relative}`);
	}
	return packageRoot;
}

test("stages only the five pinned assets, notices, and a sealed manifest", (t) => {
	const root = temporaryRoot(t);
	const outputDir = join(root, "dist", "vendor", "shell-analysis");
	stageShellAnalysis({ outputDir });
	const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.package, "@vscode/tree-sitter-wasm");
	assert.equal(manifest.version, "0.3.1");
	assert.deepEqual(
		manifest.files.map((entry) => entry.name).sort(),
		SHELL_ANALYSIS_FILES.map((relative) => relative.split("/").at(-1)).sort(),
	);
	for (const relative of SHELL_ANALYSIS_FILES) {
		const name = relative.split("/").at(-1);
		const source = readFileSync(join(installedPackageRoot, relative));
		const staged = readFileSync(join(outputDir, name));
		assert.deepEqual(staged, source);
		const entry = manifest.files.find((candidate) => candidate.name === name);
		assert.equal(entry.sha256, createHash("sha256").update(source).digest("hex"));
		assert.equal(entry.bytes, source.byteLength);
	}
	for (const relative of SHELL_ANALYSIS_NOTICES) {
		assert.deepEqual(readFileSync(join(outputDir, relative)), readFileSync(join(installedPackageRoot, relative)));
	}
	assert.deepEqual(JSON.parse(readFileSync(join(outputDir, "package.json"), "utf8")), { type: "commonjs" });
	assert.equal(existsSync(join(outputDir, "tree-sitter-rust.wasm")), false);
});

test("rejects a package with a missing required asset", (t) => {
	const root = temporaryRoot(t);
	const packageRoot = fakePackage(root, { missing: [SHELL_ANALYSIS_FILES[2]] });
	assert.throws(() => stageShellAnalysis({ packageRoot, outputDir: join(root, "output") }), /missing/u);
	assert.equal(existsSync(join(root, "output", "manifest.json")), false);
});

test("rejects a package with the wrong exact version", (t) => {
	const root = temporaryRoot(t);
	const packageRoot = fakePackage(root, { version: "0.3.0" });
	assert.throws(() => stageShellAnalysis({ packageRoot, outputDir: join(root, "output") }), /version/u);
});

test("rejects a symlinked asset that escapes the installed package", (t) => {
	if (process.platform === "win32") {
		t.skip("symlink creation needs elevated privileges on Windows");
		return;
	}
	const root = temporaryRoot(t);
	const packageRoot = fakePackage(root);
	const outside = join(root, "outside.js");
	writeFileSync(outside, "throw new Error('outside');\n");
	rmSync(join(packageRoot, "wasm", "tree-sitter.js"));
	symlinkSync(outside, join(packageRoot, "wasm", "tree-sitter.js"));
	assert.throws(() => stageShellAnalysis({ packageRoot, outputDir: join(root, "output") }), /symlink|escape/u);
});

test("is called by both coding-agent asset copies", () => {
	const packageJson = JSON.parse(readFileSync(join(repoRoot, "packages", "coding-agent", "package.json"), "utf8"));
	assert.match(packageJson.scripts["copy-assets"], /stage-shell-analysis\.mjs/u);
	assert.match(packageJson.scripts["copy-binary-assets"], /stage-shell-analysis\.mjs/u);
});
