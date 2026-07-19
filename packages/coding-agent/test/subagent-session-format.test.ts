import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionControlEntry } from "../src/core/session-control.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";
import type { SubagentConfig } from "../src/core/subagents/types.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "arcmind-subagent-format-"));
	roots.push(root);
	return root;
}

function config(): SubagentConfig {
	return {
		agentId: "agent-child-1",
		name: "researcher",
		task: "Research the session format",
		taskSummary: "Research the session format",
		mode: "chat",
		tools: ["read"],
		permissionMode: "ask",
		reviewerEnabled: true,
		model: { provider: "openai", modelId: "gpt-test" },
		thinkingLevel: "high",
		cwd: "/tmp/project",
		forkTurns: "all",
		timeoutSeconds: 60,
	};
}

describe("v7 first-class subagent records", () => {
	it("persists an immutable child marker and strict subagent controls", () => {
		const root = tempRoot();
		mkdirSync(join(root, "project"));
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"), {
			id: "agent-child-1",
			mode: "chat",
			subagent: { agentId: "agent-child-1", name: "researcher", parentSessionId: "parent-session-1" },
		});
		manager.appendSubagentControl({ type: "subagent_created", config: config() });

		expect(manager.getHeader()?.version).toBe(CURRENT_SESSION_VERSION);
		expect(manager.getHeader()?.subagent).toEqual({
			agentId: "agent-child-1",
			name: "researcher",
			parentSessionId: "parent-session-1",
		});
		expect(manager.getMode()).toBe("chat");
		expect(manager.getDurableJournalSnapshot().map((entry) => entry.type)).toContain("subagent_created");
		manager.close();
	});

	it("rejects unknown subagent controls", () => {
		expect(() =>
			parseSessionControlEntry({
				type: "subagent_unknown",
				id: "record-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
			}),
		).toThrow("Unknown session control entry type");
	});

	it("rejects subagent records under v6 and migrates ordinary v6 journals", () => {
		const root = tempRoot();
		const badPath = join(root, "bad.jsonl");
		const header = {
			type: "session",
			version: 6,
			id: "parent-session-1",
			timestamp: new Date(0).toISOString(),
			cwd: root,
			mode: "code",
			cwdOrigin: "user-selected",
			permissionMode: "auto",
			reviewerEnabled: true,
		};
		const created = {
			type: "subagent_created",
			id: "record-1",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			config: config(),
		};
		writeFileSync(badPath, `${JSON.stringify(header)}\n${JSON.stringify(created)}\n`);
		expect(() => SessionManager.open(badPath)).toThrow("Subagent control entries require a v7 session header");

		const goodPath = join(root, "good.jsonl");
		writeFileSync(goodPath, `${JSON.stringify(header)}\n`);
		const manager = SessionManager.open(goodPath);
		expect(manager.getHeader()?.version).toBe(7);
		manager.close();
		expect(JSON.parse(readFileSync(goodPath, "utf8").trim()).version).toBe(7);
	});
});
