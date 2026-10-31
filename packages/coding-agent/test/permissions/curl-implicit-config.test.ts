import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { curlImplicitConfigurationReason } from "../../src/core/permissions/curl-implicit-config.ts";

describe("implicit curl configuration", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "metis-curl-config-"));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	it("accepts a clean home", () => {
		expect(curlImplicitConfigurationReason(["https://example.test"], {}, home)).toBeUndefined();
	});
	it.each(["home", "CURL_HOME", "XDG_CONFIG_HOME"] as const)(
		"detects configuration through %s without executing or reading it",
		(source) => {
			const configHome = join(home, "config");
			mkdirSync(configHome);
			const filename = source === "XDG_CONFIG_HOME" ? "curlrc" : ".curlrc";
			writeFileSync(join(source === "home" ? home : configHome, filename), 'output = "fixture-only.txt"');
			const environment = source === "home" ? {} : { [source]: configHome };
			expect(curlImplicitConfigurationReason(["https://example.test"], environment, home)).toContain(
				"implicit configuration",
			);
			expect(curlImplicitConfigurationReason(["-q", "https://example.test"], environment, home)).toBeUndefined();
			expect(curlImplicitConfigurationReason(["-s", "-q", "https://example.test"], environment, home)).toContain(
				"implicit configuration",
			);
		},
	);
});
