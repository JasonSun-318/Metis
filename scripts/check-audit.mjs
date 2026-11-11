import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Reports production dependency advisories against a reviewed baseline. The
// baseline only silences advisories that were deliberately accepted (each entry
// carries a reason); any new advisory, or a severity increase on an accepted
// one, fails the check. Advisories are keyed by package and GitHub advisory id
// so a fresh CVE under an already-accepted package is still reported.

const BASELINE_VERSION = 1;
const BASELINE_FILE = "scripts/baselines/security-audit.json";
const SEVERITY_ORDER = new Map([
	["info", 0],
	["low", 1],
	["moderate", 2],
	["high", 3],
	["critical", 4],
]);

function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function advisoryId(via) {
	const match = typeof via.url === "string" ? /(GHSA-[A-Za-z0-9-]+)/.exec(via.url) : undefined;
	if (match) return match[1];
	return `npm-${String(via.source ?? via.title)}`;
}

function emptyInventory() {
	return { packages: new Map(), totals: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } };
}

/**
 * Collapses `npm audit --json` output into one entry per package/advisory pair.
 * Dependency-chain entries (`via` strings) are skipped: their root advisory is
 * already reported under the package that owns it.
 */
function buildInventory(auditReport) {
	const inventory = emptyInventory();
	const vulnerabilities = auditReport?.vulnerabilities ?? {};
	for (const [packageName, entry] of Object.entries(vulnerabilities)) {
		for (const via of entry.via ?? []) {
			if (typeof via !== "object" || via === null) continue;
			const id = advisoryId(via);
			const severity = via.severity ?? entry.severity ?? "high";
			let record = inventory.packages.get(packageName);
			if (!record) {
				record = { package: packageName, severity, advisories: new Map() };
				inventory.packages.set(packageName, record);
			}
			if (record.advisories.has(id)) continue;
			record.advisories.set(id, {
				id,
				severity,
				title: via.title ?? id,
				range: via.range ?? entry.range ?? "",
				url: via.url ?? "",
			});
			if ((SEVERITY_ORDER.get(severity) ?? 0) > (SEVERITY_ORDER.get(record.severity) ?? 0)) {
				record.severity = severity;
			}
			inventory.totals[severity] = (inventory.totals[severity] ?? 0) + 1;
			inventory.totals.total += 1;
		}
	}
	return inventory;
}

function baselineAdvisoryIndex(baseline) {
	const index = new Map();
	for (const record of baseline?.packages ?? []) {
		for (const advisory of record.advisories ?? []) {
			index.set(`${record.package}\u0000${advisory.id}`, {
				package: record.package,
				reason: record.reason ?? "",
				severity: advisory.severity ?? "high",
			});
		}
	}
	return index;
}

/** Classifies current advisories against the reviewed baseline. */
function diffInventory(baseline, inventory) {
	const accepted = baselineAdvisoryIndex(baseline);
	const unaccepted = [];
	const severityIncreases = [];
	for (const record of inventory.packages.values()) {
		for (const advisory of record.advisories.values()) {
			const match = accepted.get(`${record.package}\u0000${advisory.id}`);
			if (!match) {
				unaccepted.push({ package: record.package, advisory });
				continue;
			}
			const before = SEVERITY_ORDER.get(match.severity) ?? 3;
			const now = SEVERITY_ORDER.get(advisory.severity) ?? 3;
			if (now > before) severityIncreases.push({ package: record.package, advisory, before: match.severity });
		}
	}
	const current = new Set();
	for (const record of inventory.packages.values()) {
		for (const advisory of record.advisories.values()) current.add(`${record.package}\u0000${advisory.id}`);
	}
	const resolved = [...accepted.keys()].filter((key) => !current.has(key));
	return { unaccepted, severityIncreases, resolved };
}

