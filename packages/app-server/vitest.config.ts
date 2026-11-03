import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// These tests exercise real journals, runtime startup and local HTTP I/O.
		// Shared CI runners (especially Windows) are several times slower than a
		// developer machine, so keep the strict local timeout and give CI headroom
		// instead of failing a correct test on a slow disk.
		testTimeout: process.env.CI ? 60_000 : 15_000,
		maxWorkers: process.env.CI && process.platform === "win32" ? 2 : undefined,
	},
});
