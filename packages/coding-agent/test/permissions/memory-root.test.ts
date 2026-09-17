import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizePermissionAction, PermissionPolicy, settingsForPreset } from "../../src/core/permissions/index.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { actionInput, projectDir } from "./fixtures.ts";

// The runtime canonicalizes managed roots; the policy compares them against
// canonicalized action paths, so fixtures must do the same (macOS /var symlink).
const memoryRoot = canonicalizeActionPath(resolve(tmpdir(), "metis-permission-fixture", "agent", "memory"), tmpdir());
const vaultFile = join(memoryRoot, "global", "notes", "prefs.md");

const memoryWrite = (overrides: Parameters<typeof actionInput>[0] = {}) =>
	normalizePermissionAction(
		actionInput({
			toolName: "memory_write",
			toolIdentity: "builtin:memory_write:v1",
			args: { op: "create", scope: "global" },
			readPaths: [],
			writePaths: [vaultFile],
			...overrides,
		}),
	);

const genericVaultWrite = (toolName: string, overrides: Parameters<typeof actionInput>[0] = {}) =>
	normalizePermissionAction(
		actionInput({
			toolName,
			toolIdentity: `builtin:${toolName}:v1`,
			args: { path: vaultFile },
			readPaths: [],
			writePaths: [vaultFile],
			...overrides,
		}),
	);

describe("managed memory roots", () => {
	const policy = new PermissionPolicy();
	const managed = [memoryRoot];

	it.each(["ask", "auto"] as const)("allows builtin memory tools inside the vault under %s", (preset) => {
		const decision = policy.evaluate({
			settings: settingsForPreset(preset),
			action: memoryWrite(),
			managedMemoryRoots: managed,
		});
		expect(decision).toMatchObject({ kind: "allow", riskLevel: "low" });
	});

	it("denies memory tool writes that escape the managed roots", () => {
		const outside = join(projectDir, ".metis", "escape.md");
		const decision = policy.evaluate({
			settings: settingsForPreset("ask"),
			action: memoryWrite({ writePaths: [outside] }),
			managedMemoryRoots: managed,
		});
		expect(decision).toMatchObject({ kind: "deny" });
	});

	it("denies memory tool actions carrying commands or effects", () => {
		for (const overrides of [
			{ command: "ls", toolName: "memory_write" },
			{ effects: ["destructive" as const] },
			{ networkEndpoints: [{ hostname: "api.example.com", port: 443 }] },
		]) {
			const decision = policy.evaluate({
				settings: settingsForPreset("ask"),
				action: memoryWrite(overrides),
				managedMemoryRoots: managed,
			});
			expect(decision.kind).not.toBe("allow");
		}
	});

	it("denies non-memory builtin tools writing into the vault", () => {
		for (const action of [
			genericVaultWrite("write_file"),
			genericVaultWrite("edit_file"),
			genericVaultWrite("bash", { command: "echo x > vault", args: { command: "echo x" } }),
		]) {
			const decision = policy.evaluate({
				settings: settingsForPreset("ask"),
				action,
				managedMemoryRoots: managed,
			});
			expect(decision).toMatchObject({ kind: "deny", riskLevel: "critical" });
		}
	});

	it("denies non-builtin provenance even with a memory tool name", () => {
		const decision = policy.evaluate({
			settings: settingsForPreset("ask"),
			action: memoryWrite({ provenance: "mcp", toolIdentity: "mcp:fake:memory_write:v1" }),
			managedMemoryRoots: managed,
		});
		expect(decision).toMatchObject({ kind: "deny", riskLevel: "critical" });
	});

	it("treats vault writes as outside-the-workspace when no managed roots are configured", () => {
		const decision = policy.evaluate({
			settings: settingsForPreset("ask"),
			action: memoryWrite(),
		});
		expect(decision.kind).not.toBe("allow");
	});
});
