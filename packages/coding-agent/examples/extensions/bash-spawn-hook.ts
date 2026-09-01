/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   metis -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@metis/coding-agent";
import { createBashToolDefinition } from "@metis/coding-agent";

export default function (metis: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashToolDefinition(cwd, {
		prepareCommand: (command) => `source ~/.profile\n${command}`,
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: { ...env, METIS_SPAWN_HOOK: "1" },
		}),
	});

	metis.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, ctx) => {
			return bashTool.execute(id, params, signal, onUpdate, ctx);
		},
	});
}
