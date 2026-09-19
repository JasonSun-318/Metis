import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
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
 *
 * Memoized per message object: journal entries and transformed views are
 * immutable once produced (the only in-place rewrite path operates on
 * structured clones), so a request does not re-hash the whole history.
 */
const sourceDigestCache = new WeakMap<AgentMessage, string>();

export function getContextSourceDigest(message: AgentMessage): string {
	const cached = sourceDigestCache.get(message);
	if (cached !== undefined) return cached;
	const digest = createHash("sha256").update(canonicalJson(message)).digest("hex");
	sourceDigestCache.set(message, digest);
	return digest;
}

export type ContextViewErrorCode =
	| "invalid-record"
	| "stale-source"
	| "stale-leaf"
	| "batch-conflict"
	| "unsupported-version";

export class ContextViewError extends Error {
	readonly code: ContextViewErrorCode;
	constructor(code: ContextViewErrorCode, message: string) {
		super(message);
		this.name = "ContextViewError";
		this.code = code;
	}
}

const HEX_64 = /^[0-9a-f]{64}$/;
const REWRITE_REASONS = new Set(["microcompaction", "artifact_repair", "migration"]);

function invalidRecord(message: string): never {
	throw new ContextViewError("invalid-record", message);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRelativeArtifactPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (isAbsolute(value) || value.includes("\\")) return false;
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isTextContentArray(value: unknown): value is TextContent[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(block) =>
				block !== null &&
				typeof block === "object" &&
				(block as TextContent).type === "text" &&
				typeof (block as TextContent).text === "string",
		)
	);
}

/** Throw unless `record` is a well-formed {@link ContextRewriteBatch}. */
export function assertContextRewriteBatch(record: unknown): asserts record is ContextRewriteBatch {
	if (record === null || typeof record !== "object" || Array.isArray(record)) {
		invalidRecord("Context rewrite batch must be a plain object");
	}
	const batch = record as Record<string, unknown>;
	if (batch.schemaVersion !== 1) {
		throw new ContextViewError(
			"unsupported-version",
			`Unsupported context rewrite schema version: ${String(batch.schemaVersion)}`,
		);
	}
	if (typeof batch.batchId !== "string" || batch.batchId.length === 0) {
		invalidRecord("Context rewrite batchId must be a non-empty string");
	}
	if (batch.expectedLeafId !== null && typeof batch.expectedLeafId !== "string") {
		invalidRecord("Context rewrite expectedLeafId must be a string or null");
	}
	if (typeof batch.reason !== "string" || !REWRITE_REASONS.has(batch.reason)) {
		invalidRecord(`Unsupported context rewrite reason: ${String(batch.reason)}`);
	}
	if (!isNonNegativeInteger(batch.tokensBefore) || !isNonNegativeInteger(batch.tokensAfter)) {
		invalidRecord("Context rewrite token counts must be non-negative integers");
	}
	if (!Array.isArray(batch.replacements)) {
		invalidRecord("Context rewrite replacements must be an array");
	}
	const seen = new Set<string>();
	for (const replacement of batch.replacements as unknown[]) {
		if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) {
			invalidRecord("Context rewrite replacement must be a plain object");
		}
		const r = replacement as Record<string, unknown>;
		if (typeof r.sourceEntryId !== "string" || r.sourceEntryId.length === 0) {
			invalidRecord("Context rewrite sourceEntryId must be a non-empty string");
		}
		if (typeof r.sourceDigest !== "string" || !HEX_64.test(r.sourceDigest)) {
			invalidRecord(`Context rewrite sourceDigest for ${r.sourceEntryId} must be 64 hex chars`);
		}
		if (!isRelativeArtifactPath(r.artifactRelativePath)) {
			invalidRecord(`Context rewrite artifact path for ${r.sourceEntryId} must be a safe relative path`);
		}
		if (typeof r.artifactDigest !== "string" || !HEX_64.test(r.artifactDigest)) {
			invalidRecord(`Context rewrite artifactDigest for ${r.sourceEntryId} must be 64 hex chars`);
		}
		if (!isNonNegativeInteger(r.artifactBytes)) {
			invalidRecord(`Context rewrite artifactBytes for ${r.sourceEntryId} must be a non-negative integer`);
		}
		if (!isTextContentArray(r.content)) {
			invalidRecord(`Context rewrite content for ${r.sourceEntryId} must be a non-empty text block array`);
		}
		if (seen.has(r.sourceEntryId)) {
			invalidRecord(`Context rewrite batch repeats source ${r.sourceEntryId}`);
		}
		seen.add(r.sourceEntryId);
	}
}

/** Canonical serialization used to compare committed batches for idempotency. */
export function contextRewriteBatchIdentity(batch: ContextRewriteBatch): string {
	return canonicalJson(batch);
}

/**
 * Project the rewritten model view for `sources`: each committed replacement
 * overlays the source tool result's content. Sources no longer present in the
 * given list are skipped — replay never expands summarized-away history. The
 * original messages are not mutated.
 */
export function applyContextRewrites(
	sources: readonly ContextSource[],
	batches: readonly ContextRewriteBatch[],
): AgentMessage[] {
	const byId = new Map(sources.map((source) => [source.entryId, source]));
	const view = sources.map((source) => source.message);
	const indexOf = new Map(sources.map((source, index) => [source.entryId, index]));
	const rewritten = new Set<string>();
	for (const batch of batches) {
		assertContextRewriteBatch(batch);
		for (const replacement of batch.replacements) {
			const source = byId.get(replacement.sourceEntryId);
			if (!source) continue;
			if (source.message.role !== "toolResult") {
				throw new ContextViewError(
					"invalid-record",
					`Context rewrite source ${replacement.sourceEntryId} is not a toolResult`,
				);
			}
			if (getContextSourceDigest(source.message) !== replacement.sourceDigest) {
				throw new ContextViewError(
					"stale-source",
					`Context rewrite source ${replacement.sourceEntryId} digest mismatch`,
				);
			}
			if (batch.reason === "microcompaction" && rewritten.has(replacement.sourceEntryId)) {
				throw new ContextViewError(
					"invalid-record",
					`Context rewrite source ${replacement.sourceEntryId} rewritten twice by microcompaction`,
				);
			}
			rewritten.add(replacement.sourceEntryId);
			view[indexOf.get(replacement.sourceEntryId)!] = { ...source.message, content: replacement.content };
		}
	}
	return view;
}
