import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@metis/agent-core";
import { estimateTokens } from "./compaction/index.ts";
import {
	type ContextRewriteBatch,
	type ContextSource,
	ContextViewError,
	getContextSourceDigest,
} from "./context-view.ts";
import { archiveContextOutput, type ContextArtifact, formatContextArtifactReference } from "./large-tool-output.ts";

export const MICROCOMPACTION_KEEP_RECENT = 5;
export const MICROCOMPACTION_TRIGGER_TOKENS = 20_000;

const CLEARABLE_BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	"describe_image",
]);

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

function isTextOnly(message: ToolResultMessage): boolean {
	return message.content.length > 0 && message.content.every((block) => block.type === "text");
}

function textContent(message: ToolResultMessage): string {
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function declaredFullOutputPath(message: ToolResultMessage): string | undefined {
	const details = message.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const path = (details as { fullOutputPath?: unknown }).fullOutputPath;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function clearedContent(path: string) {
	return [
		{
			type: "text" as const,
			text: [
				"<tool-result-cleared>",
				formatContextArtifactReference(path),
				"Use read to view it if needed.",
				"</tool-result-cleared>",
			].join("\n"),
		},
	];
}

export interface MicrocompactionTarget {
	low: number;
	minimumGain: number;
}

export function getMicrocompactionTarget(input: {
	used: number;
	high: number;
	growthP95: number;
}): MicrocompactionTarget | undefined {
	const { used, high, growthP95 } = input;
	if (![used, high, growthP95].every(Number.isFinite) || used < 0 || high <= 0 || growthP95 < 0 || used < high) {
		return undefined;
	}
	const runway = Math.min(Math.floor(high * 0.25), Math.max(20_000, 2 * growthP95));
	return { low: high - runway, minimumGain: Math.min(20_000, Math.max(1, Math.floor(high * 0.1))) };
}

export interface PrepareMicrocompactionInput {
	mode: "legacy" | "pressure";
	sources: readonly ContextSource[];
	view: readonly AgentMessage[];
	batches: readonly ContextRewriteBatch[];
	expectedLeafId: string | null;
	protectedEntryIds: ReadonlySet<string>;
	target: MicrocompactionTarget;
	tokensBefore: number;
	signal?: AbortSignal;
}

export interface MicrocompactionOptions {
	outputDir: string;
	isBuiltinTool: (toolName: string) => boolean;
	estimateView: (messages: readonly AgentMessage[]) => number;
}

function isEligibleToolResult(
	message: AgentMessage | undefined,
	options: MicrocompactionOptions,
): message is ToolResultMessage {
	return (
		message?.role === "toolResult" &&
		CLEARABLE_BUILTIN_TOOLS.has(message.toolName) &&
		options.isBuiltinTool(message.toolName) &&
		isTextOnly(message) &&
		!(message.toolName === "bash" && declaredFullOutputPath(message) === undefined)
	);
}

function pendingToolCallIds(view: readonly AgentMessage[]): Set<string> {
	const resultIds = new Set<string>();
	for (const message of view) {
		if (message?.role === "toolResult") resultIds.add(message.toolCallId);
	}
	const pending = new Set<string>();
	for (const message of view) {
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && !resultIds.has(block.id)) pending.add(block.id);
		}
	}
	return pending;
}

function groupToolCallIds(view: readonly AgentMessage[], toolCallId: string): readonly string[] | undefined {
	for (const message of view) {
		if (message?.role !== "assistant") continue;
		const ids = message.content.filter((block) => block.type === "toolCall").map((block) => block.id);
		if (ids.includes(toolCallId)) return ids;
	}
	return undefined;
}

export async function prepareMicrocompaction(
	input: PrepareMicrocompactionInput,
	options: MicrocompactionOptions,
): Promise<ContextRewriteBatch | undefined> {
	const { sources, view, signal } = input;
	if (sources.length !== view.length) {
		throw new ContextViewError("invalid-record", "microcompaction sources and view must correspond one-to-one");
	}
	const seen = new Set<string>();
	for (const source of sources) {
		if (seen.has(source.entryId)) {
			throw new ContextViewError("invalid-record", `ambiguous microcompaction source: ${source.entryId}`);
		}
		seen.add(source.entryId);
	}

	const batched = new Set<string>();
	for (const batch of input.batches) {
		for (const replacement of batch.replacements) batched.add(replacement.sourceEntryId);
	}
	const pending = pendingToolCallIds(view);
	const groupResultIds = new Map<string, readonly string[]>();

	// The legacy recent-five rule counts candidate-eligible results from the tail.
	let protectedCount = 0;
	const recentProtected = new Set<number>();
	for (let index = view.length - 1; index >= 0; index--) {
		if (!isEligibleToolResult(view[index], options)) continue;
		if (protectedCount < MICROCOMPACTION_KEEP_RECENT) {
			protectedCount++;
			recentProtected.add(index);
		}
	}

	const candidates: number[] = [];
	let candidateTokens = 0;
	for (let index = 0; index < view.length; index++) {
		const message = view[index];
		const source = sources[index]!;
		if (!isEligibleToolResult(message, options) || source.message.role !== "toolResult") continue;
		if (
			recentProtected.has(index) ||
			input.protectedEntryIds.has(source.entryId) ||
			batched.has(source.entryId) ||
			message.isError ||
			// Rewrites only apply to sources extensions left unmodified; an
			// already-transformed view entry cannot benefit from a new batch.
			getContextSourceDigest(message) !== getContextSourceDigest(source.message)
		) {
			continue;
		}
		// Tool-group integrity: protect results whose sibling calls are still pending
		// or whose assistant message is no longer in the view.
		const groupIds = groupResultIds.get(message.toolCallId) ?? groupToolCallIds(view, message.toolCallId);
		if (groupIds === undefined) continue;
		groupResultIds.set(message.toolCallId, groupIds);
		if (groupIds.some((id) => pending.has(id))) continue;
		candidates.push(index);
		candidateTokens += estimateTokens(message);
	}

	if (input.mode === "legacy" && candidateTokens < MICROCOMPACTION_TRIGGER_TOKENS) return undefined;

	const projected = [...view];
	const replacements: ContextRewriteBatch["replacements"] = [];
	let tokensAfter = input.tokensBefore;
	for (const index of candidates) {
		signal?.throwIfAborted();
		const source = sources[index]!;
		const sourceMessage = source.message as ToolResultMessage;
		const sourcePath = declaredFullOutputPath(sourceMessage);
		let artifact: ContextArtifact;
		try {
			artifact = await archiveContextOutput(
				options.outputDir,
				sourcePath ? { sourcePath } : { text: textContent(sourceMessage) },
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			continue;
		}
		replacements.push({
			sourceEntryId: source.entryId,
			sourceDigest: getContextSourceDigest(source.message),
			artifactRelativePath: artifact.relativePath,
			artifactDigest: artifact.digest,
			artifactBytes: artifact.bytes,
			content: clearedContent(artifact.absolutePath),
		});
		projected[index] = {
			...(view[index] as ToolResultMessage),
			content: replacements[replacements.length - 1]!.content,
		};
		tokensAfter = options.estimateView(projected);
		if (input.mode === "pressure" && tokensAfter <= input.target.low) break;
	}

	if (replacements.length === 0) return undefined;
	const gain = input.tokensBefore - tokensAfter;
	if (input.mode === "pressure" && (tokensAfter > input.target.low || gain < input.target.minimumGain)) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		batchId: randomUUID(),
		expectedLeafId: input.expectedLeafId,
		reason: "microcompaction",
		replacements,
		tokensBefore: input.tokensBefore,
		tokensAfter,
	};
}
