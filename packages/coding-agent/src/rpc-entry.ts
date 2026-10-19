#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { installSqliteWarningFilter } from "./utils/node-warnings.ts";

process.title = `${APP_NAME}-rpc`;
process.env.METIS_CODING_AGENT = "true";
// Install this before importing main: its module graph loads node:sqlite.
installSqliteWarningFilter();

const { configureHttpDispatcher } = await import("./core/http-dispatcher.ts");
configureHttpDispatcher();

const { main } = await import("./main.ts");
main(["--mode", "rpc", ...process.argv.slice(2)]);
