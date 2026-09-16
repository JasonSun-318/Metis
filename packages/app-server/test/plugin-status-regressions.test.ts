import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import {
	getPluginPackageDir,
	type PluginRecord,
	readPluginSnapshot,
	withPluginRegistryLock,
} from "@metis/coding-agent/host";
import { afterEach, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { OpenedSessionRuntime, SessionRuntimeHost } from "../src/session-runtime-host.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pluginRecord(id: string, commit: string): PluginRecord {
	return {
		id,
		name: id,
		displayName: id,
		format: "claude",
		repository: "https://github.com/example/plugins",
		subdir: id,
		commit,
		sourceId: "test-market",
		enabled: true,
		installedAt: new Date(0).toISOString(),
		issues: [],
	};
}

function writeRegistry(agentDir: string, installed: PluginRecord[]): void {
	withPluginRegistryLock(agentDir, (current) => ({
		next: { ...current, revision: current.revision + 1, installed },
		result: undefined,
	}));
}

function writeNormalized(agentDir: string, plugin: PluginRecord, content: string | object): void {
	const packageDir = getPluginPackageDir(agentDir, plugin.id, plugin.commit);
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "normalized.json"), typeof content === "string" ? content : JSON.stringify(content));
}

function healthyPackage(plugin: PluginRecord): object {
	return {
		pluginId: plugin.id,
		commit: plugin.commit,
		format: plugin.format,
		name: plugin.name,
		displayName: plugin.displayName,
		description: "",
		components: [],
		issues: [],
	};
}

function runtimeHost(agentDir: string, error?: string): SessionRuntimeHost {
	return {
		open: async (ref) => {
			const runtime = {
				sessionId: ref.summary.sessionId,
				isActive: () => false,
				hasPendingInteractions: () => false,
				getSummary: () => ref.summary,
				getPluginRuntimeStatus: () => ({
					sessionId: ref.summary.sessionId,
					appliedFingerprint: readPluginSnapshot(agentDir).fingerprint,
					...(error === undefined ? {} : { error }),
				}),
				close: async () => {},
			};
			return runtime as unknown as OpenedSessionRuntime;
		},
	};
}

async function initialize(server: AppServer) {
	const connection = server.connect();
	await connection.handle({
		jsonrpc: "2.0",
		id: "init",
		method: "initialize",
		params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
	});
	return connection;
}

it("reports broken active packages without mislabeling a healthy plugin", async () => {
	const root = mkdtempSync(join(tmpdir(), "metis-plugin-status-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionsRoot = join(agentDir, "sessions");
	mkdirSync(projectDir, { recursive: true });

	const missing = pluginRecord("a".repeat(64), "1".repeat(40));
	const corrupt = pluginRecord("b".repeat(64), "2".repeat(40));
	const healthy = pluginRecord("c".repeat(64), "3".repeat(40));
	writeRegistry(agentDir, [missing, corrupt, healthy]);
	writeNormalized(agentDir, corrupt, "{broken");
	writeNormalized(agentDir, healthy, healthyPackage(healthy));

	const server = await AppServer.create({
		agentDir,
		sessionsRoot,
		runtimeHost: runtimeHost(agentDir),
		titleGenerator: { generate: async () => undefined },
	});
	try {
		const connection = await initialize(server);
		const sessionId = "10000000-0000-4000-8000-000000000001";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: { requestId: sessionId, cwd: projectDir, permissionPreset: "full" },
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		const getPlugin = async (pluginId: string) =>
			(await connection.handle({
				jsonrpc: "2.0",
				id: `get-${pluginId}`,
				method: "plugin/get",
				params: { pluginId },
			})) as { result: { activation: string; runtimeErrors: Array<{ componentId: string; message: string }> } };

		const missingResult = await getPlugin(missing.id);
		expect(missingResult.result.activation).toBe("failed");
		expect(missingResult.result.runtimeErrors).toContainEqual({
			componentId: missing.id,
			message: `Plugin package files for ${missing.displayName} are missing`,
		});

		const corruptResult = await getPlugin(corrupt.id);
		expect(corruptResult.result.activation).toBe("failed");
		expect(corruptResult.result.runtimeErrors).toContainEqual({
			componentId: corrupt.id,
			message: `Plugin package manifest for ${corrupt.displayName} is corrupted`,
		});

		const healthyResult = await getPlugin(healthy.id);
		expect(healthyResult.result.activation).toBe("applied");
		expect(healthyResult.result.runtimeErrors).toEqual([]);

		const setEnabledResult = (await connection.handle({
			jsonrpc: "2.0",
			id: "set-enabled-missing",
			method: "plugin/setEnabled",
			params: {
				requestId: "30000000-0000-4000-8000-000000000001",
				pluginId: missing.id,
				enabled: true,
				expectedRevision: 2,
			},
		})) as {
			result: { plugin: { activation: string; runtimeErrors: Array<{ componentId: string; message: string }> } };
		};
		expect(setEnabledResult.result.plugin.activation).toBe("failed");
		expect(setEnabledResult.result.plugin.runtimeErrors).toContainEqual({
			componentId: missing.id,
			message: `Plugin package files for ${missing.displayName} are missing`,
		});
	} finally {
		server.beginShutdown();
		await server.waitForShutdown();
	}
});

it("keeps host runtime error component IDs in plugin diagnostics", async () => {
	const root = mkdtempSync(join(tmpdir(), "metis-plugin-status-host-error-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const sessionsRoot = join(agentDir, "sessions");
	mkdirSync(projectDir, { recursive: true });

	const healthy = pluginRecord("d".repeat(64), "4".repeat(40));
	writeRegistry(agentDir, [healthy]);
	writeNormalized(agentDir, healthy, healthyPackage(healthy));

	const server = await AppServer.create({
		agentDir,
		sessionsRoot,
		runtimeHost: runtimeHost(agentDir, "reload failed"),
		titleGenerator: { generate: async () => undefined },
	});
	try {
		const connection = await initialize(server);
		const sessionId = "20000000-0000-4000-8000-000000000001";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: { requestId: sessionId, cwd: projectDir, permissionPreset: "full" },
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		const response = (await connection.handle({
			jsonrpc: "2.0",
			id: "get-healthy",
			method: "plugin/get",
			params: { pluginId: healthy.id },
		})) as { result: { activation: string; runtimeErrors: Array<{ componentId: string; message: string }> } };
		expect(response.result.activation).toBe("failed");
		expect(response.result.runtimeErrors).toEqual([{ componentId: sessionId, message: "reload failed" }]);
	} finally {
		server.beginShutdown();
		await server.waitForShutdown();
	}
});
