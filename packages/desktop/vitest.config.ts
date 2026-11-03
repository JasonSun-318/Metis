import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const appProtocolSrc = fileURLToPath(new URL("../app-protocol/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: { alias: [{ find: /^@metis\/app-protocol$/, replacement: appProtocolSrc }] },
	test: {
		exclude: [...configDefaults.exclude, "e2e/**", "out/**"],
		setupFiles: ["./test/setup.ts"],
		// Cookie decryption and git review fixtures take several seconds on a cold
		// Windows runner while staying well under a second locally; keep the default
		// local budget and give CI headroom instead of failing correct tests.
		testTimeout: process.env.CI ? 30_000 : 5_000,
	},
});
