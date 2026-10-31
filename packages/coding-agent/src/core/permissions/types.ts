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

/** Disposition assigned by the trusted shell analyzer. */
export type ShellAnalysisDisposition = "safe" | "review" | "user" | "deny";

/**
 * One executable command node of the analyzed shell AST. Produced only by the
 * builtin trusted analyzer; argv words are exact evaluated text with no
 * expansion left, so policies may match configured rule prefixes per node.
 */
export interface ShellCommandTraceEntry {
	readonly argv: readonly string[];
	/** False when any argv word was dynamic or a glob, so the entry cannot be matched exactly. */
	readonly complete: boolean;
	readonly disposition: ShellAnalysisDisposition;
	readonly effects: readonly PermissionEffect[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
	/**
	 * AST node kind for the two structural rules that have no executable argv:
	 * `[[ … ]]` conditions and side-effect-free variable assignments.
	 */
	readonly structural?: "test" | "assignment";
}

/** Aggregate result of the trusted shell analyzer bound to a builtin bash action. */
export interface ShellAnalysisFacts {
	readonly disposition: ShellAnalysisDisposition;
	readonly complete: boolean;
	readonly commands: readonly ShellCommandTraceEntry[];
	/**
	 * Exact read targets proven by the analyzer. Unlike the action's `readPaths`
	 * these exclude the workspace roots the adapter merges in for grants, so a
	 * directory-scoped rule can judge what the command really reads.
	 */
	readonly readPaths?: readonly string[];
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
	readonly shellAnalysis?: ShellAnalysisFacts;
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
	readonly shellAnalysis?: ShellAnalysisFacts;
}

export interface GrantRequest {
	readonly executionTarget: "sandbox" | "host" | "external";
	readonly readRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly protectedRoots: readonly string[];
	readonly networkEndpoints: readonly NetworkEndpoint[];
}

export interface MatchedPermissionRuleDetail {
	readonly id: string;
	readonly name: string;
	readonly scope: string;
}

export type PermissionPolicyDecision =
	| {
			readonly kind: "allow";
			readonly riskLevel: RiskLevel;
			readonly reason: string;
			readonly grant: GrantRequest;
			readonly ruleIds?: readonly string[];
			readonly matchedRule?: MatchedPermissionRuleDetail;
	  }
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
