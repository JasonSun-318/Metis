import { afterEach, describe, expect, it, vi } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("manual bash permissions", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	for (const mode of ["ask", "full"] as const) {
		it(`treats user-entered commands as explicit authorization in ${mode}`, async () => {
			const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
			const harness = await createHarness({
				permissionPreset: mode,
				requestPermissionApproval: requestApproval,
			});
			harnesses.push(harness);
			const commands: string[] = [];
			const operations: BashOperations = {
				exec: async (command, _cwd, options) => {
					commands.push(command);
					options.onData(Buffer.from("ok"));
					return { exitCode: 0 };
				},
			};

			for (const command of ["rm -rf build", "git push origin main", "curl https://example.test"]) {
				await expect(harness.session.executeBash(command, undefined, { operations })).resolves.toMatchObject({
					output: "ok",
				});
			}

			expect(commands).toEqual(["rm -rf build", "git push origin main", "curl https://example.test"]);
			expect(requestApproval).not.toHaveBeenCalled();
		});
	}
});
