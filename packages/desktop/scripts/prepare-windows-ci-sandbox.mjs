import { fileURLToPath } from "node:url";
import { createWindowsSandboxSetup } from "../src/main/windows-sandbox-setup.ts";

if (process.platform !== "win32") throw new Error("Windows CI sandbox setup requires Windows");

// Fresh runners need the same one-time account, helper ACL and WFP setup as the app.
const appPath = fileURLToPath(new URL(`../out/Metis-win32-${process.arch}/resources/app.asar`, import.meta.url));
const setup = createWindowsSandboxSetup({
	appPath,
	architecture: process.arch,
	isPackaged: true,
	platform: process.platform,
});
const result = await setup();
if (result !== "installed") throw new Error(`Windows CI sandbox setup did not complete: ${result}`);
console.log("Verified Windows sandbox account, packaged helper access and WFP egress isolation");
