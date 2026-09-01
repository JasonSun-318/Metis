import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ToolPermissionClaim, ToolPermissionContext } from "../extensions/types.ts";
import { isSensitivePath } from "../permissions/sensitive-paths.ts";
import { exactNetworkEndpoint, permissionClaim } from "../tool-permission-adapter.ts";

const PATH_KEYS = new Set(["file", "filepath", "filename", "path", "paths"]);
const URL_KEYS = new Set(["endpoint", "uri", "url", "urls"]);
const SIDE_EFFECT_KEYS = new Set([
	"amount",
	"body",
	"command",
	"content",
	"delete",
	"email",
	"message",
	"payment",
	"recipient",
	"script",
	"sql",
	"to",
]);
const MAX_VALUES = 4_096;

function normalizedKey(key: string): string {
	return key.toLowerCase().replaceAll(/[_-]/gu, "");
}

export interface McpPermissionAdapterInput {
	readonly annotations: ToolAnnotations | undefined;
	readonly params: unknown;
	readonly context: ToolPermissionContext;
}

interface DerivedScope {
	readonly paths: string[];
	readonly endpoints: Array<{ hostname: string; port: number }>;
	readonly boundedTargets: number;
	readonly sideEffectShaped: boolean;
	readonly incomplete: boolean;
}

function strings(value: unknown): string[] | undefined {
	if (typeof value === "string") return value.trim() ? [value] : undefined;
	if (!Array.isArray(value) || value.length > MAX_VALUES) return undefined;
	const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	return values.length === value.length ? values : undefined;
}

function deriveScope(params: unknown): DerivedScope {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		return { paths: [], endpoints: [], boundedTargets: 0, sideEffectShaped: false, incomplete: true };
	}
	const paths: string[] = [];
	const endpoints: Array<{ hostname: string; port: number }> = [];
	let sideEffectShaped = false;
	let incomplete = false;
	let boundedTargets = 0;
	let visited = 0;
	const visit = (value: unknown, key = "", depth = 0): void => {
		const semanticKey = normalizedKey(key);
		visited += 1;
		if (visited > MAX_VALUES || depth > 8) {
			incomplete = true;
			return;
		}
		if (SIDE_EFFECT_KEYS.has(semanticKey)) sideEffectShaped = true;
		if (PATH_KEYS.has(semanticKey)) {
			const values = strings(value);
			if (!values || values.some((item) => /[*?[\]]/u.test(item))) incomplete = true;
			else {
				paths.push(...values);
				boundedTargets += values.length;
			}
			return;
		}
		if (URL_KEYS.has(semanticKey)) {
			const values = strings(value);
			if (!values) {
				incomplete = true;
				return;
			}
			for (const item of values) {
				try {
					const url = new URL(item);
					if (url.protocol === "file:") paths.push(url.pathname);
					else if (url.protocol === "http:" || url.protocol === "https:")
						endpoints.push(exactNetworkEndpoint(url));
					else if (!url.protocol || (!url.hostname && !url.pathname))
						throw new TypeError("Opaque MCP URI is incomplete");
					boundedTargets += 1;
				} catch {
					incomplete = true;
				}
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, key, depth + 1);
			return;
		}
		if (value && typeof value === "object") {
			for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
				visit(child, childKey, depth + 1);
			}
			return;
		}
		if (
			semanticKey &&
			!SIDE_EFFECT_KEYS.has(semanticKey) &&
			((typeof value === "string" && value.trim().length > 0) ||
				typeof value === "number" ||
				typeof value === "boolean")
		) {
			boundedTargets += 1;
		}
	};
	visit(params);
	return { paths, endpoints, boundedTargets, sideEffectShaped, incomplete };
}

export function adaptMcpPermissionClaim(input: McpPermissionAdapterInput): ToolPermissionClaim {
	const scope = deriveScope(input.params);
	const annotations = input.annotations;
	const readOnly = annotations?.readOnlyHint === true;
	const destructive = annotations?.destructiveHint === true;
	const closedWorld = annotations?.openWorldHint === false;
	const conflicting = readOnly && destructive;
	const incomplete = scope.incomplete || scope.boundedTargets === 0 || conflicting;
	const exactReadOnly =
		readOnly && annotations?.destructiveHint === false && closedWorld && !scope.sideEffectShaped && !incomplete;
	const exactMutation =
		annotations?.readOnlyHint === false &&
		typeof annotations.destructiveHint === "boolean" &&
		closedWorld &&
		!incomplete;
	const effects = new Set<ToolPermissionClaim["effects"][number]>();
	if (
		readOnly &&
		scope.paths.some((path) => isSensitivePath(path, input.context.cwd, false, input.context.workspaceRoots))
	) {
		effects.add("sensitive-read");
	}

	if (destructive) {
		effects.add("destructive");
		effects.add("external-side-effect");
	}
	if (!exactReadOnly) effects.add("external-side-effect");
	if (!exactReadOnly && !exactMutation) effects.add("unknown");

	return permissionClaim({
		readPaths: readOnly ? scope.paths : [],
		writePaths: readOnly ? [] : scope.paths,
		networkEndpoints: scope.endpoints,
		effects: [...effects],
	});
}
