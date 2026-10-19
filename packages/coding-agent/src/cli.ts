#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { installSqliteWarningFilter } from "./utils/node-warnings.ts";

process.title = APP_NAME;
process.env.METIS_CODING_AGENT = "true";
installSqliteWarningFilter();

if (process.argv[2] === "--internal-workspace-sandbox-broker") {
	await (await import("./core/workspace-sandbox-broker.ts")).runWorkspaceSandboxBroker();
} else {
	// Keep the broker path isolated from ordinary CLI/provider initialization.
	const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
	configureHttpDispatcher();
	const { main } = await import("./main.ts");
	await main(process.argv.slice(2));
}
