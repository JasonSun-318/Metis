import { createHash } from "node:crypto";
import type { AgentMessage } from "@arcmind/agent-core";
import { estimateTokens } from "./compaction/index.ts";
import { importToolOutputFile, isOwnedToolOutputFile, persistToolOutputText } from "./large-tool-output.ts";

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
]);

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export interface ToolResultMicrocompactorOptions {
	outputDir: string;
	isBuiltinTool: (toolName: string) => boolean;
}

interface Candidate {
	index: number;
	message: ToolResultMessage;
}

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

function cacheKey(message: ToolResultMessage): string {
	const hash = createHash("sha256");
	hash.update(message.toolName);
	hash.update("\0");
	hash.update(message.toolCallId);
	hash.update("\0");
	hash.update(String(message.timestamp));
	hash.update("\0");
	hash.update(String(message.isError));
	hash.update("\0");
	hash.update(declaredFullOutputPath(message) ?? "");
	for (const block of message.content) {
		hash.update("\0");
		if (block.type === "text") hash.update(block.text);
	}
	return hash.digest("hex");
}

function clearedContent(path: string) {
	return [
		{
			type: "text" as const,
			text: [
				"<tool-result-cleared>",
				`Tool result saved to: ${path}`,
				"Use read to view it if needed.",
				"</tool-result-cleared>",
			].join("\n"),
		},
	];
}

export function createToolResultMicrocompactor(options: ToolResultMicrocompactorOptions) {
	const savedPaths = new Map<string, string>();
	const inFlight = new Map<string, Promise<string>>();

	const save = async (message: ToolResultMessage): Promise<string> => {
		const key = cacheKey(message);
		const cached = savedPaths.get(key);
		if (cached && (await isOwnedToolOutputFile(cached, options.outputDir))) return cached;
		savedPaths.delete(key);

		const pending = inFlight.get(key);
		if (pending) return pending;

		const task = (async () => {
			const sourcePath = declaredFullOutputPath(message);
			const path = sourcePath
				? await importToolOutputFile(sourcePath, options.outputDir)
				: await persistToolOutputText(textContent(message), options.outputDir);
			savedPaths.set(key, path);
			return path;
		})();
		inFlight.set(key, task);
		try {
			return await task;
		} finally {
			inFlight.delete(key);
		}
	};

	return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
		let protectedCount = 0;
		let candidateTokens = 0;
		const candidates: Candidate[] = [];

		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (
				message?.role !== "toolResult" ||
				!CLEARABLE_BUILTIN_TOOLS.has(message.toolName) ||
				!options.isBuiltinTool(message.toolName) ||
				!isTextOnly(message) ||
				(message.toolName === "bash" && declaredFullOutputPath(message) === undefined)
			) {
				continue;
			}
			if (protectedCount < MICROCOMPACTION_KEEP_RECENT) {
				protectedCount++;
				continue;
			}
			candidates.push({ index, message });
			candidateTokens += estimateTokens(message);
		}

		if (candidateTokens < MICROCOMPACTION_TRIGGER_TOKENS) return messages;

		const replacements = new Map<number, AgentMessage>();
		for (const candidate of candidates.reverse()) {
			signal?.throwIfAborted();
			try {
				const path = await save(candidate.message);
				signal?.throwIfAborted();
				replacements.set(candidate.index, { ...candidate.message, content: clearedContent(path) });
			} catch (error) {
				if (signal?.aborted) throw signal.reason ?? error;
				// Keep the complete provider-visible result if durable recovery is unavailable.
			}
		}

		if (replacements.size === 0) return messages;
		return messages.map((message, index) => replacements.get(index) ?? message);
	};
}
