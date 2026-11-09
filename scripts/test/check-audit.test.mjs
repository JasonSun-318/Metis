import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInventory, diffInventory } from "../check-audit.mjs";

function auditReport(vulnerabilities) {
	return { auditReportVersion: 2, vulnerabilities };
}

function advisory(name, id, severity, title = `${name} advisory`) {
	return {
		name,
		severity,
		title,
		url: `https://github.com/advisories/${id}`,
		range: "<1.0.0",
	};
}

function baseline(packages) {
	return { version: 1, packages };
}

test("buildInventory skips dependency-chain entries and deduplicates advisories", () => {
	const report = auditReport({
		"node-forge": {
			severity: "high",
			via: [
				advisory("node-forge", "GHSA-1111-1111-1111", "high", "first"),
				advisory("node-forge", "GHSA-1111-1111-1111", "high", "first"),
			],
		},
		"@anthropic-ai/sandbox-runtime": { severity: "high", via: ["zod"] },
	});
	const inventory = buildInventory(report);
	assert.deepEqual([...inventory.packages.keys()], ["node-forge"]);
	const record = inventory.packages.get("node-forge");
	assert.equal(record.advisories.size, 1);
	assert.equal(inventory.totals.total, 1);
	assert.equal(inventory.totals.high, 1);
});

test("buildInventory uses the advisory source when GitHub does not provide a URL", () => {
	const report = auditReport({
		xlsx: { severity: "high", via: [{ source: 42, name: "xlsx", severity: "high", title: "local advisory" }] },
	});
	const inventory = buildInventory(report);
	assert.equal([...inventory.packages.get("xlsx").advisories.keys()][0], "npm-42");
});

test("diffInventory reports advisories that are not in the baseline", () => {
	const inventory = buildInventory(
		auditReport({ xlsx: { severity: "high", via: [advisory("xlsx", "GHSA-2222-2222-2222", "high")] } }),
	);
	const result = diffInventory(baseline([]), inventory);
	assert.equal(result.unaccepted.length, 1);
	assert.equal(result.unaccepted[0].package, "xlsx");
	assert.equal(result.severityIncreases.length, 0);
});

test("diffInventory reports a new advisory under an already accepted package", () => {
	const accepted = baseline([
		{
			package: "xlsx",
			reason: "reviewed",
			advisories: [{ id: "GHSA-2222-2222-2222", severity: "high", title: "old" }],
		},
	]);
	const inventory = buildInventory(
		auditReport({
			xlsx: {
				severity: "high",
				via: [advisory("xlsx", "GHSA-2222-2222-2222", "high"), advisory("xlsx", "GHSA-3333-3333-3333", "high")],
			},
		}),
	);
	const result = diffInventory(accepted, inventory);
	assert.deepEqual(
		result.unaccepted.map((entry) => entry.advisory.id),
		["GHSA-3333-3333-3333"],
	);
});

test("diffInventory reports accepted advisories that increased in severity", () => {
	const accepted = baseline([
		{
			package: "zod",
			reason: "reviewed",
			advisories: [{ id: "GHSA-4444-4444-4444", severity: "moderate", title: "old" }],
		},
	]);
	const inventory = buildInventory(
		auditReport({ zod: { severity: "high", via: [advisory("zod", "GHSA-4444-4444-4444", "critical")] } }),
	);
	const result = diffInventory(accepted, inventory);
	assert.equal(result.unaccepted.length, 0);
	assert.equal(result.severityIncreases.length, 1);
	assert.equal(result.severityIncreases[0].before, "moderate");
});

test("diffInventory lists baseline entries npm no longer reports", () => {
	const accepted = baseline([
		{
			package: "xlsx",
			reason: "reviewed",
			advisories: [{ id: "GHSA-2222-2222-2222", severity: "high", title: "old" }],
		},
	]);
	const inventory = buildInventory(auditReport({}));
	const result = diffInventory(accepted, inventory);
	assert.equal(result.unaccepted.length, 0);
	assert.deepEqual(result.resolved, ["xlsx\u0000GHSA-2222-2222-2222"]);
});

test("diffInventory accepts fully covered advisories", () => {
	const accepted = baseline([
		{
			package: "xlsx",
			reason: "reviewed",
			advisories: [{ id: "GHSA-2222-2222-2222", severity: "high", title: "old" }],
		},
	]);
	const inventory = buildInventory(
		auditReport({ xlsx: { severity: "high", via: [advisory("xlsx", "GHSA-2222-2222-2222", "high")] } }),
	);
	const result = diffInventory(accepted, inventory);
	assert.equal(result.unaccepted.length, 0);
	assert.equal(result.severityIncreases.length, 0);
	assert.equal(result.resolved.length, 0);
});
