import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@metis/ai";
import { expect, it } from "vitest";
import {
	assertTaskOutcome,
	snapshotProject,
	unapprovedProjectChanges,
} from "../../../scripts/lib/prompt-cache-quality.ts";

it("rejects wrong task output even after a normal stop, and rejects failed preparation", () => {
	expect(() => assertTaskOutcome([fauxAssistantMessage("wrong answer")], () => "wrong root cause")).toThrow(
		"wrong root cause",
	);
	expect(() =>
		assertTaskOutcome([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prepare failed" })]),
	).toThrow("prepare failed");
	expect(() => assertTaskOutcome([fauxAssistantMessage("correct")], () => null)).not.toThrow();
});

it("enforces the model-call budget and exits unsuccessfully instead of reporting a false pass", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cache-budget-"));
	const output = join(root, "report.json");
	try {
		expect(() =>
			execFileSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"scripts/bench-prompt-cache.ts",
					"--mode",
					"offline",
					"--variant",
					"stable",
					"--reps",
					"1",
					"--max-requests",
					"1",
					"--output",
					output,
				],
				{ cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdio: "pipe" },
			),
		).toThrow();
		const report = JSON.parse(readFileSync(output, "utf8"));
		expect(report.requestCount).toBe(1);
		expect(report.successes).toBe(0);
		expect(report.failures).toBe(1);
		expect(report.skipped).toBe(2);
		expect(report.cacheReadTokens).toBeNull();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

it("rejects added, deleted and modified unrelated project files while allowing the approved repair", () => {
	const root = mkdtempSync(join(tmpdir(), "metis-cache-scope-"));
	try {
		writeFileSync(join(root, "source.ts"), "bug");
		writeFileSync(join(root, "test.ts"), "original tests");
		const before = snapshotProject(root);
		const changes = () => unapprovedProjectChanges(before, snapshotProject(root), new Set(["source.ts"]));
		writeFileSync(join(root, "source.ts"), "fixed");
		expect(changes()).toEqual([]);
		writeFileSync(join(root, "test.ts"), "weakened tests");
		expect(changes()).toEqual(["test.ts"]);
		rmSync(join(root, "test.ts"));
		writeFileSync(join(root, "unrelated.txt"), "unexpected");
		expect(changes()).toEqual(["test.ts", "unrelated.txt"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
