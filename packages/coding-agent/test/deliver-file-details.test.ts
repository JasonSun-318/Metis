import { describe, expect, it } from "vitest";
import { parseDeliverFileDetails } from "../src/core/deliver-file.ts";

describe("parseDeliverFileDetails", () => {
	it("accepts the durable journal shape and rejects malformed ids", () => {
		expect(
			parseDeliverFileDetails({
				fileId: "aaaaaaaaaaaaaaaa",
				name: "report.xlsx",
				byteLength: 12,
				deliveredAt: "2026-08-18T00:00:00.000Z",
			}),
		).toMatchObject({ name: "report.xlsx" });
		expect(parseDeliverFileDetails({ fileId: "bad", name: "x", byteLength: 1, deliveredAt: "t" })).toBeUndefined();
	});
});
