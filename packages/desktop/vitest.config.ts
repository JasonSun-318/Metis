import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const appProtocolSrc = fileURLToPath(new URL("../app-protocol/src/index.ts", import.meta.url));

export default defineConfig({
	resolve: { alias: [{ find: /^@metis\/app-protocol$/, replacement: appProtocolSrc }] },
	test: { exclude: [...configDefaults.exclude, "e2e/**"], setupFiles: ["./test/setup.ts"] },
});
