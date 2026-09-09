import { spawn } from "node:child_process";

// Spawn grandchild with inherited stdout
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
	stdio: ["ignore", "inherit", "inherit"],
	detached: true,
});
grandchild.unref();

// Parent exits immediately
process.exit(0);
