#!/usr/bin/env node
/**
 * Run the three desktop TypeScript projects concurrently.
 *
 * They type-check disjoint file sets (main/preload, renderer, tests) and share
 * no outputs, so running them in parallel cuts the gate from ~34s to ~15s
 * without changing what is checked.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsgo = join(desktopRoot, "..", "..", "node_modules", ".bin", process.platform === "win32" ? "tsgo.cmd" : "tsgo");
const configs = ["tsconfig.main.json", "tsconfig.renderer.json", "tsconfig.test.json"];

function runConfig(config) {
	return new Promise((resolveRun) => {
		const child = spawn(tsgo, ["--noEmit", "-p", config], {
			cwd: desktopRoot,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => resolveRun({ config, status: 1, stdout, stderr: `${stderr}${error.message}\n` }));
		child.on("close", (status) => resolveRun({ config, status: status ?? 1, stdout, stderr }));
	});
}

const startedAt = Date.now();
const results = await Promise.all(configs.map(runConfig));
let failed = false;
for (const result of results) {
	if (result.status === 0) {
		console.log(`  ✓ ${result.config}`);
		continue;
	}
	failed = true;
	console.error(`  ✗ ${result.config}`);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
}
console.log(`Desktop type checks finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
if (failed) process.exit(1);
