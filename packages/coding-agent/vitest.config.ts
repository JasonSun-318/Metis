import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		globalSetup: "./test/global-setup.ts",
		testTimeout: 30000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@arcmind\/ai$/, replacement: aiSrcIndex },
			{ find: /^@arcmind\/ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@arcmind\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@arcmind\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@arcmind\/tui$/, replacement: tuiSrcIndex },
		],
	},
});
