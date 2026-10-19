import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";

const [authPath, readyPath, lockedPath, contendedPath, releasedPath, resultPath] = process.argv.slice(2);
const deadline = Date.now() + 15_000;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

writeFileSync(readyPath, "ready\n");
while (!existsSync(lockedPath)) {
	if (Date.now() > deadline) {
		console.error("caller: timed out waiting for the lock holder");
		process.exit(3);
	}
	await sleep(2);
}

const backend = new FileAuthStorageBackend(authPath);
let firstError: unknown;
let firstCallbackRan = false;
try {
	// The holder does not release until this call has failed with a real
	// proper-lockfile ELOCKED, so the outcome is not scheduling-dependent.
	backend.withLock(() => {
		firstCallbackRan = true;
		return { result: "unexpected", next: JSON.stringify({ first: true }) };
	});
} catch (error) {
	firstError = error;
}

const firstCode = errorCode(firstError);
if (firstCode !== "ELOCKED") {
	writeFileSync(
		resultPath,
		JSON.stringify({
			ok: false,
			firstCode,
			firstMessage: errorMessage(firstError),
			firstCallbackRan,
		}),
	);
	process.exit(1);
}

// Publish contention only after observing the real ELOCKED above.
writeFileSync(contendedPath, "contended\n");
while (!existsSync(releasedPath)) {
	if (Date.now() > deadline) {
		console.error("caller: timed out waiting for the holder to release");
		process.exit(5);
	}
	await sleep(2);
}

try {
	const result = backend.withLock((current) => ({
		result: `callback:${current}:${readFileSync(authPath, "utf8")}`,
		next: JSON.stringify({ pong: true }),
	}));
	writeFileSync(
		resultPath,
		JSON.stringify({
			ok: true,
			firstCode,
			firstCallbackRan,
			result,
			content: readFileSync(authPath, "utf8"),
		}),
	);
} catch (error) {
	writeFileSync(
		resultPath,
		JSON.stringify({
			ok: false,
			firstCode,
			firstCallbackRan,
			code: errorCode(error),
			message: errorMessage(error),
		}),
	);
	process.exitCode = 1;
}
