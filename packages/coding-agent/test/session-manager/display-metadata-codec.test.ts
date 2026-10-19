import { describe, expect, it } from "vitest";
import {
	parseSessionDisplayMetadata,
	serializeSessionDisplayMetadata,
} from "../../src/core/session-display-metadata-codec.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MAX_NAME_BYTES = 8 * 1024;
const MAX_FILE_BYTES = 16 * 1024;

function metadataText(value: Record<string, unknown>): string {
	return `${JSON.stringify({ version: 1, sessionId: SESSION_ID, ...value })}\n`;
}

describe("session display metadata codec", () => {
	it("parses valid metadata, trimming edges while preserving embedded newlines and false flags", () => {
		expect(
			parseSessionDisplayMetadata(
				metadataText({
					name: "  display\r\nname  ",
					useMemory: false,
					contributeMemory: false,
				}),
			),
		).toEqual({
			sessionId: SESSION_ID,
			name: "display\r\nname",
			useMemory: false,
			contributeMemory: false,
		});
	});

	it("returns undefined for shape failures and enforces the trimmed 8192-byte name limit", () => {
		const invalid = [
			metadataText({}),
			metadataText({ name: 42 }),
			metadataText({ name: true }),
			metadataText({ name: {} }),
			metadataText({ name: null, version: 2 }),
			metadataText({ name: null, version: "1" }),
			metadataText({ name: null, sessionId: 42 }),
			"[]\n",
			"{}\n",
		];

		for (const text of invalid) {
			expect(parseSessionDisplayMetadata(text), text).toBeUndefined();
		}

		const boundary = "a".repeat(MAX_NAME_BYTES);
		expect(
			parseSessionDisplayMetadata(JSON.stringify({ version: 1, sessionId: SESSION_ID, name: boundary })),
		).toEqual({ sessionId: SESSION_ID, name: boundary });
		expect(
			parseSessionDisplayMetadata(JSON.stringify({ version: 1, sessionId: SESSION_ID, name: `${boundary}a` })),
		).toBeUndefined();
	});

	it("keeps the JSON.parse and session-id throwing paths for the production reader", () => {
		for (const text of [metadataText({ name: null, sessionId: "-invalid" }), "null\n", "", "{malformed}\n"]) {
			expect(() => parseSessionDisplayMetadata(text), text).toThrow();
		}
	});

	it("serializes exact normalized bytes with null names, false flags, and one trailing newline", () => {
		expect(serializeSessionDisplayMetadata({ sessionId: SESSION_ID })).toBe(
			`{"version":1,"sessionId":"${SESSION_ID}","name":null}\n`,
		);
		expect(serializeSessionDisplayMetadata({ sessionId: SESSION_ID, name: " \r\n\t " })).toBe(
			`{"version":1,"sessionId":"${SESSION_ID}","name":null}\n`,
		);
		expect(
			serializeSessionDisplayMetadata({
				sessionId: SESSION_ID,
				name: " A\r\nB ",
				useMemory: false,
				contributeMemory: false,
			}),
		).toBe(`{"version":1,"sessionId":"${SESSION_ID}","name":"A B","useMemory":false,"contributeMemory":false}\n`);
		expect(
			serializeSessionDisplayMetadata({
				sessionId: SESSION_ID,
				name: "Title",
				useMemory: true,
				contributeMemory: true,
			}),
		).toBe(`{"version":1,"sessionId":"${SESSION_ID}","name":"Title"}\n`);
	});

	it("keeps the serializer subject to the 16384-byte limit independently of the 8192-byte read limit", () => {
		const prefix = JSON.stringify({ version: 1, sessionId: SESSION_ID, name: "" });
		const boundaryName = "a".repeat(MAX_FILE_BYTES - Buffer.byteLength(prefix, "utf8") - 1);
		const boundary = serializeSessionDisplayMetadata({ sessionId: SESSION_ID, name: boundaryName });
		expect(Buffer.byteLength(boundary, "utf8")).toBe(MAX_FILE_BYTES);
		expect(boundary.endsWith("\n")).toBe(true);

		expect(() => serializeSessionDisplayMetadata({ sessionId: SESSION_ID, name: `${boundaryName}a` })).toThrow(
			"Session display metadata exceeds its size limit",
		);
		expect(() => serializeSessionDisplayMetadata({ sessionId: "-invalid" })).toThrow(
			"Session id must be non-empty, contain only alphanumeric characters",
		);
		expect(() =>
			serializeSessionDisplayMetadata({ sessionId: SESSION_ID, name: "a".repeat(MAX_NAME_BYTES + 1) }),
		).not.toThrow();
	});
});
