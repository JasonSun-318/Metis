import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceSandboxProfileKey } from "../../src/core/interactive-bash-boundary.ts";
import { PermissionPolicy, settingsForPreset } from "../../src/core/permissions/index.ts";
import { createWorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";
import { workspaceWrite } from "./fixtures.ts";

describe("sandbox grant profiles", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("protects all repository-owned metadata roots", () => {
		const action = workspaceWrite();
		const decision = new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action });
		if (decision.kind === "deny") throw new Error("Expected grant");
		for (const name of [".git", ".metis", ".codex", ".agents"]) {
			expect(decision.grant.protectedRoots).toContain(join(action.workspaceRoots[0]!, name));
		}
	});

	it("keys sandbox reuse by every authority-bearing profile field", () => {
		const base = {
			cwd: "/work",
			workspaceRoots: ["/work"],
			readOnlyRoots: ["/read"],
			writeRoots: ["/write"],
			protectedRoots: ["/secret"],
			writeProtectedRoots: ["/work/.git"],
			networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
		};
		const key = workspaceSandboxProfileKey(base);
		for (const changed of [
			{ ...base, readOnlyRoots: ["/other-read"] },
			{ ...base, writeRoots: ["/other-write"] },
			{ ...base, protectedRoots: ["/other-secret"] },
			{ ...base, writeProtectedRoots: ["/work/.metis"] },
			{ ...base, networkEndpoints: [{ hostname: "api.example.com", port: 8443 }] },
		]) {
			expect(workspaceSandboxProfileKey(changed)).not.toBe(key);
		}
	});

	it("denies a sandbox grant that tries to write inside protected metadata", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "metis-protected-grant-"));
		roots.push(workspace);
		const git = join(workspace, ".git");
		mkdirSync(git);
		await expect(
			createWorkspaceSandbox({
				cwd: workspace,
				workspaceRoots: [workspace],
				writeRoots: [join(git, "config")],
				writeProtectedRoots: [git],
			}),
		).rejects.toThrow(/protected/i);
	});
});
