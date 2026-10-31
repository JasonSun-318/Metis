import { beforeAll, describe, expect, it } from "vitest";
import type { AutoCommandRule } from "../../src/core/permissions/auto-command-rules.ts";
import { normalizePermissionAction } from "../../src/core/permissions/normalize.ts";
import { PermissionPolicy } from "../../src/core/permissions/policy.ts";
import { settingsForPreset } from "../../src/core/permissions/settings.ts";
import { analyzeShellCommand } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { actionInput } from "./fixtures.ts";

beforeAll(initializeShellAnalysis);

const endpoint = { hostname: "api.example.com", port: 443 };
const analyze = (command: string) =>
	analyzeShellCommand({
		command,
		cwd: process.cwd(),
		workspaceRoots: [process.cwd()],
		shellPath: "/bin/bash",
	});
function evaluate(command: string, rules: readonly AutoCommandRule[]) {
	const analysis = analyze(command);
	const action = normalizePermissionAction(
		actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			command,
			args: { command },
			cwd: process.cwd(),
			workspaceRoots: [process.cwd()],
			readPaths: analysis.readPaths,
			writePaths: analysis.writePaths,
			networkEndpoints: analysis.networkEndpoints,
			effects: analysis.effects,
			shellAnalysis: { disposition: analysis.disposition, complete: analysis.complete, commands: analysis.commands },
		}),
	);
	return new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action, autoCommandRules: rules });
}

describe("independent Auto network rule boundaries", () => {
	it("does not allow networking when a rule retains targets but its network flag is off", () => {
		expect(
			evaluate("curl -q https://api.example.com", [
				{
					command: "curl",
					allowNetwork: false,
					networkTargets: [endpoint],
				},
			]),
		).toMatchObject({ kind: "review", minimumReviewer: "model" });
	});

	it("records repeated destinations on each command instead of subtracting aggregate endpoints", () => {
		const analysis = analyze("curl -q --head https://api.example.com && curl -q https://api.example.com");
		expect(analysis.commands).toHaveLength(2);
		expect(analysis.commands[0]?.networkEndpoints).toEqual([endpoint]);
		expect(analysis.commands[1]?.networkEndpoints).toEqual([endpoint]);
	});

	it("does not let an allowed HEAD request authorize a later GET using a non-network rule", () => {
		expect(
			evaluate("curl -q --head https://api.example.com && curl -q https://api.example.com", [
				{ command: "curl -q --head", allowNetwork: true, networkTargets: [endpoint] },
				{ command: "curl", allowNetwork: false },
			]),
		).toMatchObject({ kind: "review", minimumReviewer: "model" });
	});
});
