import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// These tests exercise real journals, runtime startup and local HTTP I/O.
		// Shared CI runners (especially Windows) are several times slower than a
		// developer machine, so keep the strict local timeout and give CI headroom
		// instead of failing a correct test on a slow disk.
		testTimeout: process.env.CI ? 30_000 : 15_000,
		// These tests start real runtimes and journals; an unbounded worker pool
		// on a many-core developer machine makes unrelated cases exceed their
		// timeouts. Cap the pool so the full suite stays reliable and comparable.
		maxWorkers: process.env.CI ? 2 : Math.min(4, availableParallelism()),
	},
});
