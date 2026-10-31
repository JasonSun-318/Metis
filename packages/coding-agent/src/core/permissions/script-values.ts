import type { ShellCommandAnalysis } from "./shell-analysis.ts";

/**
 * Static value model shared by the inline-script traversal and the per-language
 * call semantics. `unknown` means the traversal could not prove the value.
 */
export type ScriptValue =
	| { readonly kind: "static"; readonly value?: string }
	| { readonly kind: "string" }
	| { readonly kind: "bytes" }
	| { readonly kind: "file"; readonly path: string; readonly mode: "read" | "write" }
	| { readonly kind: "path"; readonly value: string }
	| { readonly kind: "module"; readonly name: string }
	| { readonly kind: "unknown" };

export const UNKNOWN: ScriptValue = { kind: "unknown" };
export const STATIC: ScriptValue = { kind: "static" };

export function staticText(value: ScriptValue): string | undefined {
	return value.kind === "static" ? value.value : undefined;
}

export function isUnknown(value: ScriptValue): boolean {
	return value.kind === "unknown";
}

export interface ArgumentList {
	readonly positionals: readonly ScriptValue[];
	readonly keywords: ReadonlyMap<string, ScriptValue>;
	readonly splat: boolean;
}

export const EMPTY_ARGUMENTS: ArgumentList = { positionals: [], keywords: new Map(), splat: false };

/** Fact-recording surface the per-language call semantics operate over. */
export interface ScriptSemanticsContext {
	readonly currentDirectory: string;
	mark(disposition: ShellCommandAnalysis["disposition"], reason: string, complete?: boolean): void;
	recordRead(rawPath: string, traversal: boolean): void;
	recordWrite(rawPath: string, destructive?: boolean): void;
	callModule(qualifiedName: string, args: ArgumentList, vars: Map<string, ScriptValue>): ScriptValue;
}
