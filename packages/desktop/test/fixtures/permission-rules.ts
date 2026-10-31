import type { ClientResult, PermissionRuleView } from "@metis/app-protocol";

export type TestPermissionRuleView = PermissionRuleView;

export function makeRuleView(
	input: Pick<TestPermissionRuleView, "id" | "name"> & Partial<TestPermissionRuleView>,
): TestPermissionRuleView {
	return {
		kind: "command",
		origin: input.id.startsWith("user-") ? "user" : "default",
		enabled: true,
		modes: ["auto"],
		scope: "workspace",
		directories: [],
		command: input.name,
		allowNetwork: false,
		support: "supported",
		...input,
	};
}

export function autoSettingsView(
	permissionRules: readonly TestPermissionRuleView[],
	permissionRuleDefaults: readonly TestPermissionRuleView[] = [],
	reviewerEnabled = false,
) {
	return {
		reviewerEnabled,
		rules: [],
		suggestions: [],
		permissionRules,
		permissionRuleDefaults,
	};
}

export function makeRememberedRule(input: {
	readonly id: string;
	readonly decision: "allow" | "deny";
	readonly command?: string;
	readonly toolName?: string;
	readonly paths?: readonly string[];
	readonly details?: readonly { readonly label: string; readonly value: string }[];
}) {
	return {
		id: input.id,
		decision: input.decision,
		toolName: input.toolName ?? "bash",
		...(input.command ? { command: input.command } : {}),
		paths: [...(input.paths ?? [])],
		details: [...(input.command ? [{ label: "Command", value: input.command }] : []), ...(input.details ?? [])],
		omittedDetails: 0,
		risks: ["low"],
		executionTarget: "sandbox" as const,
		createdAt: "2026-10-29T12:00:00.000Z",
	};
}

type RememberedGroup = ClientResult<"permission/rules/catalog">["groups"][number];

export function rememberedCatalog(groups: readonly RememberedGroup[]): ClientResult<"permission/rules/catalog"> {
	return { groups: [...groups] };
}

/** The server strips view-only fields on write and derives support again on read. */
export function acceptedRules(input: readonly Record<string, unknown>[]): TestPermissionRuleView[] {
	return input.map((rule) => {
		const base = rule as unknown as Partial<TestPermissionRuleView>;
		return {
			...(base as TestPermissionRuleView),
			support: base.support === "legacy-unsupported" ? "legacy-unsupported" : "supported",
		};
	});
}
