import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// These tests exercise real journals, runtime startup and local HTTP I/O.
		testTimeout: 15_000,
		maxWorkers: process.env.CI && process.platform === "win32" ? 2 : undefined,
	},
});
