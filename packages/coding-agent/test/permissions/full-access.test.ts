import { describe, expect, it, vi } from "vitest";
import {
	normalizePermissionAction,
	PermissionPolicy,
	settingsForPreset,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { bashPermissionClaim } from "../../src/core/tool-permission-adapter.ts";
import { actionInput, externalWrite, protectedWrite, rootRecursiveDelete, sensitiveRead } from "./fixtures.ts";
import { safeRequest } from "./runtime-fixtures.ts";

describe("unrestricted Full access", () => {
	it("allows Python file inspection through the actual shell scope adapter", () => {
		const command = `python3 -c "from pathlib import Path; print(Path('/tmp/a').exists())"`;
		const input = actionInput({ toolName: "bash", toolIdentity: "builtin:bash:v1", args: { command } });
		const action = normalizePermissionAction({ ...input, ...bashPermissionClaim(command, input) });
		expect(action.effects).toContain("unknown");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({
			kind: "allow",
			grant: { executionTarget: "host", protectedRoots: [] },
		});
	});

	it.each([rootRecursiveDelete, protectedWrite, sensitiveRead, externalWrite])(
		"bypasses policy blocks and saved deny rules without creating a reviewer (%#)",
		async (makeAction) => {
			// Deliberately inspect grants only: no destructive or external action is executed.
			const action = makeAction();
			const reviewerFactory = vi.fn(() => {
				throw new Error("review must not run");
			});
			const match = vi.fn(() => {
				throw new Error("project rules must not run");
			});
			const execute = vi.fn(async (grant) => {
				expect(grant.executionTarget).toBe(action.provenance === "mcp" ? "external" : "host");
				expect(grant.protectedRoots).toEqual([]);
				return "executed";
			});
			const runtime = new ToolAuthorizationRuntime({
				sessionId: "full",
				projectPath: action.cwd,
				projectRules: { match },
				reviewerFactory,
			});
			const args = action.command
				? { command: action.command }
				: makeAction === protectedWrite
					? { path: `${actionInput().cwd}/.git/HEAD`, content: "tamper" }
					: actionInput().args;
			await expect(
				runtime.authorizeAndExecute(
					safeRequest({
						action,
						args,
						settings: settingsForPreset("full"),
						sandboxHealth: "unavailable",
						execute,
					}),
				),
			).resolves.toBe("executed");
			expect(execute).toHaveBeenCalledOnce();
			expect(match).not.toHaveBeenCalled();
			expect(reviewerFactory).not.toHaveBeenCalled();
		},
	);

	it("restores saved deny rules when switching back to Auto", async () => {
		const match = vi.fn(() => ({ decision: "deny" as const }));
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "switch",
			projectPath: actionInput().cwd,
			projectRules: { match },
		});
		await expect(runtime.authorizeAndExecute(safeRequest({ settings: settingsForPreset("full") }))).resolves.toBe(
			"executed",
		);
		expect(match).not.toHaveBeenCalled();
		runtime.invalidate("settings");
		await expect(runtime.authorizeAndExecute(safeRequest({ settings: settingsForPreset("auto") }))).rejects.toThrow(
			"Permission denied",
		);
		expect(match).toHaveBeenCalled();
	});
});