function runAudit() {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["audit", "--omit=dev", "--json"], {
		cwd: process.cwd(),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	// npm audit exits non-zero when it reports vulnerabilities; the JSON payload
	// is still valid, so parse before treating the exit code as a failure.
	const stdout = result.stdout ?? "";
	const start = stdout.indexOf("{");
	if (start >= 0) {
		try {
			return { report: JSON.parse(stdout.slice(start)) };
		} catch (error) {
			return { error: `could not parse npm audit output: ${messageOf(error)}` };
		}
	}
	const detail = (result.stderr ?? "").trim() || (result.error ? messageOf(result.error) : "no output");
	return { error: `npm audit failed: ${detail}` };
}

function loadBaseline(root) {
	const baselinePath = resolve(root, BASELINE_FILE);
	if (!existsSync(baselinePath)) {
		return {
			error: `Baseline ${BASELINE_FILE} is missing; run node scripts/check-audit.mjs --update after reviewing advisories.`,
		};
	}
	try {
		const baseline = readJson(baselinePath);
		if (baseline?.version !== BASELINE_VERSION) {
			return { error: `Baseline ${BASELINE_FILE} has version ${baseline?.version}; expected ${BASELINE_VERSION}.` };
		}
		if (!Array.isArray(baseline.packages)) {
			return { error: `Baseline ${BASELINE_FILE} is missing the packages array.` };
		}
		return { baseline };
	} catch (error) {
		return { error: `Baseline ${BASELINE_FILE} could not be read: ${messageOf(error)}` };
	}
}

function describeAdvisory(advisory) {
	return `${advisory.severity} ${advisory.id} ${advisory.title} (range ${advisory.range || "?"})`;
}

function runReport(root) {
	const loaded = loadBaseline(root);
	if (loaded.error) {
		console.error(loaded.error);
		process.exitCode = 1;
		return;
	}
	const audited = runAudit();
	if (audited.error) {
		console.error(audited.error);
		console.error("Audit incomplete; no conclusion was reached.");
		process.exitCode = 1;
		return;
	}
	const inventory = buildInventory(audited.report);
	const { unaccepted, severityIncreases, resolved } = diffInventory(loaded.baseline, inventory);
	const totals = inventory.totals;

	if (unaccepted.length > 0) {
		console.error(`New production advisories not present in ${BASELINE_FILE}:`);
		for (const { package: name, advisory } of unaccepted) {
			console.error(`  ${name}: ${describeAdvisory(advisory)}`);
		}
	}
	if (severityIncreases.length > 0) {
		console.error("Accepted production advisories increased in severity:");
		for (const { package: name, advisory, before } of severityIncreases) {
			console.error(`  ${name}: ${before} -> ${advisory.severity} ${advisory.id} ${advisory.title}`);
		}
	}
	if (resolved.length > 0) {
		console.log(`Baseline entries no longer reported by npm: ${resolved.length}`);
		console.log("  Refresh the baseline with: node scripts/check-audit.mjs --update");
	}
	const acceptedCount = totals.total - unaccepted.length;
	console.log(
		`Production advisories: ${totals.total} reported (${totals.critical} critical, ${totals.high} high, ${totals.moderate} moderate, ${totals.low} low); ${acceptedCount} covered by the reviewed baseline. No files changed.`,
	);
	if (unaccepted.length > 0 || severityIncreases.length > 0) process.exitCode = 1;
}

function sortInventory(inventory) {
	const packages = [...inventory.packages.values()]
		.map((record) => ({
			package: record.package,
			severity: record.severity,
			advisories: [...record.advisories.values()].sort((left, right) => left.id.localeCompare(right.id)),
		}))
		.sort((left, right) => left.package.localeCompare(right.package));
	return packages;
}

function runUpdate(root, previousBaseline) {
	const previousReasons = new Map();
	for (const record of previousBaseline?.packages ?? []) previousReasons.set(record.package, record.reason ?? "");
	const audited = runAudit();
	if (audited.error) {
		console.error(audited.error);
		console.error("Audit incomplete; the baseline was not changed.");
		process.exitCode = 1;
		return;
	}
	const inventory = buildInventory(audited.report);
	const packages = sortInventory(inventory).map((record) => ({
		package: record.package,
		reason: previousReasons.get(record.package) ?? "",
		advisories: record.advisories,
	}));
	const baseline = { version: BASELINE_VERSION, packages };
	writeFileSync(resolve(root, BASELINE_FILE), `${JSON.stringify(baseline, null, "\t")}\n`);
	console.log(`Wrote ${BASELINE_FILE} (${packages.length} package(s), ${inventory.totals.total} advisory record(s)).`);
	const missingReasons = packages.filter((record) => record.reason.trim() === "").map((record) => record.package);
	if (missingReasons.length > 0) {
		console.error(`Add a review reason for: ${missingReasons.join(", ")}`);
		process.exitCode = 1;
	}
}

function main() {
	const args = process.argv.slice(2);
	const update = args.length === 1 && args[0] === "--update";
	if (args.length > 0 && !update) {
		console.error("Usage: node scripts/check-audit.mjs [--update]");
		process.exitCode = 2;
		return;
	}
	const root = resolve(process.cwd());
	if (update) {
		const previous = loadBaseline(root);
		runUpdate(root, previous.baseline);
		return;
	}
	runReport(root);
}

export { advisoryId, buildInventory, diffInventory };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
