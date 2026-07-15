import { describe, expect, it } from "vitest";
import { getArcMindUserAgent } from "../src/utils/arcmind-user-agent.ts";

describe("getArcMindUserAgent", () => {
	it("formats the ArcMind user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getArcMindUserAgent("1.2.3");

		expect(userAgent).toBe(`arcmind/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^arcmind\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
