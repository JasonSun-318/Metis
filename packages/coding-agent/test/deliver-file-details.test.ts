import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeliverFileDetails } from "../src/core/deliver-file.ts";

describe("parseDeliverFileDetails", () => {
	it("accepts absolute live references and rejects malformed source paths", () => {
		const details = {
			fileId: "aaaaaaaaaaaaaaaa",
			name: "report.txt",
			byteLength: 12,
			deliveredAt: "2026-10-29T00:00:00.000Z",
		};
		const sourcePath = resolve("report.txt");
		expect(parseDeliverFileDetails({ ...details, sourcePath })?.sourcePath).toBe(sourcePath);
		for (const invalid of ["relative.txt", "", 12, `${sourcePath}\0`, "x".repeat(4097)]) {
			expect(parseDeliverFileDetails({ ...details, sourcePath: invalid })).toBeUndefined();
		}
	});
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
