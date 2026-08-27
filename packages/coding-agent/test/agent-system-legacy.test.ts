import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const SCAN_ROOTS = [
	"packages/app-protocol/src",
	"packages/app-server/src",
	"packages/desktop/src",
	"packages/coding-agent/src",
] as const;

const FORBIDDEN = [
	"SubagentSummary",
	"SubagentConfig",
	"SubagentTombstone",
	"SubagentManagerEvent",
	"subagent/readItems",
	"subagent/interrupt",
	"SubagentPanel",
	"activate_subagents",
	"message_agent",
	"subagent_created",
	"subagent_state",
	"interruptSubagent",
	"readSubagentItems",
	"buildSubagentContract",
	"buildParentAssignmentProfile",
	'"close_agent"',
	"subagent_mailbox_event",
	"subagent_mailbox_delivery",
	"subagent_mode_change",
	"getSessionSubagentDir",
	"enqueueSubagentMailboxEvent",
	"continueSubagentMailboxEvent",
	"hasSubagentMailboxEvent",
	"getPendingSubagentMailboxEventIds",
	"<subagent_contract>",
	"<subagent_coordination>",
] as const;

function walkSourceFiles(directory: string): string[] {
	const entries = readdirSync(directory);
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			files.push(...walkSourceFiles(path));
			continue;
		}
		if (path.endsWith(".ts") || path.endsWith(".tsx")) files.push(path);
	}
	return files;
}

function scanForbiddenHits(): Array<{ file: string; line: number; pattern: string; text: string }> {
	const hits: Array<{ file: string; line: number; pattern: string; text: string }> = [];
	for (const root of SCAN_ROOTS) {
		const absoluteRoot = join(repoRoot, root);
		for (const file of walkSourceFiles(absoluteRoot)) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index]!;
				for (const pattern of FORBIDDEN) {
					if (!line.includes(pattern)) continue;
					hits.push({
						file: relative(repoRoot, file),
						line: index + 1,
						pattern,
						text: line.trim(),
					});
				}
			}
		}
	}
	return hits;
}

describe("agent system v2 legacy scan", () => {
	it("does not retain removed subagent protocol, UI, or type surfaces in production sources", () => {
		const hits = scanForbiddenHits();
		expect(hits).toEqual([]);
	});
});
