#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { runWindowsSandboxWorker, windowsSandboxWorkerTestHelpers } from "./core/windows-sandbox-worker.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.ARCMIND_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === windowsSandboxWorkerTestHelpers.INTERNAL_WORKER_FLAG) {
	void runWindowsSandboxWorker().catch((error) => {
		process.stderr.write(
			`Windows sandbox worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
} else {
	// Configure undici's global dispatcher before provider SDKs issue requests.
	// Runtime settings are applied once SettingsManager has loaded global/project settings.
	configureHttpDispatcher();
	main(args);
}
