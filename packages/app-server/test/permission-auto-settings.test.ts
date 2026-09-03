import { SettingsManager } from "@metis/coding-agent";
import { describe, expect, it } from "vitest";
import { PermissionAutoSettingsService } from "../src/permission-auto-settings.ts";

describe("PermissionAutoSettingsService", () => {
	it("returns suggestions and atomically replaces global rules", async () => {
		const manager = SettingsManager.inMemory();
		const service = new PermissionAutoSettingsService(manager);
		expect(service.view().suggestions).toContain("ls");
		const result = await service.update({
			requestId: crypto.randomUUID(),
			rules: [{ command: " git   status ", allowNetwork: false }],
		});
		expect(result.rules).toEqual([{ command: "git status", allowNetwork: false }]);
		expect(service.view().rules).toEqual(result.rules);
	});

	it("rejects complex command rules without publishing a partial replacement", async () => {
		const manager = SettingsManager.inMemory();
		manager.setAutoCommandRules([{ command: "ls", allowNetwork: false }]);
		const service = new PermissionAutoSettingsService(manager);
		await expect(
			service.update({
				requestId: crypto.randomUUID(),
				rules: [{ command: "ls && pwd", allowNetwork: false }],
			}),
		).rejects.toThrow();
		expect(service.view().rules).toEqual([{ command: "ls", allowNetwork: false }]);
	});
});
