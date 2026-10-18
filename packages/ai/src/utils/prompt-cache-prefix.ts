import { digestCacheFrame } from "./prompt-cache-layout.ts";

const encoder = new TextEncoder();

interface CachePrefix {
	readonly digest: string;
	/** Serialized UTF-8 bytes, or undefined when this chain skips accounting. */
	readonly bytes: number | undefined;
	extend(frame: unknown): void | Promise<void>;
}

/**
 * Accumulate a provider's prompt-cache prefix in wire order. Omitting
 * `initialBytes` disables byte accounting for validation-only chains.
 */
export function createCachePrefix(initialDigest: string, initialBytes?: number): CachePrefix {
	let digest = initialDigest;
	let bytes = initialBytes;
	return {
		get digest() {
			return digest;
		},
		get bytes() {
			return bytes;
		},
		extend(frame: unknown): void | Promise<void> {
			const json = JSON.stringify(frame);
			const result = digestCacheFrame(digest, json);
			if (bytes !== undefined) bytes += encoder.encode(json).length;
			if (typeof result === "string") {
				digest = result;
				return;
			}
			return result.then((next) => {
				digest = next;
			});
		},
	};
}
