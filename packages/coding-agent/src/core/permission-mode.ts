export type PermissionMode = "ask" | "full";
export type PersistedPermissionMode = PermissionMode | "auto";

export interface PermissionSettings {
	readonly mode: PermissionMode;
}

export function defaultPermissionSettings(): PermissionSettings {
	return { mode: "ask" };
}

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === "ask" || value === "full";
}

export function isPersistedPermissionMode(value: unknown): value is PersistedPermissionMode {
	return value === "ask" || value === "auto" || value === "full";
}

export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
	if (value === "auto") return "ask";
	return isPermissionMode(value) ? value : undefined;
}

export function narrowPermissionMode(left: PermissionMode, right: PermissionMode): PermissionMode {
	return left === "ask" || right === "ask" ? "ask" : "full";
}
