import { SettingsManager } from "@metis/coding-agent/host";
import { describe, expect, it, vi } from "vitest";
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

	it("restores the previous rules when persistence fails", async () => {
		const manager = SettingsManager.inMemory();
		manager.setAutoCommandRules([{ command: "ls", allowNetwork: false }]);
		vi.spyOn(manager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));
		const service = new PermissionAutoSettingsService(manager);

		await expect(
			service.update({
				requestId: crypto.randomUUID(),
				rules: [{ command: "curl", allowNetwork: true }],
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(service.view().rules).toEqual([{ command: "ls", allowNetwork: false }]);
	});

	it("defaults the reviewer switch off and patches it without rewriting rules", async () => {
		const manager = SettingsManager.inMemory();
		manager.setAutoCommandRules([{ command: "ls", allowNetwork: false }]);
		const service = new PermissionAutoSettingsService(manager);
		expect(service.view().reviewerEnabled).toBe(false);

		const enabled = await service.update({ requestId: crypto.randomUUID(), reviewerEnabled: true });
		expect(enabled.reviewerEnabled).toBe(true);
		expect(enabled.rules).toEqual([{ command: "ls", allowNetwork: false }]);
		expect(service.view()).toMatchObject({ reviewerEnabled: true, rules: [{ command: "ls", allowNetwork: false }] });
	});

	it("patches rules without changing the reviewer switch", async () => {
		const manager = SettingsManager.inMemory();
		manager.setAutoReviewerEnabled(true);
		const service = new PermissionAutoSettingsService(manager);

		const result = await service.update({
			requestId: crypto.randomUUID(),
			rules: [{ command: "git status", allowNetwork: false }],
		});
		expect(result.reviewerEnabled).toBe(true);
		expect(result.rules).toEqual([{ command: "git status", allowNetwork: false }]);
	});

	it("rejects an empty patch", async () => {
		const manager = SettingsManager.inMemory();
		const service = new PermissionAutoSettingsService(manager);
		await expect(service.update({ requestId: crypto.randomUUID() })).rejects.toMatchObject({
			code: "INVALID_REQUEST",
		});
	});

	it("restores rules and the reviewer switch together when persistence fails", async () => {
		const manager = SettingsManager.inMemory();
		manager.setAutoCommandRules([{ command: "ls", allowNetwork: false }]);
		const service = new PermissionAutoSettingsService(manager);
		vi.spyOn(manager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));

		await expect(
			service.update({
				requestId: crypto.randomUUID(),
				rules: [{ command: "git status", allowNetwork: false }],
				reviewerEnabled: true,
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(service.view()).toMatchObject({
			rules: [{ command: "ls", allowNetwork: false }],
			reviewerEnabled: false,
		});
	});

	it("stores exact network targets and rejects wildcards, invalid ports, and injected fields", async () => {
		const manager = SettingsManager.inMemory();
		const service = new PermissionAutoSettingsService(manager);
		const exact = await service.update({
			requestId: crypto.randomUUID(),
			rules: [
				{
					command: "curl",
					allowNetwork: true,
					networkTargets: [{ hostname: "API.Example.com", port: 443 }],
				},
			],
		});
		expect(exact.rules).toEqual([
			{ command: "curl", allowNetwork: true, networkTargets: [{ hostname: "api.example.com", port: 443 }] },
		]);

		for (const networkTargets of [
			[{ hostname: "*.example.com", port: 443 }],
			[{ hostname: "https://example.com", port: 443 }],
			[{ hostname: "example.com/path", port: 443 }],
			[{ hostname: "user@example.com", port: 443 }],
			[{ hostname: "example.com", port: 0 }],
			[{ hostname: "example.com", port: 65_536 }],
			[{ hostname: "example.com", port: 443.5 }],
			[{ hostname: "example.com", port: 443, apiKey: "secret" }],
			[
				{ hostname: "example.com", port: 443 },
				{ hostname: "EXAMPLE.com", port: 443 },
			],
			Array.from({ length: 33 }, (_, index) => ({ hostname: `host${index}.example.com`, port: 443 })),
		]) {
			await expect(
				service.update({
					requestId: crypto.randomUUID(),
					rules: [{ command: "curl", allowNetwork: true, networkTargets }],
				}),
			).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		}
		expect(service.view().rules).toEqual([
			{ command: "curl", allowNetwork: true, networkTargets: [{ hostname: "api.example.com", port: 443 }] },
		]);
	});
});

describe("effective permission rule settings", () => {
	it("shows all default identities and offers only executable analyzer suggestions", async () => {
		const service = new PermissionAutoSettingsService(SettingsManager.inMemory());
		const view = await service.read();
		expect(view.permissionRules).toHaveLength(51);
		expect(view.permissionRuleDefaults).toHaveLength(51);
		expect(view.permissionRules.find((rule) => rule.id === "E01")).toMatchObject({
			enabled: true,
			modes: ["ask", "auto"],
		});
		expect(view.suggestions).toContain("curl");
		expect(view.suggestions).not.toContain("docker ps");
		expect(view.suggestions).not.toContain("printenv");
	});

	it("persists disabling and deleting defaults without reviving them on read or legacy patches", async () => {
		const manager = SettingsManager.inMemory();
		const service = new PermissionAutoSettingsService(manager);
		const rules = (await service.read()).permissionRules
			.filter((rule) => rule.id !== "C03")
			.map(({ support: _support, supportReason: _reason, ...rule }) =>
				rule.id === "E01" ? { ...rule, enabled: false } : rule,
			);
		await service.update({
			requestId: crypto.randomUUID(),
			permissionRules: rules.map((rule) => ({
				...rule,
				modes: [...rule.modes],
				directories: [...rule.directories],
				...(rule.networkTargets ? { networkTargets: rule.networkTargets.map((target) => ({ ...target })) } : {}),
			})),
		});
		await service.update({ requestId: crypto.randomUUID(), rules: [{ command: "cat", allowNetwork: false }] });
		const result = await service.read();
		expect(result.permissionRules.some((rule) => rule.id === "C03")).toBe(false);
		expect(result.permissionRules.find((rule) => rule.id === "E01")?.enabled).toBe(false);
	});

	it("keeps an explicit empty list and rolls back an effective-rule update when saving fails", async () => {
		const manager = SettingsManager.inMemory();
		const service = new PermissionAutoSettingsService(manager);
		const original = service.view().permissionRules;
		vi.spyOn(manager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));
		await expect(
			service.update({ requestId: crypto.randomUUID(), permissionRules: [], reviewerEnabled: true }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(service.view().permissionRules).toEqual(original);
		expect(service.view().reviewerEnabled).toBe(false);
		await service.update({ requestId: crypto.randomUUID(), permissionRules: [] });
		expect((await service.read()).permissionRules).toEqual([]);
	});

	it("fails reads on malformed settings instead of reporting a valid empty list", async () => {
		const manager = SettingsManager.inMemory({
			permissionRulesVersion: 1,
			permissionRules: [{ broken: true }] as never,
		});
		const service = new PermissionAutoSettingsService(manager);
		await expect(service.read()).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});

	it("waits for initialization persistence before confirming a successful read", async () => {
		const manager = SettingsManager.inMemory();
		vi.spyOn(manager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));
		await expect(new PermissionAutoSettingsService(manager).read()).rejects.toMatchObject({
			code: "OPERATION_FAILED",
		});
	});
});

it("migrates a legacy command prefix throughout the previously supported 256-byte range", async () => {
	const command = `printf ${"x".repeat(230)}`;
	const manager = SettingsManager.inMemory({ autoCommandRules: [{ command, allowNetwork: false }] });
	const view = await new PermissionAutoSettingsService(manager).read();
	expect(view.permissionRules.find((rule) => rule.origin === "user")).toMatchObject({
		command,
		name: command,
		scope: "all",
	});
});
