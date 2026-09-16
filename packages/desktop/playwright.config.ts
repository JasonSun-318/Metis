import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 45_000,
	expect: { timeout: process.env.CI ? 20_000 : 10_000 },
	reporter: process.env.CI ? [["github"], ["list"]] : "list",
	use: {
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
});
