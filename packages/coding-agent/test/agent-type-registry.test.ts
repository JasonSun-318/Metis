import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILT_IN_AGENT_TYPE_IDS,
	loadAgentTypeDefinitions,
	MAX_CUSTOM_AGENT_TYPES,
	readCustomAgentTypes,
	removeCustomAgentType,
	upsertCustomAgentType,
} from "../src/core/subagents/agent-type-registry.ts";

const custom = {
	id: "code-reviewer",
	displayName: "Code Reviewer",
	description: "Reviews diffs and runs read-only checks.",
	allowedTools: ["read", "grep"],
	systemPrompt: "Be terse. Cite file:line for every finding.",
	writePolicy: "deny",
	mayDelegate: false,
} as const;

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "metis-agent-types-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("agent type registry", () => {
	it("roundtrips a custom type and lists it after built-ins", () => {
		upsertCustomAgentType(agentDir, { ...custom });
		const stored = readCustomAgentTypes(agentDir);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ id: "code-reviewer", mayDelegate: false });

		const definitions = loadAgentTypeDefinitions(agentDir);
		expect(Object.keys(definitions).slice(0, 4)).toEqual([...BUILT_IN_AGENT_TYPE_IDS]);
		expect(definitions["code-reviewer"]).toMatchObject({
			purpose: custom.description,
			allowedTools: ["read", "grep"],
			writePolicy: "deny",
			mayDelegate: false,
		});
	});

	it("rejects built-in ids, bad slugs, and exceeding the type cap", () => {
		expect(() => upsertCustomAgentType(agentDir, { ...custom, id: "explorer" })).toThrow(/built-in/i);
		expect(() => upsertCustomAgentType(agentDir, { ...custom, id: "Bad_Slug" })).toThrow(/id/i);
		for (let index = 0; index < MAX_CUSTOM_AGENT_TYPES; index += 1) {
			upsertCustomAgentType(agentDir, { ...custom, id: `type-${index}` });
		}
		expect(() => upsertCustomAgentType(agentDir, { ...custom, id: "one-too-many" })).toThrow(/16/);
	});

	it("validates field limits and byte budget", () => {
		expect(() => upsertCustomAgentType(agentDir, { ...custom, displayName: "" })).toThrow(/displayName/i);
		expect(() => upsertCustomAgentType(agentDir, { ...custom, description: "x".repeat(513) })).toThrow(
			/description/i,
		);
		expect(() => upsertCustomAgentType(agentDir, { ...custom, systemPrompt: "字".repeat(8193) })).toThrow(
			/systemPrompt/i,
		);
		expect(() => upsertCustomAgentType(agentDir, { ...custom, allowedTools: ["a".repeat(65)] })).toThrow(
			/allowedTools/i,
		);
	});

	it("updates an existing id in place instead of duplicating it", () => {
		upsertCustomAgentType(agentDir, { ...custom });
		upsertCustomAgentType(agentDir, { ...custom, displayName: "Renamed" });
		const stored = readCustomAgentTypes(agentDir);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.displayName).toBe("Renamed");
	});

	it("removes a type, protects built-ins, and skips corrupt entries on read", () => {
		upsertCustomAgentType(agentDir, { ...custom });
		removeCustomAgentType(agentDir, "code-reviewer");
		expect(readCustomAgentTypes(agentDir)).toHaveLength(0);
		expect(() => removeCustomAgentType(agentDir, "default")).toThrow(/built-in/i);
		expect(() => removeCustomAgentType(agentDir, "missing")).toThrow(/unknown/i);

		const file = join(agentDir, "agent-types.json");
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { types: unknown[] };
		writeFileSync(file, JSON.stringify({ version: 1, types: [...parsed.types, { id: "BROKEN" }] }));
		expect(readCustomAgentTypes(agentDir)).toHaveLength(0);
	});

	it("returns no custom types when the file is missing", () => {
		mkdirSync(agentDir, { recursive: true });
		expect(readCustomAgentTypes(agentDir)).toHaveLength(0);
	});
});
