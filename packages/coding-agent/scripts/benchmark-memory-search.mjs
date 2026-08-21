import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openMemoryStore } from "../dist/core/memory/memory-store.js";

const sizes = [1_000, 10_000, 30_000];
let failed = false;

for (const size of sizes) {
	const dir = mkdtempSync(join(tmpdir(), "metis-memory-bench-"));
	try {
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		const vector = new Float32Array(64);
		vector[0] = 1;
		store.runInTransaction(() => {
			for (let index = 0; index < size; index++) {
				store.insertFact({
					id: `fact-${index}`,
					scope: index % 2 === 0 ? "global" : "project",
					cwdKey: index % 2 === 0 ? null : "project",
					mode: null,
					topicFile: "benchmark.md",
					text: `benchmark target fact ${index}`,
					status: "active",
					createdAt: new Date(index).toISOString(),
					sourceTurn: null,
					embedding: vector,
					embeddingModel: "benchmark",
				});
			}
		});
		const search = () =>
			store.searchRelevantFacts(vector, {
				queryText: "benchmark target",
				embeddingKey: "benchmark",
				projectKey: "project",
				limit: 50,
			});
		search();
		search();
		const baseline = process.memoryUsage().rss;
		let peak = baseline;
		const samples = [];
		for (let iteration = 0; iteration < 20; iteration++) {
			const started = performance.now();
			search();
			samples.push(performance.now() - started);
			peak = Math.max(peak, process.memoryUsage().rss);
		}
		samples.sort((left, right) => left - right);
		const median = samples[Math.floor(samples.length / 2)];
		const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
		const rssMiB = (peak - baseline) / 1024 / 1024;
		console.log(`${size}: median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms rssDelta=${rssMiB.toFixed(1)}MiB`);
		if (size === 30_000 && (p95 > 250 || rssMiB > 64)) failed = true;
		store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (failed) process.exitCode = 1;
