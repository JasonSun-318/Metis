import { createHash } from "node:crypto";
import type { AgentMessage } from "@metis/agent-core";
import type { TextContent } from "@metis/ai";

export interface ContextSource {
	entryId: string;
	message: AgentMessage;
}

export interface ContextReplacement {
	sourceEntryId: string;
	sourceDigest: string;
	artifactRelativePath: string;
	artifactDigest: string;
	artifactBytes: number;
	content: TextContent[];
}

export interface ContextRewriteBatch {
	schemaVersion: 1;
	batchId: string;
	expectedLeafId: string | null;
	reason: "microcompaction" | "artifact_repair" | "migration";
	replacements: ContextReplacement[];
	tokensBefore: number;
	tokensAfter: number;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).filter((key) => record[key] !== undefined);
	keys.sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * Digest of a source message's complete model-facing content. For tool
 * results this covers content, toolName, toolCallId, isError, and details.
 * This is a source-integrity digest, not the provider prefix digest used for
 * breakpoint reuse.
 */
export function getContextSourceDigest(message: AgentMessage): string {
	return createHash("sha256").update(canonicalJson(message)).digest("hex");
}
