import { describe, expect, it } from "vitest";
import { WorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";

// This suite starts the real OS sandbox. It only runs when explicitly enabled
// because ordinary CI hosts may lack sandbox-exec, bubblewrap, or srt-win.
describe.runIf(process.env.METIS_TEST_OS_SANDBOX === "1")("real workspace sandbox self-test", () => {
	it("starts a sandbox and verifies permitted, denied, and network boundaries with temporary fixtures", async () => {
		const report = await WorkspaceSandbox.selfTest();

		expect(report.mode).toBe("self-test");
		expect(report.status).toBe("healthy");
		expect(report.code).toBe("ready");
		expect(report.checks).toEqual(
			expect.arrayContaining([
				{ id: "sandbox-startup", status: "passed" },
				{ id: "filesystem-permitted", status: "passed" },
				{ id: "filesystem-denied", status: "passed" },
				{ id: "network-denied", status: "passed" },
			]),
		);
	}, 60_000);
});
