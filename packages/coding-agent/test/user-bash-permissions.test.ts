import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("manual bash permissions", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("allows a known Ask read without reviewer or user approval", async () => {
		const reviewer = vi.fn(async () => '{"decision":"deny","reason":"unused"}');
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask", reviewerEnabled: true },
			permissionReviewerStream: reviewer,
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);

		const authorization = await harness.session.authorizeUserBash("pwd");
		expect(reviewer).not.toHaveBeenCalled();
		expect(requestApproval).not.toHaveBeenCalled();
		harness.session.cancelUserBashAuthorization(authorization);
	});

	it("asks exactly once before an Ask write-like command", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask", reviewerEnabled: true },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("written"));
				return { exitCode: 0 };
			},
		};

		const authorization = await harness.session.authorizeUserBash("echo x > output.txt");
		await harness.session.executeBash("echo x > output.txt", undefined, { authorization, operations });
		expect(requestApproval).toHaveBeenCalledOnce();
	});

	it("sends risky Auto manual commands directly to the user, never the reviewer", async () => {
		const reviewer = vi.fn(async () => '{"decision":"allow","reason":"unused"}');
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "auto", reviewerEnabled: true },
			permissionReviewerStream: reviewer,
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);

		const authorization = await harness.session.authorizeUserBash("ssh example.com");
		expect(requestApproval).toHaveBeenCalledOnce();
		expect(reviewer).not.toHaveBeenCalled();
		harness.session.cancelUserBashAuthorization(authorization);
	});
});
