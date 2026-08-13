import type { AuthStorage, AuthStorageChange, McpServerSettings, SettingsManager } from "@metis/coding-agent";
import { describe, expect, it, vi } from "vitest";
import { persistMcpChanges } from "../src/agent-session-runtime-host.ts";

const previous = { command: "node", args: ["old.mjs"] } satisfies McpServerSettings;
const next = { command: "node", args: ["new.mjs"] } satisfies McpServerSettings;

function harness(failure?: "settings" | "auth" | "reload") {
	let definitions = new Map<string, McpServerSettings | undefined>([["worker", previous]]);
	let credentials = new Map<string, unknown>();
	let settingsCalls = 0;
	let authCalls = 0;
	let reloadCalls = 0;
	let settingsFailureReported = false;
	const settingsManager = {
		applyMcpServerChanges: vi.fn((_scope: string, changes: ReadonlyMap<string, McpServerSettings | undefined>) => {
			settingsCalls += 1;
			definitions = new Map(definitions);
			for (const [name, value] of changes) definitions.set(name, value);
		}),
		flush: vi.fn().mockResolvedValue(undefined),
		drainErrors: vi.fn(() => {
			if (failure !== "settings" || settingsCalls !== 1 || settingsFailureReported) return [];
			settingsFailureReported = true;
			return [{ scope: "global", error: new Error("settings failed") }];
		}),
	} as unknown as SettingsManager;
	const authStorage = {
		get: vi.fn((provider: string) => credentials.get(provider)),
		applyChanges: vi.fn((changes: readonly AuthStorageChange[]) => {
			authCalls += 1;
			credentials = new Map(credentials);
			for (const change of changes) {
				if (change.credential) credentials.set(change.provider, structuredClone(change.credential));
				else credentials.delete(change.provider);
			}
			if (failure === "auth" && authCalls === 1) throw new Error("auth failed");
		}),
	} as unknown as AuthStorage;
	const reload = vi.fn(async () => {
		reloadCalls += 1;
		if (failure === "reload" && reloadCalls === 1) throw new Error("reload failed");
	});
	return {
		authStorage,
		definitions: () => definitions,
		credentials: () => credentials,
		reload,
		settingsManager,
	};
}

describe("MCP persistence transaction", () => {
	it("writes definitions, credentials, and runtime once on success", async () => {
		const state = harness();
		await persistMcpChanges({
			settingsManager: state.settingsManager,
			authStorage: state.authStorage,
			cwd: "/work/project",
			scope: "user",
			changes: new Map([["worker", { previous, next, credential: { environment: { TOKEN: "secret" } } }]]),
			reload: state.reload,
		});

		expect(state.settingsManager.applyMcpServerChanges).toHaveBeenCalledTimes(1);
		expect(state.authStorage.applyChanges).toHaveBeenCalledTimes(1);
		expect(state.reload).toHaveBeenCalledTimes(1);
		expect(state.definitions().get("worker")).toEqual(next);
		expect([...state.credentials().values()]).toEqual([
			expect.objectContaining({ type: "mcp_secret", env: { TOKEN: "secret" } }),
		]);
	});

	it.each(["settings", "auth", "reload"] as const)("restores exact snapshots after a %s failure", async (failure) => {
		const state = harness(failure);
		await expect(
			persistMcpChanges({
				settingsManager: state.settingsManager,
				authStorage: state.authStorage,
				cwd: "/work/project",
				scope: "user",
				changes: new Map([["worker", { previous, next, credential: { environment: { TOKEN: "secret" } } }]]),
				reload: state.reload,
			}),
		).rejects.toThrow(`${failure} failed`);

		expect(state.definitions().get("worker")).toEqual(previous);
		expect(state.credentials().size).toBe(0);
		expect(state.settingsManager.applyMcpServerChanges).toHaveBeenCalledTimes(2);
		expect(state.reload).toHaveBeenCalledTimes(failure === "reload" ? 2 : 1);
	});
});
