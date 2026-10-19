#!/usr/bin/env node
import { APP_NAME } from "../config.ts";
import { installSqliteWarningFilter } from "../utils/node-warnings.ts";

process.title = APP_NAME;
installSqliteWarningFilter();

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("../cli.ts");
