export type PermissionMode = "ask" | "auto" | "full";
export type PersistedPermissionMode = PermissionMode;

const PERMISSION_RANK: Record<PermissionMode, number> = {
	ask: 0,
	auto: 1,
	full: 2,
};

export interface PermissionSettings {
	readonly mode: PermissionMode;
}

export function defaultPermissionSettings(): PermissionSettings {
	return { mode: "auto" };
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "ask" || value === "auto" || value === "full";
}

export const isPersistedPermissionMode = isPermissionMode;

export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	return isPermissionMode(value) ? value : undefined;
}

export function narrowPermissionMode(left: PermissionMode, right: PermissionMode): PermissionMode {
	return PERMISSION_RANK[left] <= PERMISSION_RANK[right] ? left : right;
}
