import type { ApprovalPolicy, PermissionPreset, PermissionSettings, SandboxPolicy } from "./types.ts";

export type { PermissionPreset, PermissionSettings };

const ASK_SETTINGS = Object.freeze({ sandboxPolicy: "workspace-write", approvalPolicy: "user" } as const);
const AUTO_SETTINGS = Object.freeze({ sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" } as const);
const FULL_SETTINGS = Object.freeze({ sandboxPolicy: "danger-full-access", approvalPolicy: "never" } as const);

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
	never: 3,
});

const SANDBOX_POLICIES: readonly SandboxPolicy[] = [
	"read-only",
	"workspace-write",
	"danger-full-access",
	"external-sandbox",
];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["deny", "user", "auto-review", "never"];

export function isFullAccess(settings: PermissionSettings): boolean {
	return settings.sandboxPolicy === "danger-full-access" && settings.approvalPolicy === "never";
}

export const DEFAULT_PERMISSION_PRESET: PermissionPreset = "auto";

export function isPermissionPreset(value: unknown): value is PermissionPreset {
	return value === "ask" || value === "auto" || value === "full";
}

export function assertPermissionSettings(settings: PermissionSettings): void {
	if (
		!settings ||
		typeof settings !== "object" ||
		!SANDBOX_POLICIES.includes(settings.sandboxPolicy) ||
		!APPROVAL_POLICIES.includes(settings.approvalPolicy)
	) {
		throw new TypeError("Permission settings are invalid");
	}
}

export function settingsForPreset(preset: PermissionPreset): PermissionSettings {
	if (!Object.hasOwn(PERMISSION_PRESETS, preset)) throw new TypeError("Permission preset is invalid");
	const settings = PERMISSION_PRESETS[preset];
	return settings;
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
	assertPermissionSettings(left);
	assertPermissionSettings(right);
	return Object.freeze({
		sandboxPolicy: intersectSandboxPolicy(left.sandboxPolicy, right.sandboxPolicy),
		approvalPolicy: intersectApprovalPolicy(left.approvalPolicy, right.approvalPolicy),
	});
}
