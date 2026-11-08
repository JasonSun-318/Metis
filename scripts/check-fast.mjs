#!/usr/bin/env node
/**
 * Staged-file-scoped pre-commit gate.
 *
 * The full repository gate (`npm run check`) runs in the pre-push hook and CI.
 * This lane keeps the checks that an ordinary staged change can invalidate and
 * skips whole-repository analyses (runtime cycles, public API, dead exports,
 * duplicate/type-debt reports) plus checks for areas the staged files do not
 * touch. Path-scoped steps stay conditional so a script-only or desktop-only
 * change still runs the checks that cover it.
 *
 * Usage:
 *   node scripts/check-fast.mjs             # run the plan for staged files
 *   node scripts/check-fast.mjs --dry-run   # print the plan without running
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const localBin = (name) => join(root, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/i;
const BIOME_FILE = /\.(?:[cm]?ts|tsx|mjs)$/i;
// Files Biome's configuration excludes: generated model catalogs and the
// session fixture. Passing them explicitly would fail with "no files processed".
const BIOME_EXCLUDED_FILE = /(?:\.generated\.[cm]?ts|\.models\.[cm]?ts|(?:^|\/)test-sessions\.ts)$/;
const TSCONFIG_FILE = /^tsconfig.*\.json$/i;
const ROOT_MANIFEST_FILES = new Set(["package.json", "package-lock.json"]);
const DESKTOP_PREFIXES = ["packages/desktop/", "packages/app-protocol/"];
const BROWSER_SMOKE_PREFIXES = ["packages/ai/", "packages/agent/"];

/**
 * Files whose change can invalidate one of the fast-lane checks. Anything else
 * (documentation, images, changelogs, CI workflow edits) is covered by the full
 * pre-push/CI gate and does not need a local source check.
 */
