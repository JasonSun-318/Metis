import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAgentTypeDefinitions, upsertCustomAgentType } from "../src/core/subagents/agent-type-registry.ts";
import { buildAgentTypeGuide, resolveAgentProfile } from "../src/core/subagents/profiles.ts";
import { buildAgentCoordinationPrompt, buildChildSystemPrompt } from "../src/core/subagents/prompts.ts";
import type { AgentConfig } from "../src/core/subagents/types.ts";

let agentDir: string;
let previousAgentDirEnv: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "metis-agent-type-resolution-"));
	mkdirSync(agentDir, { recursive: true });
	previousAgentDirEnv = process.env.METIS_CODING_AGENT_DIR;
	process.env.METIS_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDirEnv === undefined) delete process.env.METIS_CODING_AGENT_DIR;
	else process.env.METIS_CODING_AGENT_DIR = previousAgentDirEnv;
	rmSync(agentDir, { recursive: true, force: true });
});

function config(agentType: string): AgentConfig {
	return {
		agentId: "child",
		name: "Child",
		agentType: agentType as AgentConfig["agentType"],
		initialTask: "task",
		tools: ["read"],
		writePolicy: "deny",
		permissionPreset: "ask",
		model: { provider: "fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		cwd: "/work",
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: false,
		parentSessionId: "root",
		rootSessionId: "root",
		agentPath: ["child"],
	};
}

describe("definition-aware profiles", () => {
	it("resolves a custom definition and enforces the tool cap", () => {
		upsertCustomAgentType(agentDir, {
			id: "auditor",
			displayName: "Auditor",
			description: "Read-only audit role.",
			allowedTools: ["read", "bash"],
			systemPrompt: "",
			writePolicy: "deny",
			mayDelegate: false,
		});
		const definition = loadAgentTypeDefinitions(agentDir).auditor;
		expect(definition).toBeDefined();
		const profile = resolveAgentProfile({ definition: definition!, parentTools: ["read", "bash", "edit"], depth: 1 });
		expect(profile.tools).toEqual(["read", "bash"]);
		expect(profile.writePolicy).toBe("deny");
		expect(profile.mayDelegate).toBe(false);
	});

	it("treats an empty allowedTools cap as inherit-all and denies delegation below depth 2", () => {
		upsertCustomAgentType(agentDir, {
			id: "helper",
			displayName: "Helper",
			description: "General helper.",
			allowedTools: [],
			systemPrompt: "",
			writePolicy: "inherit",
			mayDelegate: true,
		});
		const definition = loadAgentTypeDefinitions(agentDir).helper;
		expect(definition).toBeDefined();
		expect(resolveAgentProfile({ definition: definition!, parentTools: ["read", "grep"], depth: 1 }).tools).toEqual([
			"read",
			"grep",
		]);
		expect(resolveAgentProfile({ definition: definition!, parentTools: ["read"], depth: 2 }).mayDelegate).toBe(false);
	});

	it("lists custom roles in the guide and injects custom system prompts", () => {
		upsertCustomAgentType(agentDir, {
			id: "auditor",
			displayName: "Auditor",
			description: "Read-only audit role.",
			allowedTools: ["read"],
			systemPrompt: "Always cite file paths.",
			writePolicy: "deny",
			mayDelegate: false,
		});
		expect(buildAgentTypeGuide(loadAgentTypeDefinitions(agentDir))).toContain("auditor:");
		const prompt = buildChildSystemPrompt(config("auditor"));
		expect(prompt).toContain("Read-only audit role.");
		expect(prompt).toContain("<agent_role_instructions>\nAlways cite file paths.\n</agent_role_instructions>");
	});

	it("falls back to the default purpose when a historical type is missing", () => {
		const prompt = buildChildSystemPrompt(config("deleted-role"));
		expect(prompt).toContain("General analysis and execution");
		expect(prompt).not.toContain("<agent_role_instructions>");
	});

	it("coordination prompt lists built-in and custom roles dynamically", () => {
		upsertCustomAgentType(agentDir, {
			id: "auditor",
			displayName: "Auditor",
			description: "Read-only audit role.",
			allowedTools: ["read"],
			systemPrompt: "",
			writePolicy: "deny",
			mayDelegate: false,
		});
		const prompt = buildAgentCoordinationPrompt(loadAgentTypeDefinitions(agentDir));
		expect(prompt).toContain("<agent_coordination>");
		expect(prompt).toContain("explorer:");
		expect(prompt).toContain("auditor:");
	});
});
