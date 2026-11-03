import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	timeout: 45_000,
	// One retry on shared CI runners only: the suite launches and restarts the
	// packaged app ~300 times, so a single infrastructure hiccup (renderer frame
	// detached, sleep/wake, cold disk) should not red the job. Local runs stay
	// strict so flakes are still visible while developing.
	retries: process.env.CI ? 1 : 0,
	expect: { timeout: process.env.CI ? 20_000 : 10_000 },
	reporter: process.env.CI ? [["github"], ["list"]] : "list",
	use: {
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
});
