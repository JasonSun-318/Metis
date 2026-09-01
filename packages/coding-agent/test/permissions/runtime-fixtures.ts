import type {
	ExecutionGrantConsumeInput,
	ExecutionGrantIssueInput,
	PermissionAuditEventInput,
	PermissionExecutionRequest,
	PermissionSettings,
} from "../../src/core/permissions/index.ts";
import { externalWrite, ordinaryRead, projectDir, workspaceWrite } from "./fixtures.ts";

export function issueInput(overrides: Partial<ExecutionGrantIssueInput> = {}): ExecutionGrantIssueInput {
	const action = workspaceWrite();
	return {
		action,
		grant: {
			executionTarget: "sandbox",
			readRoots: action.readPaths,
			writeRoots: action.writePaths,
			protectedRoots: [],
			networkEndpoints: action.networkEndpoints,
		},
		settingsEpoch: 1,
		...overrides,
	};
}

export function consumeInput(overrides: Partial<ExecutionGrantConsumeInput> = {}): ExecutionGrantConsumeInput {
	const issued = issueInput();
	return {
		action: issued.action,
		settingsEpoch: issued.settingsEpoch,
		executionTarget: issued.grant.executionTarget,
		...overrides,
	};
}

export function changedValue(field: string): unknown {
	return {
		toolIdentity: "builtin:write_file:v2",
		argsDigest: "a".repeat(64),
		cwd: `${projectDir}/changed-cwd`,
		workspaceRoots: [`${projectDir}/changed-root`],
		settingsEpoch: 2,
		executionTarget: "host",
	}[field];
}

export function auditInputWithSecrets(): PermissionAuditEventInput & {
	readonly rawArguments: unknown;
	readonly reviewerPrompt: string;
} {
	return {
		eventId: "event-1",
		sessionId: "session-1",
		actionId: "action-1",
		actionDigest: "a".repeat(64),
		toolName: "write_file",
		provenance: "builtin",
		riskLevel: "medium",
		stage: "decision",
		outcome: "allow",
		executionTarget: "sandbox",
		reasonCode: "policy.allow",
		timestamp: "2026-09-01T00:00:00.000Z",
		rawArguments: { token: "secret-value", image: "base64-payload" },
		reviewerPrompt: "reviewer prompt with secret-value",
	};
}

interface RequestOverrides {
	readonly action?: PermissionExecutionRequest<string>["action"];
	readonly args?: unknown;
	readonly settings?: PermissionSettings;
	readonly trustedUserMessages?: PermissionExecutionRequest<string>["trustedUserMessages"];
	readonly interactive?: boolean;
	readonly signal?: AbortSignal;
	readonly execute?: PermissionExecutionRequest<string>["execute"];
}

function executionRequest(
	action: PermissionExecutionRequest<string>["action"],
	overrides: RequestOverrides = {},
): PermissionExecutionRequest<string> {
	return {
		action: overrides.action ?? action,
		args: overrides.args ?? { path: `${projectDir}/README.md` },
		settings: overrides.settings ?? { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
		trustedUserMessages: overrides.trustedUserMessages ?? [
			{ messageId: "user-1", text: "Perform this exact requested action." },
		],
		interactive: overrides.interactive ?? true,
		signal: overrides.signal ?? new AbortController().signal,
		execute: overrides.execute ?? (async () => "executed"),
	};
}

export function safeRequest(overrides: RequestOverrides = {}): PermissionExecutionRequest<string> {
	return executionRequest(ordinaryRead(), overrides);
}

export function highRiskRequest(overrides: RequestOverrides = {}): PermissionExecutionRequest<string> {
	return executionRequest(externalWrite(), overrides);
}

export function reviewRequest(
	onReview: () => void,
	overrides: RequestOverrides = {},
): { readonly request: PermissionExecutionRequest<string>; readonly onReview: () => void } {
	return Object.freeze({ request: highRiskRequest(overrides), onReview });
}
