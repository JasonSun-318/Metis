import { describe, expect, it } from "vitest";
import { normalizePermissionAction, PermissionPolicy, settingsForPreset } from "../../src/core/permissions/index.ts";
import { actionInput, outsideFile } from "./fixtures.ts";

describe("unconfigured image tool permission boundary", () => {
	const noEffects = {
		toolName: "image_generate",
		toolIdentity: "builtin:image_generate:v1",
		args: { prompt: "robot" },
		readPaths: [],
		writePaths: [],
		networkEndpoints: [],
		effects: [],
	};
	it.each(["ask", "auto"] as const)("allows only its empty builtin scope in %s mode", (preset) => {
		const policy = new PermissionPolicy();
		const input = { settings: settingsForPreset(preset), permissionRules: [] };
		expect(policy.evaluate({ ...input, action: normalizePermissionAction(actionInput(noEffects)) })).toMatchObject({
			kind: "allow",
			reason: "Unconfigured image tool has no effects",
		});
		for (const additional of [
			{ readPaths: [outsideFile] },
			{ writePaths: [outsideFile] },
			{ networkEndpoints: [{ hostname: "images.test", port: 443 }] },
			{ effects: ["external-side-effect"] as const },
			{ command: "pwd" },
			{ provenance: "extension" as const },
			{ toolName: "another_tool" },
		]) {
			expect(
				policy.evaluate({
					...input,
					action: normalizePermissionAction(actionInput({ ...noEffects, ...additional })),
				}).kind,
			).not.toBe("allow");
		}
	});
});
