import { assertValidSessionId } from "./session-id.ts";
import type { SessionDisplayMetadata } from "./session-manager.ts";

export const MAX_SESSION_DISPLAY_METADATA_BYTES = 16 * 1024;
const MAX_SESSION_DISPLAY_NAME_BYTES = MAX_SESSION_DISPLAY_METADATA_BYTES / 2;

/**
 * Parse already-read sidecar text. Shape and name-size failures return
 * `undefined`; `JSON.parse` and `assertValidSessionId` retain their throwing
 * paths for `readSessionDisplayMetadata`'s existing compatibility catch.
 */
export function parseSessionDisplayMetadata(text: string): SessionDisplayMetadata | undefined {
	const value = JSON.parse(text) as Record<string, unknown>;
	if (value.version !== 1 || typeof value.sessionId !== "string") return undefined;
	assertValidSessionId(value.sessionId);
	if (value.name !== null && typeof value.name !== "string") return undefined;
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (Buffer.byteLength(name, "utf8") > MAX_SESSION_DISPLAY_NAME_BYTES) return undefined;
	return {
		sessionId: value.sessionId,
		...(name ? { name } : {}),
		...(value.useMemory === false ? { useMemory: false } : {}),
		...(value.contributeMemory === false ? { contributeMemory: false } : {}),
	};
}

/** Serialize the exact sidecar bytes, including the single trailing newline. */
export function serializeSessionDisplayMetadata(metadata: SessionDisplayMetadata): string {
	assertValidSessionId(metadata.sessionId);
	const name = metadata.name?.replace(/[\r\n]+/g, " ").trim();
	const contents = `${JSON.stringify({
		version: 1,
		sessionId: metadata.sessionId,
		name: name || null,
		...(metadata.useMemory === false ? { useMemory: false } : {}),
		...(metadata.contributeMemory === false ? { contributeMemory: false } : {}),
	})}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_SESSION_DISPLAY_METADATA_BYTES) {
		throw new Error("Session display metadata exceeds its size limit");
	}
	return contents;
}