export function isCheckRelevant(file) {
	if (file === "package.json" || file === "package-lock.json") return true;
	if (TSCONFIG_FILE.test(file)) return true;
	if (/^packages\/coding-agent\/examples\//.test(file)) return true;
	if (file.startsWith("packages/coding-agent/install-lock/")) return true;
	if (/^packages\/[^/]+\/(?:src|test|e2e)\//.test(file)) return true;
	if (/^packages\/[^/]+\/(?:package\.json|npm-shrinkwrap\.json|tsconfig.*\.json)$/.test(file)) return true;
	if (file.startsWith("scripts/") && !file.startsWith("scripts/baselines/")) return true;
	return false;
}

export function buildPlan(staged) {
	const plan = [];
	const hasFile = (predicate) => staged.some(predicate);
	const touchesPath = (prefixes) => hasFile((file) => prefixes.some((prefix) => file.startsWith(prefix)));
	const touchesRootManifest = hasFile((file) => ROOT_MANIFEST_FILES.has(file));
	const touchesTsconfig = hasFile((file) => TSCONFIG_FILE.test(file));

	// Biome rewrites staged files, so it runs before the read-only checks.
	const biomeFiles = staged.filter((file) => BIOME_FILE.test(file) && !BIOME_EXCLUDED_FILE.test(file));
	if (biomeFiles.length > 0) {
		plan.push({
			label: `biome (${biomeFiles.length} staged file${biomeFiles.length === 1 ? "" : "s"})`,
			command: localBin("biome"),
			commandArgs: ["check", "--write", "--error-on-warnings", ...biomeFiles],
			// A staged file outside biome.json's include patterns makes Biome fail
			// with "No files were processed"; the full gate still covers included
			// files, so treat an all-excluded selection as a no-op.
			captureOutput: true,
			tolerateNoFiles: true,
		});
	}

	// Whole-repository static checks that are cheap and path-independent.
	for (const script of [
		"check:pinned-deps",
		"check:boundaries",
		"check:ts-imports",
		"check:shrinkwrap",
		"check:install-lock:coding-agent",
	]) {
		plan.push({ label: script, command: npmCommand, commandArgs: ["run", script] });
	}
	plan.push({
		label: "check:generated",
		command: npmCommand,
		commandArgs: ["run", "check:generated", "--workspace", "@metis/app-protocol"],
	});

	// Type checking covers source and tests; manifest or tsconfig changes can
	// also break resolution, so they trigger the same pass.
	if (touchesRootManifest || touchesTsconfig || hasFile((file) => SOURCE_FILE.test(file))) {
		plan.push({ label: "check:types", command: npmCommand, commandArgs: ["run", "check:types"] });
	}

	if (touchesPath(DESKTOP_PREFIXES) || touchesRootManifest || touchesTsconfig) {
		plan.push({ label: "check:desktop", command: npmCommand, commandArgs: ["run", "check:desktop"] });
	}

	if (
		touchesPath(BROWSER_SMOKE_PREFIXES) ||
		touchesRootManifest ||
		staged.includes("scripts/browser-smoke-entry.ts")
	) {
		plan.push({
			label: "check:browser-smoke",
			command: npmCommand,
			commandArgs: ["run", "check:browser-smoke"],
		});
	}

	// The checker regressions exercise scripts/** against fixtures. Baselines are
	// data only, so a baseline refresh does not need the two-minute suite.
	const touchesCheckerSources = hasFile(
		(file) => file.startsWith("scripts/") && !file.startsWith("scripts/baselines/"),
	);
	if (touchesCheckerSources) {
		plan.push({ label: "check:scripts", command: npmCommand, commandArgs: ["run", "check:scripts"] });
	}

	return plan;
}

function formatDuration(milliseconds) {
	return `${(milliseconds / 1000).toFixed(1)}s`;
}

function stagedFiles() {
	const result = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git diff --cached failed: ${(result.stderr ?? "").trim()}`);
	}
	return result.stdout
		.split("\n")
		.map((file) => file.trim())
		.filter(Boolean);
}

function main() {
	const arguments_ = process.argv.slice(2);
	const dryRun = arguments_.includes("--dry-run");
	const unknownArguments = arguments_.filter((argument) => argument !== "--dry-run");
	if (unknownArguments.length > 0) {
		console.error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
		console.error("Usage: node scripts/check-fast.mjs [--dry-run]");
		process.exit(1);
	}

	const staged = stagedFiles();
	if (staged.length === 0) {
		console.log("check:fast skipped: no staged files (use `npm run check` for the full repository gate).");
		process.exit(0);
	}
	if (!staged.some(isCheckRelevant)) {
		console.log(
			"check:fast skipped: no check-relevant staged files (documentation and configuration-only changes are covered by the pre-push/CI full gate).",
		);
		process.exit(0);
	}

	const plan = buildPlan(staged);

	if (dryRun) {
		console.log(`check:fast plan for ${staged.length} staged file${staged.length === 1 ? "" : "s"}:`);
		for (const step of plan) console.log(`  - ${step.label}`);
		process.exit(0);
	}

	console.log(`check:fast (${staged.length} staged file${staged.length === 1 ? "" : "s"})`);
	let totalMilliseconds = 0;
	for (const step of plan) {
		const startedAt = Date.now();
		const capture = step.captureOutput === true;
		const result = spawnSync(step.command, step.commandArgs, {
			cwd: root,
			encoding: capture ? "utf8" : undefined,
			stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
			shell: isWindows,
		});
		const elapsed = Date.now() - startedAt;
		totalMilliseconds += elapsed;
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (capture && (result.stdout ?? result.stderr)) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		if (result.error) {
			console.error(`\n✗ ${step.label} could not start: ${result.error.message}`);
			process.exit(1);
		}
		if (result.status !== 0) {
			if (step.tolerateNoFiles === true && /No files were processed in the specified paths/.test(output)) {
				console.log(`  ✓ ${step.label} (no config-included files; skipped)`);
				continue;
			}
			console.error(`\n✗ ${step.label} failed after ${formatDuration(elapsed)}`);
			process.exit(result.status ?? 1);
		}
		console.log(`  ✓ ${step.label} (${formatDuration(elapsed)})`);
	}

	console.log(`\n✅ check:fast passed in ${formatDuration(totalMilliseconds)}`);
	console.log("The full repository gate runs in the pre-push hook and CI (`npm run check`).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
