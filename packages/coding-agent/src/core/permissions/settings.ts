import type { ApprovalPolicy, PermissionPreset, PermissionSettings, SandboxPolicy } from "./types.ts";

const ASK_SETTINGS = Object.freeze({ sandboxPolicy: "workspace-write", approvalPolicy: "user" } as const);
const AUTO_SETTINGS = Object.freeze({ sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" } as const);
const FULL_SETTINGS = Object.freeze({ sandboxPolicy: "danger-full-access", approvalPolicy: "user" } as const);

export const PERMISSION_PRESETS: Readonly<Record<PermissionPreset, PermissionSettings>> = Object.freeze({
	ask: ASK_SETTINGS,
	auto: AUTO_SETTINGS,
	full: FULL_SETTINGS,
});

const SANDBOX_RANK: Readonly<Record<Exclude<SandboxPolicy, "external-sandbox">, number>> = Object.freeze({
	"read-only": 0,
	"workspace-write": 1,
	"danger-full-access": 2,
});

const APPROVAL_RANK: Readonly<Record<ApprovalPolicy, number>> = Object.freeze({
	deny: 0,
	user: 1,
	"auto-review": 2,
});

export function settingsForPreset(preset: PermissionPreset): PermissionSettings {
	return PERMISSION_PRESETS[preset];
}

function intersectSandboxPolicy(left: SandboxPolicy, right: SandboxPolicy): SandboxPolicy {
	if (left === right) return left;
	if (left === "external-sandbox" || right === "external-sandbox") return "read-only";
	return SANDBOX_RANK[left] <= SANDBOX_RANK[right] ? left : right;
}

function intersectApprovalPolicy(left: ApprovalPolicy, right: ApprovalPolicy): ApprovalPolicy {
	return APPROVAL_RANK[left] <= APPROVAL_RANK[right] ? left : right;
}

export function intersectPermissionSettings(left: PermissionSettings, right: PermissionSettings): PermissionSettings {
	return Object.freeze({
		sandboxPolicy: intersectSandboxPolicy(left.sandboxPolicy, right.sandboxPolicy),
		approvalPolicy: intersectApprovalPolicy(left.approvalPolicy, right.approvalPolicy),
	});
}
