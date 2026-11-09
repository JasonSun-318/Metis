import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../verify-windows.mjs", import.meta.url));

test("verify-windows refuses non-Windows hosts instead of producing fake evidence", () => {
	const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
	if (process.platform === "win32") {
		// On a Windows host the probes run for real; only assert the report shape.
		assert.match(result.stdout, /"probes?"|results/);
		return;
	}
	assert.equal(result.status, 2, result.stderr || result.stdout);
	assert.match(result.stderr, /must run on native Windows/);
});
