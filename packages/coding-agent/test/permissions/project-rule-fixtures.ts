import { digestCanonical, digestPermissionAction, type RiskLevel } from "../../src/core/permissions/index.ts";
import { projectDir, workspaceWrite } from "./fixtures.ts";

export interface RuleInput {
	readonly projectPath: string;
	readonly actionDigest: string;
	readonly grantDigest: string;
	readonly toolName: string;
	readonly toolIdentity: string;
	readonly riskLevel: RiskLevel;
	readonly summary: readonly { readonly label: string; readonly value: string }[];
}

const action = workspaceWrite();

export function ruleInput(overrides: Partial<RuleInput> = {}): RuleInput {
	return {
		projectPath: projectDir,
		actionDigest: digestPermissionAction(action),
		grantDigest: digestCanonical({
			executionTarget: "sandbox",
			readRoots: action.readPaths,
			writeRoots: action.writePaths,
			networkEndpoints: action.networkEndpoints,
		}),
		toolName: action.toolName,
		toolIdentity: action.toolIdentity,
		riskLevel: "low",
		summary: [{ label: "Path", value: action.writePaths[0] ?? "unknown" }],
		...overrides,
	};
}
