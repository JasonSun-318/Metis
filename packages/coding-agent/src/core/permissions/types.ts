export type PermissionPreset = "ask" | "auto" | "full";
export type SandboxPolicy = "read-only" | "workspace-write" | "danger-full-access" | "external-sandbox";
export type ApprovalPolicy = "user" | "auto-review" | "deny" | "never";
export type MinimumReviewer = "model" | "user";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ToolProvenance = "builtin" | "host" | "extension" | "sdk" | "mcp";
export type PermissionEffect =
	| "sensitive-read"
	| "external-side-effect"
	| "destructive"
	| "elevation"
	| "security-weakening"
	| "payment"
	| "production-mutation"
	| "unknown";

export interface PermissionSettings {
	readonly sandboxPolicy: SandboxPolicy;
	readonly approvalPolicy: ApprovalPolicy;
}

export interface NetworkEndpoint {
	readonly hostname: string;
	readonly port: number;
}

export interface NormalizePermissionActionInput {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly toolIdentity: string;
	readonly args: unknown;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readPaths: readonly string[];
	readonly writePaths: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
	readonly command?: string;
	readonly effects: readonly PermissionEffect[];
}

export interface NormalizedPermissionAction {
	readonly actionId: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly toolIdentity: string;
	readonly argsDigest: string;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly readPaths: readonly string[];
	readonly writePaths: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
	readonly command?: string;
	readonly effects: readonly PermissionEffect[];
}

export interface GrantRequest {
	readonly executionTarget: "sandbox" | "host" | "external";
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly protectedRoots: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
}

export type PermissionPolicyDecision =
	| { readonly kind: "allow"; readonly riskLevel: RiskLevel; readonly reason: string; readonly grant: GrantRequest }
	| {
			readonly kind: "review";
			readonly riskLevel: RiskLevel;
			readonly minimumReviewer: MinimumReviewer;
			readonly reason: string;
			readonly grant: GrantRequest;
	  }
	| { readonly kind: "deny"; readonly riskLevel: RiskLevel; readonly reason: string };

export interface ExecutionGrant extends GrantRequest {
	readonly grantId: string;
	readonly actionId: string;
	readonly actionDigest: string;
	readonly toolName: string;
	readonly toolIdentity: string;
	readonly argsDigest: string;
	readonly command?: string;
	readonly cwd: string;
	readonly workspaceRoots: readonly string[];
	readonly settingsEpoch: number;
	readonly issuedAt: string;
	readonly expiresAt: string;
}
