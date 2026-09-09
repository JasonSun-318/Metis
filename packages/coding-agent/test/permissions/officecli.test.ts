import { describe, expect, it } from "vitest";
import { normalizePermissionAction, PermissionPolicy, settingsForPreset } from "../../src/core/permissions/index.ts";
import { bashPermissionClaim } from "../../src/core/tool-permission-adapter.ts";
import { actionInput } from "./fixtures.ts";

function actionFor(command: string) {
	const input = actionInput({ toolName: "bash", toolIdentity: "builtin:bash:v1", args: { command } });
	return normalizePermissionAction({ ...input, ...bashPermissionClaim(command, input) });
}
describe("OfficeCLI permission exemption", () => {
	it.each(["ask", "auto", "full"] as const)("allows direct OfficeCLI calls in %s", (preset) => {
		for (const command of [
			"officecli create report.docx",
			"officecli view report.docx text && officecli validate report.docx",
			`officecli set report.docx /body --prop text='${"long document text ".repeat(40)}'`,
		]) {
			expect(
				new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action: actionFor(command) }),
			).toMatchObject({ kind: "allow", grant: { executionTarget: preset === "full" ? "host" : "sandbox" } });
		}
	});
	it.each([
		"officecli --version && rm file.txt",
		"officecli view $(touch marker) text",
		"officecli view `touch marker` text",
		"officecli view report.docx > output.txt",
		"./officecli create report.docx",
		"python -c 'officecli'",
		"officecli view report.docx & touch marker",
	])("does not exempt other shell execution: %s", (command) => {
		expect(
			new PermissionPolicy().evaluate({ settings: settingsForPreset("ask"), action: actionFor(command) }).kind,
		).not.toBe("allow");
	});
	it("keeps read-only and protected metadata boundaries", () => {
		const policy = new PermissionPolicy();
		expect(
			policy.evaluate({
				settings: { sandboxPolicy: "read-only", approvalPolicy: "deny" },
				action: actionFor("officecli create report.docx"),
			}).kind,
		).toBe("deny");
		expect(
			policy.evaluate({ settings: settingsForPreset("ask"), action: actionFor("officecli create .git/report.docx") })
				.kind,
		).toBe("deny");
	});
});
