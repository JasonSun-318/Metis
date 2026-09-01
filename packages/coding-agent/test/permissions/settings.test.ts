import { describe, expect, it } from "vitest";
import {
	intersectPermissionSettings,
	PERMISSION_PRESETS,
	settingsForPreset,
} from "../../src/core/permissions/index.ts";

describe("permission settings", () => {
	it("maps presets to independent sandbox and approval ceilings", () => {
		expect(settingsForPreset("ask")).toEqual({ sandboxPolicy: "workspace-write", approvalPolicy: "user" });
		expect(settingsForPreset("auto")).toEqual({
			sandboxPolicy: "workspace-write",
			approvalPolicy: "auto-review",
		});
		expect(settingsForPreset("full")).toEqual({
			sandboxPolicy: "danger-full-access",
			approvalPolicy: "user",
		});
	});

	it("intersects the two ceilings independently", () => {
		expect(intersectPermissionSettings(settingsForPreset("full"), settingsForPreset("auto"))).toEqual({
			sandboxPolicy: "workspace-write",
			approvalPolicy: "user",
		});
		expect(
			intersectPermissionSettings(settingsForPreset("auto"), {
				sandboxPolicy: "read-only",
				approvalPolicy: "deny",
			}),
		).toEqual({ sandboxPolicy: "read-only", approvalPolicy: "deny" });
	});

	it("preserves matching external sandboxes and narrows incompatible sandbox kinds", () => {
		const external = { sandboxPolicy: "external-sandbox", approvalPolicy: "auto-review" } as const;
		expect(intersectPermissionSettings(external, external)).toEqual(external);
		expect(intersectPermissionSettings(external, settingsForPreset("auto"))).toEqual({
			sandboxPolicy: "read-only",
			approvalPolicy: "auto-review",
		});
		expect(intersectPermissionSettings(settingsForPreset("auto"), external)).toEqual({
			sandboxPolicy: "read-only",
			approvalPolicy: "auto-review",
		});
	});

	it("does not expose mutable preset state", () => {
		expect(Object.isFrozen(PERMISSION_PRESETS)).toBe(true);
		expect(Object.isFrozen(settingsForPreset("ask"))).toBe(true);
		expect(Object.isFrozen(intersectPermissionSettings(settingsForPreset("ask"), settingsForPreset("auto")))).toBe(
			true,
		);
	});
});
