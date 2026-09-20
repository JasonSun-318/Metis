/** Offline, read-only inspection. Never emits transcript text, headers or prompt bodies. */
import { readFileSync } from "node:fs";
import { buildPromptCacheReport } from "../packages/coding-agent/src/core/prompt-cache-report.ts";
import type { SessionEntry } from "../packages/coding-agent/src/core/session-manager.ts";

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
	console.error("Usage: node --import tsx scripts/inspect-prompt-cache.ts /absolute/session.jsonl");
	process.exitCode = 1;
} else {
	try {
		const entries = readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as SessionEntry);
		console.log(JSON.stringify({ boundary: "adapter-payload", note: "Stable local fingerprints do not guarantee a provider cache hit. Missing snapshots cannot explain past misses; cache markers are included in comparisons.", requests: buildPromptCacheReport(entries).slice(-20) }, null, 2));
	} catch {
		console.error("Cannot read a complete, valid session journal. Retry after the current request finishes.");
		process.exitCode = 1;
	}
}
