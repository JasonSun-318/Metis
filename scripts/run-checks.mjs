#!/usr/bin/env node
/**
 * Full repository gate.
 *
 * Runs the formatting step first (it rewrites staged/working files), then runs
 * the remaining independent checks with bounded concurrency, prints a per-step
 * timing table, and reports every failure with its captured output.
 *
 * Successful results are cached under `.cache/checks/` for an unchanged working
 * tree. The cache key covers the commit, relevant working-tree changes, the Node
 * version and the platform, so it cannot hide a change to the checked sources.
 * Set `METIS_CHECK_NO_CACHE=1` to bypass the cache and
 * `METIS_CHECK_CONCURRENCY=<n>` to change concurrency (default: up to 4).
 *
 * Usage:
 *   node scripts/run-checks.mjs             # run the full gate
 *   node scripts/run-checks.mjs --dry-run   # print the plan and exit
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const CACHE_VERSION = 1;
const CACHE_DIRECTORY = join(root, ".cache", "checks", `v${CACHE_VERSION}`);

// The formatting step rewrites files, so it runs alone first. The remaining
// steps are independent and ordered longest-first for better pool packing.
export const CHECK_STEPS = [
	{ label: "format", script: "check:format" },
	{ label: "structure", script: "check:structure" },
	{ label: "checker regressions", script: "check:scripts" },
	{ label: "unused dependencies", script: "check:unused-deps" },
	{ label: "duplicates", script: "check:dup" },
	{ label: "desktop types", script: "check:desktop" },
	{ label: "types", script: "check:types" },
	{ label: "type debt", script: "check:type-debt" },
	{ label: "presentation boundaries", script: "check:presentation-boundaries" },
	{ label: "relative imports", script: "check:ts-imports" },
	{ label: "package boundaries", script: "check:boundaries" },
	{ label: "pinned dependencies", script: "check:pinned-deps" },
	{ label: "browser smoke", script: "check:browser-smoke" },
	{ label: "generated protocol schema", script: "check:generated", args: ["--workspace", "@metis/app-protocol"] },
	{ label: "shrinkwrap", script: "check:shrinkwrap" },
	{ label: "install lock", script: "check:install-lock:coding-agent" },
];

// Documentation and local-only directories do not feed any check. Ignoring them
// keeps the cache effective for this repository's ignored local material.
const LOCAL_ONLY_PREFIXES = [
	"docs/",
	"artifacts/",
	"plans/",
	".devin/",
	".codegraph/",
	".cache/",
	"node_modules/",
	"packages/desktop/out/",
];
const LOCAL_ONLY_FILES = new Set(["AGENTS.md"]);

export function isLocalOnlyPath(path) {
	if (LOCAL_ONLY_FILES.has(path)) return true;
	if (path.endsWith(".log")) return true;
	return LOCAL_ONLY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function statusPath(line) {
	// Porcelain lines are "XY path" (renames: "XY old -> new").
	const payload = line.slice(3).replace(/^"|"$/g, "");
	const arrow = payload.indexOf(" -> ");
	return arrow === -1 ? payload : payload.slice(arrow + 4);
}

export function filterRelevantStatusLines(lines) {
	return lines.filter((line) => line.length > 0 && !isLocalOnlyPath(statusPath(line)));
}

export function parseConcurrency(raw, cpuCount) {
	const fallback = Math.max(2, Math.min(4, cpuCount - 2));
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return fallback;
	return Math.min(parsed, 16);
}

export function cacheKeyFor(stateToken, label, runtime) {
	return createHash("sha256")
		.update(JSON.stringify([CACHE_VERSION, stateToken, label, runtime.node, runtime.platform]))
		.digest("hex");
}

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

// Returns undefined when the repository state cannot be established (no Git
// metadata), in which case caching is disabled instead of risking a stale hit.
function repositoryStateToken() {
	try {
		const head = git(["rev-parse", "HEAD"]);
		const status = git(["status", "--porcelain", "-uall"]).split("\n");
		return `${head}\n${filterRelevantStatusLines(status).join("\n")}`;
	} catch {
		return undefined;
	}
}

function readCache(key) {
	try {
		const file = join(CACHE_DIRECTORY, `${key}.json`);
		if (!existsSync(file)) return undefined;
		const value = JSON.parse(readFileSync(file, "utf8"));
		return typeof value.durationMs === "number" ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeCache(key, durationMs) {
	try {
		mkdirSync(CACHE_DIRECTORY, { recursive: true });
		writeFileSync(join(CACHE_DIRECTORY, `${key}.json`), `${JSON.stringify({ durationMs })}\n`);
	} catch {
		// A cache write failure must never fail the gate.
	}
}

function runScript(step) {
	return new Promise((resolveRun) => {
		const startedAt = Date.now();
		const child = spawn(npmCommand, ["run", step.script, ...(step.args ?? [])], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			shell: isWindows,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			resolveRun({
				label: step.label,
				status: 1,
				stdout,
				stderr: `${stderr}${error.message}\n`,
				durationMs: Date.now() - startedAt,
			});
		});
		child.on("close", (status) => {
			resolveRun({ label: step.label, status: status ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
		});
	});
}

function formatSeconds(milliseconds) {
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function printFailure(result) {
	console.error(`\n── ${result.label} failed after ${formatSeconds(result.durationMs)} ──`);
	if (result.stdout.trim()) console.error(result.stdout.trimEnd());
	if (result.stderr.trim()) console.error(result.stderr.trimEnd());
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.length === 1 && args[0] === "--dry-run";
	if (args.length > 0 && !dryRun) {
		console.error("Usage: node scripts/run-checks.mjs [--dry-run]");
		process.exitCode = 2;
		return;
	}

	const concurrency = parseConcurrency(process.env.METIS_CHECK_CONCURRENCY, availableParallelism());
	const cacheEnabled = process.env.METIS_CHECK_NO_CACHE !== "1";
	const runtime = { node: process.version, platform: `${process.platform}-${process.arch}` };
	const stateToken = cacheEnabled ? repositoryStateToken() : undefined;

	if (dryRun) {
		console.log(`check plan: ${CHECK_STEPS.length} steps, concurrency ${concurrency}`);
		console.log(`cache: ${stateToken === undefined ? "disabled" : "enabled"}`);
		for (const step of CHECK_STEPS) console.log(`  - ${step.label} (npm run ${step.script})`);
		return;
	}

	const startedAt = Date.now();
	console.log(
		`check: ${CHECK_STEPS.length} steps, concurrency ${concurrency}${stateToken === undefined ? ", cache disabled" : ""}`,
	);

	// Formatting runs first and alone: it may rewrite files the other steps read.
	const [formatStep, ...parallelSteps] = CHECK_STEPS;
	const format = await runScript(formatStep);
	if (format.status === 0) {
		console.log(`  ✓ ${format.label} (${formatSeconds(format.durationMs)})`);
	} else {
		printFailure(format);
		console.error("\ncheck failed while formatting; no further steps were started.");
		process.exit(1);
	}

	const results = [];
	let nextIndex = 0;
	async function worker() {
		while (nextIndex < parallelSteps.length) {
			const step = parallelSteps[nextIndex++];
			let result;
			let cacheKey;
			if (cacheEnabled && stateToken !== undefined) {
				cacheKey = cacheKeyFor(stateToken, step.label, runtime);
				const cached = readCache(cacheKey);
				if (cached) {
					result = {
						label: step.label,
						status: 0,
						stdout: "",
						stderr: "",
						durationMs: cached.durationMs,
						cached: true,
					};
					results.push(result);
					console.log(`  ✓ ${step.label} (cached ${formatSeconds(cached.durationMs)})`);
					continue;
				}
			}
			console.log(`  ▶ ${step.label}`);
			result = await runScript(step);
			results.push(result);
			if (result.status === 0) {
				if (cacheEnabled && stateToken !== undefined && cacheKey !== undefined)
					writeCache(cacheKey, result.durationMs);
				console.log(`  ✓ ${step.label} (${formatSeconds(result.durationMs)})`);
			} else {
				console.log(`  ✗ ${step.label} (${formatSeconds(result.durationMs)})`);
			}
		}
	}
	await Promise.all(Array.from({ length: concurrency }, worker));

	const failures = results.filter((result) => result.status !== 0);
	for (const failure of failures) printFailure(failure);

	const totalDuration = Date.now() - startedAt;
	const order = new Map(CHECK_STEPS.map((step, index) => [step.label, index]));
	const timing = [format, ...results].sort((left, right) => order.get(left.label) - order.get(right.label));
	console.log("\nCheck steps:");
	for (const result of timing) {
		const marker = result.status === 0 ? "✓" : "✗";
		const suffix = result.cached ? " (cached)" : "";
		console.log(`  ${marker} ${result.label.padEnd(24)} ${formatSeconds(result.durationMs).padStart(7)}${suffix}`);
	}
	const passed = results.filter((result) => result.status === 0).length + 1;
	console.log(
		`\n${failures.length === 0 ? "✅" : "✗"} check: ${passed} passed, ${failures.length} failed, ${formatSeconds(totalDuration)} total`,
	);
	if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
