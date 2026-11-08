#!/usr/bin/env node
/**
 * Build the publishable workspace packages with dependency-aware concurrency.
 *
 * The previous `cd` chain built six packages serially even though tui, ai and
 * app-protocol are independent. The plan below keeps the same build order
 * constraints (dependents start only after their local dependencies finish) and
 * runs everything that is ready in parallel.
 *
 * Usage:
 *   node scripts/build-packages.mjs             # build all publishable packages
 *   node scripts/build-packages.mjs --dry-run   # print the build tiers
 */
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConcurrency } from "./run-checks.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";

export const BUILD_TASKS = [
	{ name: "@metis/tui", dependencies: [] },
	{ name: "@metis/ai", dependencies: [], offlineScript: "build:offline" },
	{ name: "@metis/app-protocol", dependencies: [] },
	{ name: "@metis/agent-core", dependencies: ["@metis/ai"] },
	{ name: "@metis/coding-agent", dependencies: ["@metis/tui", "@metis/ai", "@metis/agent-core"] },
	{ name: "@metis/app-server", dependencies: ["@metis/app-protocol", "@metis/coding-agent"] },
];

export function buildTiers(tasks = BUILD_TASKS) {
	const remaining = new Map(tasks.map((task) => [task.name, task]));
	const completed = new Set();
	const tiers = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()]
			.filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
			.map((task) => task.name)
			.sort();
		if (ready.length === 0) {
			throw new Error(`Build dependency cycle or missing dependency: ${[...remaining.keys()].join(", ")}`);
		}
		for (const name of ready) {
			remaining.delete(name);
			completed.add(name);
		}
		tiers.push(ready);
	}
	return tiers;
}

// `npm run build` regenerates the model catalog from upstream data. Callers that
// only need compiled output (or must not rewrite data files) can opt into the
// offline variant with METIS_SKIP_MODEL_REGENERATION=1.
export function buildScriptFor(task, environment = process.env) {
	return environment.METIS_SKIP_MODEL_REGENERATION === "1" && task.offlineScript ? task.offlineScript : "build";
}

function runBuild(task) {
	const script = buildScriptFor(task);
	return new Promise((resolveRun) => {
		const startedAt = Date.now();
		const child = spawn(npmCommand, ["run", script, "--workspace", task.name], {
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
				name,
				status: 1,
				stdout,
				stderr: `${stderr}${error.message}\n`,
				durationMs: Date.now() - startedAt,
			});
		});
		child.on("close", (status) => {
			resolveRun({ name, status: status ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
		});
	});
}

function formatSeconds(milliseconds) {
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

async function main() {
	const args = process.argv.slice(2);
	const dryRun = args.length === 1 && args[0] === "--dry-run";
	if (args.length > 0 && !dryRun) {
		console.error("Usage: node scripts/build-packages.mjs [--dry-run]");
		process.exitCode = 2;
		return;
	}

	const tiers = buildTiers();
	const concurrency = parseConcurrency(process.env.METIS_BUILD_CONCURRENCY, availableParallelism());

	if (dryRun) {
		console.log(`build plan: ${BUILD_TASKS.length} packages, ${tiers.length} tiers, concurrency ${concurrency}`);
		for (const [index, tier] of tiers.entries()) console.log(`  tier ${index + 1}: ${tier.join(", ")}`);
		return;
	}

	const startedAt = Date.now();
	console.log(`build: ${BUILD_TASKS.length} packages in ${tiers.length} tiers, concurrency ${concurrency}`);

	const completed = new Set();
	const pending = new Set(BUILD_TASKS.map((task) => task.name));
	const failures = [];
	const timings = [];
	let active = 0;
	let wakeWaiters = [];

	const wake = () => {
		for (const waiter of wakeWaiters) waiter();
		wakeWaiters = [];
	};

	const waitForProgress = () =>
		active === 0 ? Promise.resolve() : new Promise((resolveWait) => wakeWaiters.push(resolveWait));

	const start = (task) => {
		pending.delete(task.name);
		active += 1;
		console.log(`  ▶ ${task.name}`);
		void runBuild(task).then((result) => {
			active -= 1;
			timings.push(result);
			if (result.status === 0) {
				completed.add(task.name);
				console.log(
					`  ✓ ${task.name}${result.script === "build" ? "" : ` (${result.script})`} (${formatSeconds(result.durationMs)})`,
				);
			} else {
				failures.push(result);
				console.log(`  ✗ ${task.name} (${formatSeconds(result.durationMs)})`);
			}
			wake();
		});
	};

	const schedule = () => {
		if (failures.length > 0) return;
		for (const task of BUILD_TASKS) {
			if (active >= concurrency) return;
			if (!pending.has(task.name)) continue;
			if (!task.dependencies.every((dependency) => completed.has(dependency))) continue;
			start(task);
		}
	};

	for (;;) {
		schedule();
		if (active === 0) break;
		await waitForProgress();
	}

	for (const failure of failures) {
		console.error(`\n── ${failure.name} failed after ${formatSeconds(failure.durationMs)} ──`);
		if (failure.stdout.trim()) console.error(failure.stdout.trimEnd());
		if (failure.stderr.trim()) console.error(failure.stderr.trimEnd());
	}

	console.log("\nBuild results:");
	for (const timing of timings.sort((left, right) => left.durationMs - right.durationMs)) {
		const marker = timing.status === 0 ? "✓" : "✗";
		console.log(`  ${marker} ${timing.name.padEnd(22)} ${formatSeconds(timing.durationMs).padStart(7)}`);
	}
	const totalDuration = formatSeconds(Date.now() - startedAt);
	if (failures.length > 0) {
		console.error(`\n✗ build: ${completed.size} passed, ${failures.length} failed, ${totalDuration} total`);
		process.exitCode = 1;
		return;
	}
	console.log(`\n✅ build: ${completed.size} packages passed in ${totalDuration}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
