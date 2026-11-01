import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const verifyScript = fileURLToPath(new URL("../scripts/verify-package.mjs", import.meta.url));

function runVerify(args: string[]) {
	return spawnSync(process.execPath, [verifyScript, ...args], { encoding: "utf8" });
}

describe("verify-package architecture selection", () => {
	it("rejects unsupported explicit architectures before touching the filesystem", () => {
		const result = runVerify(["--arch=i686"]);
		expect(result.status).toBe(1);
		expect(`${result.stderr}${result.stdout}`).toContain("Unsupported package architecture: i686");
	});

	// The darwin/win32 verifiers resolve per-architecture native-tool paths before
	// any other package check, so a missing package root fails with the targeted
	// architecture in the error path.
	const hasNativePackageChecks = process.platform === "darwin" || process.platform === "win32";
	(hasNativePackageChecks ? it : it.skip)(
		"targets the requested architecture instead of the host architecture",
		() => {
			const result = runVerify(["--arch=arm64", "/nonexistent/metis-package"]);
			expect(result.status).toBe(1);
			expect(`${result.stderr}${result.stdout}`).toContain(`${process.platform}-arm64`);
		},
	);
});
