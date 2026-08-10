import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@metis/agent-core";
import { Text } from "@metis/tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import type { ToolSubprocessExecutor, WrappedToolSubprocess } from "./subprocess.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const DEFAULT_LIMIT = 100;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "Number of matches to skip before returning results (default: 0)" }),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: DEFAULT_LIMIT,
			description: "Maximum number of matches to return (default: 100, max: 100)",
		}),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	nextOffset?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
	/** Session permission/sandbox boundary for the built-in rg subprocess. */
	subprocess?: ToolSubprocessExecutor;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; offset?: number; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (args?.offset !== undefined) text += theme.fg("toolOutput", ` offset ${args.offset}`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const subprocess = options?.subprocess;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Use offset and limit to page through results. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		async execute(
			toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				offset,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				offset?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveOffset = offset ?? 0;
						const effectiveLimit = Math.min(DEFAULT_LIMIT, Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)));
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						// ponytail: sorted offset pages rescan from the start; add snapshots only if deep-page latency matters.
						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden", "--sort=path"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const runChild = async ({
							argv,
							env,
							signal: wrappedSignal,
						}: WrappedToolSubprocess): Promise<void> => {
							const commandSignal = wrappedSignal ?? signal;
							const child = spawn(argv[0]!, argv.slice(1), {
								cwd,
								env,
								stdio: ["ignore", "pipe", "pipe"],
							});
							const rl = createInterface({ input: child.stdout });
							let stderr = "";
							let seenMatchCount = 0;
							let matchCount = 0;
							let matchLimitReached = false;
							let linesTruncated = false;
							let aborted = false;
							let killedDueToLimit = false;
							const outputLines: string[] = [];

							const cleanup = () => {
								rl.close();
								commandSignal?.removeEventListener("abort", onAbort);
							};
							const stopChild = (dueToLimit = false) => {
								if (!child.killed) {
									killedDueToLimit = dueToLimit;
									child.kill();
								}
							};
							const onAbort = () => {
								aborted = true;
								stopChild();
							};
							commandSignal?.addEventListener("abort", onAbort, { once: true });
							child.stderr?.on("data", (chunk) => {
								stderr += chunk.toString();
							});

							const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
								const relativePath = formatPath(filePath);
								const lines = await getFileLines(filePath);
								if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
								const block: string[] = [];
								const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
								const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
								for (let current = start; current <= end; current++) {
									const lineText = lines[current - 1] ?? "";
									const sanitized = lineText.replace(/\r/g, "");
									const isMatchLine = current === lineNumber;
									// Truncate long lines so grep output stays compact.
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
									else block.push(`${relativePath}-${current}- ${truncatedText}`);
								}
								return block;
							};

							// Collect matches during streaming, then format them after rg exits.
							const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
							rl.on("line", (line) => {
								if (!line.trim()) return;
								let event: any;
								try {
									event = JSON.parse(line);
								} catch {
									return;
								}
								if (event.type === "match") {
									if (seenMatchCount++ < effectiveOffset) return;
									if (matchCount >= effectiveLimit) {
										matchLimitReached = true;
										stopChild(true);
										return;
									}
									matchCount++;
									const filePath = event.data?.path?.text;
									const lineNumber = event.data?.line_number;
									const lineText = event.data?.lines?.text;
									if (filePath && typeof lineNumber === "number")
										matches.push({ filePath, lineNumber, lineText });
								}
							});

							child.on("error", (error) => {
								cleanup();
								settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
							});
							child.on("close", async (code) => {
								cleanup();
								if (aborted) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								if (!killedDueToLimit && code !== 0 && code !== 1) {
									const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
									settle(() => reject(new Error(errorMsg)));
									return;
								}
								if (matchCount === 0) {
									const message =
										effectiveOffset > 0 ? `No more matches at offset=${effectiveOffset}` : "No matches found";
									settle(() => resolve({ content: [{ type: "text", text: message }], details: undefined }));
									return;
								}

								// Format matches after streaming finishes so custom readFile() backends can be async.
								for (const match of matches) {
									if (contextValue === 0 && match.lineText !== undefined) {
										const relativePath = formatPath(match.filePath);
										const sanitized = match.lineText
											.replace(/\r\n/g, "\n")
											.replace(/\r/g, "")
											.replace(/\n$/, "");
										const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
										if (wasTruncated) linesTruncated = true;
										outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
									} else {
										const block = await formatBlock(match.filePath, match.lineNumber);
										outputLines.push(...block);
									}
								}

								const rawOutput = outputLines.join("\n");
								// Apply byte truncation. There is no line limit here because the match limit already capped rows.
								const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
								let output = truncation.content;
								const details: GrepToolDetails = {};
								// Build actionable notices for truncation and match limits.
								const notices: string[] = [];
								if (matchLimitReached && !truncation.truncated) {
									const nextOffset = effectiveOffset + matchCount;
									notices.push(
										`${effectiveLimit} matches limit reached. Use offset=${nextOffset} to continue, or refine pattern`,
									);
									details.matchLimitReached = effectiveLimit;
									details.nextOffset = nextOffset;
								} else if (matchLimitReached) {
									notices.push(`${effectiveLimit} matches limit reached. Reduce limit or refine pattern`);
									details.matchLimitReached = effectiveLimit;
								}
								if (truncation.truncated) {
									notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
									details.truncation = truncation;
								}
								if (linesTruncated) {
									notices.push(
										`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
									);
									details.linesTruncated = true;
								}
								if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
								settle(() =>
									resolve({
										content: [{ type: "text", text: output }],
										details: Object.keys(details).length > 0 ? details : undefined,
									}),
								);
							});
							await waitForChildProcess(child);
						};
						if (subprocess) {
							await subprocess.execute(
								{ actionId: toolCallId, executable: rgPath, args, cwd, signal },
								runChild,
							);
						} else {
							await runChild({ argv: [rgPath, ...args] });
						}
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
