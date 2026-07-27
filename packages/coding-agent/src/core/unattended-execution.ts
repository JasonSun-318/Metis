import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalizeActionPath, isPathInside } from "../utils/paths.ts";
import { classifyAction, type PermissionAction, type PermissionAuthorization } from "./permission-policy.ts";
import type { BashOperations } from "./tools/bash.ts";

export const UNATTENDED_TOOL_NAMES = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"write",
	"edit",
	"bash",
	"web_fetch",
	"web_search",
]);

const STRUCTURED_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit"]);
const HOST_NETWORK_TOOLS = new Set(["web_fetch", "web_search"]);

export interface UnattendedExecutionProfile {
	readonly kind: "workspace-write";
	readonly workspaceRoots: readonly string[];
	readonly bashOperations: BashOperations;
}

export function createUnattendedExecutionProfile(input: {
	readonly workspaceRoots: readonly string[];
	readonly bashOperations: BashOperations;
}): UnattendedExecutionProfile {
	if (input.workspaceRoots.length === 0) throw new TypeError("Unattended execution requires a workspace root");
	if (input.workspaceRoots.some((root) => !isAbsolute(root))) {
		throw new TypeError("Unattended workspace roots must be absolute");
	}
	const workspaceRoots = Object.freeze([
		...new Set(input.workspaceRoots.map((root) => canonicalizeActionPath(root, root))),
	]);
	return Object.freeze({ kind: "workspace-write" as const, workspaceRoots, bashOperations: input.bashOperations });
}

function isAllowed(profile: UnattendedExecutionProfile, action: PermissionAction): boolean {
	if (action.provenance !== "builtin") return false;
	if (action.toolName === "bash") return !action.risks.includes("elevation");
	if (HOST_NETWORK_TOOLS.has(action.toolName)) return action.risks.every((risk) => risk === "network");
	if (!STRUCTURED_TOOLS.has(action.toolName)) return false;
	if (action.risks.some((risk) => risk !== "ordinary-read" && risk !== "workspace-write")) return false;
	return (
		action.paths.length > 0 &&
		action.paths.every((path) => profile.workspaceRoots.some((root) => isPathInside(root, path)))
	);
}

export function authorizeUnattendedAction(input: {
	readonly profile: UnattendedExecutionProfile;
	readonly action: PermissionAction;
	readonly args: unknown;
	readonly cwd: string;
}): PermissionAuthorization {
	return isAllowed(input.profile, input.action)
		? {
				decision: "allow",
				source: "automatic",
				reason: "Allowed by unattended workspace-write policy",
				action: input.action,
			}
		: {
				decision: "deny",
				source: "fallback",
				reason: "Denied by unattended workspace-write policy",
				action: input.action,
			};
}

export function revalidateUnattendedAction(input: {
	readonly profile: UnattendedExecutionProfile;
	readonly authorized: PermissionAction;
	readonly toolName: string;
	readonly args: unknown;
	readonly cwd: string;
}): PermissionAction {
	const current = classifyAction({
		actionId: input.authorized.actionId,
		toolName: input.toolName,
		provenance: "builtin",
		args: input.args,
		cwd: input.cwd,
		workspaceRoots: input.profile.workspaceRoots,
		builtinNetworkTargets: input.authorized.networkTargets,
	});
	if (!isDeepStrictEqual(current, input.authorized) || !isAllowed(input.profile, current)) {
		throw new Error("Operation changed or resolved outside the unattended workspace");
	}
	return current;
}
