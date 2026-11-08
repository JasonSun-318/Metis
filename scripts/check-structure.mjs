#!/usr/bin/env node
/**
 * Structural checks against one shared set of in-memory programs.
 *
 * Runtime cycles and the public API surface are hard gates; the dead-export
 * report stays advisory, matching its standalone CLI. Baselines and diagnostics
 * stay in the same files the standalone checkers use, so `--update` keeps the
 * existing review workflow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deadExportChanges, scanDeadExports, validateDeadExportBaseline } from "./check-dead-exports.mjs";
import { publicApiChanges, publicApiSnapshot } from "./check-public-api.mjs";
import { newCycleEdges, runtimeCycleSnapshot } from "./check-runtime-cycles.mjs";
import { structurePrograms } from "./lib/source-program.mjs";

const BASELINE_DIRECTORY = "scripts/baselines";
const CYCLES_BASELINE = "runtime-cycles.json";
const PUBLIC_API_BASELINE = "public-api.json";
const DEAD_EXPORT_BASELINE = "dead-exports.json";

function baselinePath(root, name) {
	return join(root, BASELINE_DIRECTORY, name);
}

function readBaseline(root, name) {
	return JSON.parse(readFileSync(baselinePath(root, name), "utf8"));
}

function writeBaseline(root, name, value) {
	const file = baselinePath(root, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function reportCycles(root, snapshot) {
	const baseline = readBaseline(root, CYCLES_BASELINE);
	if (baseline.version !== snapshot.version) throw new Error("Unsupported runtime-cycle baseline version");
	const added = newCycleEdges(snapshot.edges, baseline.edges);
	if (added.length > 0) {
		console.error(`New runtime cycle edges:\n${added.map(([from, to]) => `  ${from} -> ${to}`).join("\n")}`);
		return false;
	}
	console.log(`Runtime cycle check passed (${snapshot.edges.length} existing cyclic edges; no additions).`);
	return true;
}

function reportPublicApi(root, snapshot) {
	const changes = publicApiChanges(snapshot, readBaseline(root, PUBLIC_API_BASELINE));
	if (changes.length > 0) {
		console.error(`Public API surface changed:\n${changes.map((change) => `  ${change}`).join("\n")}`);
		return false;
	}
	console.log(`Public API surface check passed (${Object.keys(snapshot.packages).length} packages).`);
	return true;
}

function reportDeadExports(root, result) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) {
		console.log(`Dead export scan incomplete: ${errors.length} error(s) prevented a complete conclusion.`);
		for (const error of errors) console.error(`  ${error.message}`);
	}
	const uncertaintyCount = result.uncertainties.global.length + result.uncertainties.modules.length;
	if (uncertaintyCount > 0) {
		console.log(
			`Dead export coverage uncertainty: ${uncertaintyCount} unresolved reference(s); run npm run check:dead-exports for details.`,
		);
	}
	const baselineFile = baselinePath(root, DEAD_EXPORT_BASELINE);
	if (!existsSync(baselineFile)) {
		console.error(
			`Baseline ${baselineFile} is missing; run node scripts/check-dead-exports.mjs --update after reviewing candidates.`,
		);
	} else {
		try {
			const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
			const invalid = validateDeadExportBaseline(baseline);
			if (invalid) throw new Error(`Baseline ${baselineFile} is invalid: ${invalid}`);
			const changes = deadExportChanges(result.snapshot, baseline);
			if (changes.added.length > 0 || changes.removed.length > 0) {
				console.log("Dead export changes since baseline:");
				for (const candidate of changes.added) {
					console.log(`  New candidate: ${candidate.file} ${candidate.export} [${candidate.category}]`);
				}
				for (const candidate of changes.removed) {
					console.log(
						`  Baseline candidate no longer reported: ${candidate.file} ${candidate.export} [${candidate.category}]`,
					);
				}
			}
		} catch (error) {
			console.error(`Dead export baseline could not be read: ${messageOf(error)}`);
		}
	}
	const counts = result.counts;
	console.log(
		`Dead export report: scanned ${counts.filesScanned} source file(s) / ${counts.candidateFiles} candidate file(s); ${result.publicEntrypoints} public entrypoint source(s); used ${result.used} export(s); ${result.candidates.length} candidate(s) (zero-reference ${counts["zero-reference"]}, same-file-only ${counts["same-file-only"]}, test-only ${counts["test-only"]}, barrel-only ${counts["barrel-only"]}). No files changed.`,
	);
}

function updateDeadExportsBaseline(root, result) {
	const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
	if (errors.length > 0) {
		console.error("Refusing to update the dead export baseline from an incomplete scan:");
		for (const error of errors) console.error(`  ${error.message}`);
		console.error("No files changed.");
		return false;
	}
	writeBaseline(root, DEAD_EXPORT_BASELINE, result.snapshot);
	console.log(
		`Updated advisory dead export baseline (${result.snapshot.candidates.length} candidate(s)). Review the diff before committing.`,
	);
	return true;
}

function main() {
	const args = process.argv.slice(2);
	const update = args.length === 1 && args[0] === "--update";
	if (args.length > 0 && !update) {
		console.error("Usage: node scripts/check-structure.mjs [--update]");
		process.exitCode = 2;
		return;
	}

	const root = resolve(process.cwd());
	const startedAt = Date.now();

	// One workspace, one emit and one emitted program feed all three analyses.
	const context = structurePrograms(root);
	const cycles = runtimeCycleSnapshot(root, context);
	const publicApi = publicApiSnapshot(root, context);
	let dead;
	try {
		dead = scanDeadExports(root, context);
	} catch (error) {
		console.error(`Dead export scan failed: ${messageOf(error)}`);
		if (update) process.exitCode = 1;
	}

	if (update) {
		writeBaseline(root, CYCLES_BASELINE, cycles);
		console.log(`Updated runtime-cycle baseline (${cycles.edges.length} edges); review the diff before committing.`);
		writeBaseline(root, PUBLIC_API_BASELINE, publicApi);
		console.log("Updated public API surface baseline; review the diff before committing.");
		if (dead && !updateDeadExportsBaseline(root, dead)) process.exitCode = 1;
		return;
	}

	let failed = false;
	if (!reportCycles(root, cycles)) failed = true;
	if (!reportPublicApi(root, publicApi)) failed = true;
	if (dead) reportDeadExports(root, dead);
	if (failed) process.exitCode = 1;
	console.log(`Structure checks completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main();
}
