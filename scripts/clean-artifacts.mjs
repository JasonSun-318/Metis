#!/usr/bin/env node
/**
 * Report and remove regenerable desktop/check artifacts.
 *
 * The default invocation is a dry run: it prints what would be freed and where.
 * Pass `--apply` to delete. Cache targets are only included with
 * `--include-cache` (removing them forces the next full gate or dev start to
 * rebuild the cached work).
 *
 * Usage:
 *   node scripts/clean-artifacts.mjs                    # report sizes
 *   node scripts/clean-artifacts.mjs --apply            # delete build/test artifacts
 *   node scripts/clean-artifacts.mjs --apply --include-cache
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const ARTIFACT_TARGETS = [
	{ label: "desktop packaged output", path: "packages/desktop/out" },
	{ label: "desktop webpack output", path: "packages/desktop/.webpack" },
	{ label: "desktop test results", path: "packages/desktop/test-results" },
	{ label: "desktop playwright report", path: "packages/desktop/playwright-report" },
];

export const CACHE_TARGETS = [
	{ label: "full-gate result cache", path: ".cache/checks" },
	{ label: "desktop dev app-server runtime", path: "node_modules/.cache/metis-desktop" },
];

export function artifactTargets({ includeCache = false } = {}) {
	return includeCache ? [...ARTIFACT_TARGETS, ...CACHE_TARGETS] : [...ARTIFACT_TARGETS];
}

export function directorySize(path) {
	if (!existsSync(path)) return 0;
	const stats = statSync(path);
	if (!stats.isDirectory()) return stats.size;
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		total += directorySize(join(path, entry.name));
	}
	return total;
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

async function main() {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const includeCache = args.includes("--include-cache");
	const unknown = args.filter((argument) => argument !== "--apply" && argument !== "--include-cache");
	if (unknown.length > 0) {
		console.error(`Unknown argument(s): ${unknown.join(", ")}`);
		console.error("Usage: node scripts/clean-artifacts.mjs [--apply] [--include-cache]");
		process.exitCode = 2;
		return;
	}

	const targets = artifactTargets({ includeCache });
	let total = 0;
	console.log(`${apply ? "Removing" : "Would remove"} regenerable artifacts:`);
	for (const target of targets) {
		const path = join(root, target.path);
		const size = directorySize(path);
		total += size;
		console.log(`  ${target.label.padEnd(34)} ${formatBytes(size).padStart(10)}  ${target.path}`);
	}
	console.log(`  ${"total".padEnd(34)} ${formatBytes(total).padStart(10)}`);

	if (!apply) {
		console.log("\nDry run: pass --apply to delete (add --include-cache for the check cache and dev runtime).");
		return;
	}

	for (const target of targets) {
		await rm(join(root, target.path), { recursive: true, force: true });
	}
	console.log(`\n✅ Removed ${formatBytes(total)} from ${targets.length} target(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
