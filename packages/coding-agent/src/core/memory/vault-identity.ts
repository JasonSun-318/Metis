import { isSafeSlug, type MemoryScope, type MemoryTarget, targetKey } from "./vault-types.ts";

/** Project keys must be single safe path segments: no separators, dots, or escapes. */
export function isSafeProjectKey(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

/** Durable identity of a scope: `global` or `projects/<projectKey>`. */
export function memoryScopeKey(scope: MemoryScope, projectKey?: string): string {
	if (scope === "global") return "global";
	if (!projectKey || !isSafeProjectKey(projectKey)) {
		throw new TypeError("valid projectKey required");
	}
	return `projects/${projectKey}`;
}

/** Unique identity of a write target across scopes and projects. */
export function memoryTargetId(scope: MemoryScope, target: MemoryTarget, projectKey?: string): string {
	return `${memoryScopeKey(scope, projectKey)}/${targetKey(target)}`;
}

/** Usage-map key for a note: `global/notes/<slug>` or `projects/<key>/notes/<slug>`. */
export function memoryUsageKey(scope: MemoryScope, slug: string, projectKey?: string): string {
	if (!isSafeSlug(slug)) throw new TypeError("invalid memory slug");
	return `${memoryScopeKey(scope, projectKey)}/notes/${slug}`;
}
