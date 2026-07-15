/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   arcmind -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@arcmind/coding-agent";
import { createBashTool } from "@arcmind/coding-agent";

export default function (arcmind: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, ARCMIND_SPAWN_HOOK: "1" },
		}),
	});

	arcmind.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
