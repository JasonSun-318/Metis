import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { ExtensionCommandContextActions } from "../core/extensions/types.ts";

type HeadlessModeSession = AgentSessionRuntime["session"];
type HeadlessModeRuntimeHost = Pick<AgentSessionRuntime, "newSession" | "fork" | "switchSession">;

/**
 * Build the extension command context actions shared by headless modes.
 *
 * The session getter is read on every invocation so callbacks always target the
 * session that is current at call time, including after a session rebind.
 */
export function createHeadlessCommandContextActions(
	runtimeHost: HeadlessModeRuntimeHost,
	getSession: () => HeadlessModeSession,
): ExtensionCommandContextActions {
	return {
		waitForIdle: () => getSession().waitForIdle(),
		newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
		fork: async (entryId, forkOptions) => {
			const result = await runtimeHost.fork(entryId, forkOptions);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, navigateOptions) => {
			const result = await getSession().navigateTree(targetId, {
				summarize: navigateOptions?.summarize,
				customInstructions: navigateOptions?.customInstructions,
				replaceInstructions: navigateOptions?.replaceInstructions,
				label: navigateOptions?.label,
			});
			return { cancelled: result.cancelled };
		},
		switchSession: async (sessionPath, switchOptions) => runtimeHost.switchSession(sessionPath, switchOptions),
		reload: async () => {
			await getSession().reload();
		},
	};
}
