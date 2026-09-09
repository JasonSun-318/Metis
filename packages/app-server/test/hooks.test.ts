import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HooksService } from "../src/hooks.ts";

const HOOK_A = {
	id: "11111111-2222-4333-8444-555555555555",
	name: "Block dangerous bash",
	enabled: true,
	event: "PreToolUse",
	matcher: "bash",
	runMode: "shell",
	command: "echo blocked >&2; exit 2",
	timeoutSeconds: 30,
} as const;

const HOOK_B = {
	id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	name: "Notify on stop",
	enabled: false,
	event: "Stop" as const,
	runMode: "process" as const,
	command: "/usr/bin/true",
	args: ["--flag"],
};

describe("HooksService", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-hooks-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("lists empty defaults", () => {
		expect(new HooksService(agentDir).view()).toEqual({ hooks: [], loadErrors: [] });
	});

	it("upserts, updates by id, and persists canonically", () => {
		const svc = new HooksService(agentDir);
		expect(svc.upsert({ hook: HOOK_A })).toEqual({ hooks: [HOOK_A], loadErrors: [] });

		const updated = { ...HOOK_A, name: "Renamed", enabled: false };
		expect(svc.upsert({ hook: updated })).toEqual({ hooks: [updated], loadErrors: [] });

		const onDisk = JSON.parse(readFileSync(join(agentDir, "hooks.json"), "utf8"));
		expect(onDisk).toEqual({ hooks: [updated] });
		// Empty optional fields are dropped from the persisted form.
		expect(onDisk.hooks[0].statusMessage).toBeUndefined();
		// Legacy hook without protocol is NOT upgraded when edited.
		expect(onDisk.hooks[0].protocol).toBeUndefined();
	});

	it("roundtrips command-v1 protocol and preserves it on disk", () => {
		const svc = new HooksService(agentDir);
		const v1Hook = { ...HOOK_A, id: "22222222-3333-4444-8555-666666666666", protocol: "command-v1" as const };
		expect(svc.upsert({ hook: v1Hook })).toEqual({ hooks: [v1Hook], loadErrors: [] });

		const onDisk = JSON.parse(readFileSync(join(agentDir, "hooks.json"), "utf8"));
		expect(onDisk.hooks[0].protocol).toBe("command-v1");
	});

	it("appends a second hook and deletes by id", () => {
		const svc = new HooksService(agentDir);
		svc.upsert({ hook: HOOK_A });
		const afterAdd = svc.upsert({ hook: HOOK_B });
		expect(afterAdd.hooks.map((hook) => hook.id)).toEqual([HOOK_A.id, HOOK_B.id]);

		const afterDelete = svc.delete({ id: HOOK_A.id });
		expect(afterDelete.hooks).toEqual([HOOK_B]);
		expect(new HooksService(agentDir).view().hooks).toEqual([HOOK_B]);
	});

	it("fails to delete an unknown hook", () => {
		const svc = new HooksService(agentDir);
		expect(() => svc.delete({ id: "missing" })).toThrow();
	});

	it("rejects invalid hooks with OPERATION_FAILED", () => {
		const svc = new HooksService(agentDir);
		expect(() => svc.upsert({ hook: { ...HOOK_A, event: "PermissionRequest" as never } })).toThrow(
			/OPERATION_FAILED/,
		);
		// Nothing was persisted.
		expect(svc.view().hooks).toEqual([]);
	});

	it("surfaces malformed on-disk entries as loadErrors while keeping valid ones", () => {
		const svc = new HooksService(agentDir);
		svc.upsert({ hook: HOOK_A });
		const onDisk = JSON.parse(readFileSync(join(agentDir, "hooks.json"), "utf8"));
		onDisk.hooks.push({ id: "bad", name: "bad", enabled: true, event: "Nope", runMode: "shell", command: "x" });
		writeFileSync(join(agentDir, "hooks.json"), JSON.stringify(onDisk));

		const view = svc.view();
		expect(view.hooks.map((hook) => hook.id)).toEqual([HOOK_A.id]);
		expect(view.loadErrors).toHaveLength(1);
	});

	it("produces protocol-valid responses", () => {
		const svc = new HooksService(agentDir);
		const listRequest = {
			jsonrpc: "2.0" as const,
			id: "hooks-list",
			method: "hooks/list" as const,
			params: {},
		};
		expect(() =>
			validateResponseFor("client", listRequest, { jsonrpc: "2.0", id: listRequest.id, result: svc.view() }),
		).not.toThrow();

		const upsertRequest = {
			jsonrpc: "2.0" as const,
			id: "hooks-upsert",
			method: "hooks/upsert" as const,
			params: { hook: HOOK_B },
		};
		expect(() =>
			validateResponseFor("client", upsertRequest, {
				jsonrpc: "2.0",
				id: upsertRequest.id,
				result: svc.upsert(upsertRequest.params),
			}),
		).not.toThrow();
	});

	it("lists plugin hooks alongside user hooks, and prevents editing or deleting plugin hooks", () => {
		const pkgDir = join(agentDir, "plugins", "packages", "plug-1", "commit1");
		mkdirSync(pkgDir, { recursive: true });
		mkdirSync(join(agentDir, "plugins"), { recursive: true });

		writeFileSync(
			join(agentDir, "plugins", "registry.json"),
			JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				markets: [],
				installed: [
					{
						id: "plug-1",
						name: "plug-1",
						displayName: "Plugin One",
						format: "claude",
						repository: "user/repo",
						commit: "commit1",
						installedAt: new Date().toISOString(),
						enabled: true,
					},
				],
			}),
		);

		const pluginHook = {
			id: "hook-plugin-1",
			name: "Plugin Lint Hook",
			enabled: true,
			event: "PreToolUse" as const,
			runMode: "shell" as const,
			protocol: "command-v1" as const,
			command: "echo test",
		};

		writeFileSync(
			join(pkgDir, "normalized.json"),
			JSON.stringify({
				pluginId: "plug-1",
				commit: "commit1",
				format: "claude",
				name: "plug-1",
				displayName: "Plugin One",
				components: [
					{
						kind: "hook",
						componentId: "lint-hook",
						name: "Plugin Lint Hook",
						definition: pluginHook,
					},
				],
			}),
		);

		const svc = new HooksService(agentDir);
		svc.upsert({ hook: HOOK_A });

		const view = svc.view();
		expect(view.hooks).toHaveLength(2);
		expect(view.hooks[0]).toEqual(HOOK_A);
		expect(view.hooks[1]).toMatchObject({
			...pluginHook,
			pluginOwner: {
				pluginId: "plug-1",
				displayName: "Plugin One",
				componentId: "lint-hook",
			},
		});

		// Cannot delete a plugin hook
		expect(() => svc.delete({ id: "hook-plugin-1" })).toThrow(/OPERATION_FAILED/);

		// Cannot upsert with pluginOwner
		expect(() =>
			svc.upsert({
				hook: {
					...HOOK_B,
					pluginOwner: { pluginId: "plug-1", displayName: "Plugin One", componentId: "lint-hook" },
				},
			}),
		).toThrow(/OPERATION_FAILED/);

		// Cannot overwrite a plugin hook ID
		expect(() =>
			svc.upsert({
				hook: {
					...HOOK_B,
					id: "hook-plugin-1",
				},
			}),
		).toThrow(/OPERATION_FAILED/);
	});
});
