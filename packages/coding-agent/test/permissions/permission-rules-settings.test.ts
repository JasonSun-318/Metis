import { describe, expect, it } from "vitest";
import { createDefaultPermissionRules, type PermissionRule } from "../../src/core/permissions/index.ts";
import {
	InMemorySettingsStorage,
	SettingsManager,
	type SettingsScope,
	type SettingsStorage,
} from "../../src/core/settings-manager.ts";

async function reopened(storage: InMemorySettingsStorage): Promise<SettingsManager> {
	return SettingsManager.fromStorage(storage);
}

function without(rules: readonly PermissionRule[], id: string): PermissionRule[] {
	return rules.filter((rule) => rule.id !== id);
}

function disabled(rules: readonly PermissionRule[], id: string): PermissionRule[] {
	return rules.map((rule) => (rule.id === id ? { ...rule, enabled: false } : rule));
}

function sharedStorage(): {
	readonly data: Record<SettingsScope, string>;
	readonly storage: SettingsStorage;
} {
	const data: Record<SettingsScope, string> = { global: "{}", project: "{}" };
	return {
		data,
		storage: {
			withLock(scope, fn) {
				const next = fn(data[scope]);
				if (next !== undefined) data[scope] = next;
			},
		},
	};
}

describe("permission rules settings", () => {
	it("initializes the 51 defaults and persists the version once", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		const rules = manager.getPermissionRules();
		expect(rules).toHaveLength(51);
		expect(manager.getGlobalSettings()).toMatchObject({ permissionRulesVersion: 1 });
		await manager.flush();
		const next = await reopened(storage);
		expect(next.getPermissionRules()).toHaveLength(51);
	});

	it("shares one lazy migration across managers instead of resurrecting deleted defaults", async () => {
		const { data, storage } = sharedStorage();
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage);

		first.getPermissionRules();
		await first.flush();
		first.setPermissionRules(first.getPermissionRules().filter((rule) => rule.id !== "C03"));
		await first.flush();

		const adopted = second.getPermissionRules();
		await second.flush();
		expect(adopted.some((rule) => rule.id === "C03")).toBe(false);
		expect(second.getPermissionRules().some((rule) => rule.id === "C03")).toBe(false);
		const persisted = JSON.parse(data.global) as { permissionRules?: { id: string }[] };
		expect(persisted.permissionRules?.some((rule) => rule.id === "C03")).toBe(false);
	});

	it("only marks lazy migration complete after the locked write succeeds", () => {
		const { data, storage } = sharedStorage();
		const manager = SettingsManager.fromStorage(storage);
		let failWrites = false;
		const failingStorage: SettingsStorage = {
			withLock(scope, fn) {
				if (scope === "global" && failWrites) throw new Error("settings disk full");
				storage.withLock(scope, fn);
			},
		};
		const failing = SettingsManager.fromStorage(failingStorage);
		failWrites = true;
		expect(() => failing.getPermissionRules()).toThrow("settings disk full");
		failWrites = false;
		expect(failing.getPermissionRules()).toHaveLength(51);
		expect(JSON.parse(data.global)).toMatchObject({ permissionRulesVersion: 1 });
		expect(manager.getPermissionRules()).toHaveLength(51);
	});

	it("migrates legacy Auto commands with full path and exact-network semantics", async () => {
		const manager = SettingsManager.inMemory({
			autoCommandRules: [
				{ command: "curl", allowNetwork: true, networkTargets: [{ hostname: "example.com", port: 443 }] },
				{ command: "ls", allowNetwork: false },
			],
		});
		const rules = manager.getPermissionRules();
		expect(rules).toHaveLength(53);
		expect(rules.filter((rule) => rule.origin === "default")).toHaveLength(51);
		expect(rules.filter((rule) => rule.origin === "user")).toEqual([
			expect.objectContaining({
				id: "user-command-1",
				kind: "command",
				enabled: true,
				modes: ["auto"],
				scope: "all",
				command: "curl",
				allowNetwork: true,
				networkTargets: [{ hostname: "example.com", port: 443 }],
			}),
			expect.objectContaining({ id: "user-command-2", scope: "all", command: "ls", allowNetwork: false }),
		]);
		expect(manager.getAutoCommandRules()).toEqual([
			{ command: "curl", allowNetwork: true, networkTargets: [{ hostname: "example.com", port: 443 }] },
			{ command: "ls", allowNetwork: false },
		]);
	});

	it("keeps a legacy prefix longer than 200 characters", () => {
		const command = `printf ${"x".repeat(230)}`;
		const manager = SettingsManager.inMemory({ autoCommandRules: [{ command, allowNetwork: false }] });
		const migrated = manager.getPermissionRules().find((rule) => rule.origin === "user");
		expect(migrated).toMatchObject({ command, name: command, scope: "all" });
	});

	it("treats an explicit empty list as authoritative and never resurrects defaults", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		manager.setPermissionRules([]);
		await manager.flush();
		expect(manager.getPermissionRules()).toEqual([]);
		expect(manager.getAutoCommandRules()).toEqual([]);
		const next = await reopened(storage);
		expect(next.getPermissionRules()).toEqual([]);
	});

	it("persists disabled and deleted defaults without re-adding them", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		const rules = without(disabled(createDefaultPermissionRules(), "C03"), "T06");
		manager.setPermissionRules(rules);
		await manager.flush();
		const next = await reopened(storage);
		const persisted = next.getPermissionRules();
		expect(persisted).toHaveLength(50);
		expect(persisted.find((rule) => rule.id === "C03")).toMatchObject({ enabled: false });
		expect(persisted.some((rule) => rule.id === "T06")).toBe(false);
	});

	it("ignores legacy Auto rules once the versioned list exists", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				permissionRulesVersion: 1,
				permissionRules: [],
				autoCommandRules: [{ command: "docker", allowNetwork: false }],
			}),
		);
		const manager = await reopened(storage);
		expect(manager.getPermissionRules()).toEqual([]);
	});

	it("legacy setters only replace the user command subset", async () => {
		const manager = SettingsManager.inMemory();
		manager.setPermissionRules(without(disabled(createDefaultPermissionRules(), "C03"), "T06"));
		manager.setAutoCommandRules([{ command: "curl", allowNetwork: false }]);
		const rules = manager.getPermissionRules();
		expect(rules).toHaveLength(51);
		expect(rules.find((rule) => rule.id === "C03")).toMatchObject({ enabled: false });
		expect(rules.some((rule) => rule.id === "T06")).toBe(false);
		expect(rules.filter((rule) => rule.origin === "user")).toEqual([
			expect.objectContaining({ kind: "command", command: "curl", scope: "all" }),
		]);
	});

	it.each([
		["unsupported version", { permissionRulesVersion: 2, permissionRules: [] }],
		["rules without a version", { permissionRules: [] }],
		["a version without rules", { permissionRulesVersion: 1 }],
		["invalid persisted rules", { permissionRulesVersion: 1, permissionRules: [{ id: "broken" }] }],
	] as const)("throws for %s instead of reporting no rules", async (_name, global) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(global));
		const manager = await reopened(storage);
		expect(() => manager.getPermissionRules()).toThrow();
		expect(() => manager.getAutoCommandRules()).toThrow();
	});

	it("throws for invalid legacy Auto rules rather than returning an empty list", () => {
		const manager = SettingsManager.inMemory({
			autoCommandRules: [{ command: 42, allowNetwork: "yes" }] as never,
		});
		expect(() => manager.getPermissionRules()).toThrow();
	});

	it("rejects invalid replacements without changing the current rules", () => {
		const manager = SettingsManager.inMemory();
		const before = manager.getPermissionRules();
		expect(() =>
			manager.setPermissionRules([
				{
					id: "U1",
					kind: "command",
					origin: "user",
					name: "broken",
					enabled: true,
					modes: ["auto"],
					scope: "workspace",
					directories: [],
					command: "ls",
					allowNetwork: false,
				},
				{
					id: "U1",
					kind: "command",
					origin: "user",
					name: "duplicate",
					enabled: true,
					modes: ["auto"],
					scope: "workspace",
					directories: [],
					command: "pwd",
					allowNetwork: false,
				},
			]),
		).toThrow();
		expect(manager.getPermissionRules()).toEqual(before);
	});
});
