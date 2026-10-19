import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

const [lockPath, readyPath, lockedPath, contendedPath, releasedPath] = process.argv.slice(2);
const deadline = Date.now() + 15_000;

while (!existsSync(readyPath)) {
	if (Date.now() > deadline) {
		console.error("holder: timed out waiting for caller readiness");
		process.exit(2);
	}
	await sleep(5);
}

const release = lockfile.lockSync(lockPath, { realpath: false });
writeFileSync(lockedPath, "locked\n");

while (!existsSync(contendedPath)) {
	if (Date.now() > deadline) {
		release();
		console.error("holder: timed out waiting for the caller to record a real ELOCKED");
		process.exit(4);
	}
	await sleep(5);
}

release();
writeFileSync(releasedPath, "released\n");
