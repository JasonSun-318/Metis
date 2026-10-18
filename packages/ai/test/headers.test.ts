import { describe, expect, it } from "vitest";
import type { ProviderHeaders } from "../src/types.ts";
import { hasHeader } from "../src/utils/headers.ts";

describe("authentication header presence", () => {
	it.each<[ProviderHeaders | undefined, string, boolean]>([
		[undefined, "authorization", false],
		[{}, "authorization", false],
		[{ Authorization: "Bearer token" }, "authorization", true],
		[{ authorization: " token " }, "AUTHORIZATION", true],
		[{ authorization: null }, "authorization", false],
		[{ authorization: " \t" }, "authorization", false],
		[{ Authorization: null, authorization: "Bearer token" }, "authorization", true],
		[{ "cf-aig-authorization": "Bearer token" }, "authorization", false],
		[{ "CF-AIG-Authorization": "Bearer token" }, "cf-aig-authorization", true],
	])("matches %j for %s as %s", (headers, name, expected) => {
		expect(hasHeader(headers, name)).toBe(expected);
	});
});
