import { describe, expect, it } from "vitest";
import { mcpCredentialKey, mcpVersionedCredentialKey } from "../src/core/auth-storage.ts";
import { mcpConfigurationRevision } from "../src/core/mcp/configuration.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("MCP configuration transaction primitives", () => {
	it("uses an opaque credential version without replacing the legacy scoped key", () => {
		const identity = { scope: "project", name: "docs", cwd: "/work/project" } as const;
		const legacy = mcpCredentialKey(identity);
		const versioned = mcpVersionedCredentialKey(identity, "server-fingerprint", "credential-version");

		expect(legacy).toContain("mcp:v2:project:");
		expect(versioned).toContain("mcp:v3:project:");
		expect(versioned).toContain(":server-fingerprint:credential-version");
		expect(versioned).not.toBe(legacy);
	});

	it("includes the non-secret credential version in the public conflict revision", () => {
		const first = { command: "node", credentialVersion: "first" } as const;
		const second = { command: "node", credentialVersion: "second" } as const;

		expect(mcpConfigurationRevision("user", "docs", first)).not.toBe(
			mcpConfigurationRevision("user", "docs", second),
		);
	});

	it("rejects stale definitions inside the settings write lock", async () => {
		const storage = new InMemorySettingsStorage();
		const writer = SettingsManager.fromStorage(storage);
		const stale = SettingsManager.fromStorage(storage);
		writer.setMcpServer("global", "docs", { command: "node", args: ["first.mjs"] });
		await writer.flushOrThrow();
		await stale.reload();

		const previous = stale.getGlobalSettings().mcpServers?.docs;
		writer.setMcpServer("global", "docs", { command: "node", args: ["second.mjs"] });
		await writer.flushOrThrow();

		const committed = await stale.commitMcpServerChanges(
			"global",
			new Map([["docs", previous]]),
			new Map([["docs", { command: "node", args: ["stale.mjs"] }]]),
		);

		expect(committed).toBe(false);
		expect(SettingsManager.fromStorage(storage).getGlobalSettings().mcpServers?.docs).toEqual({
			command: "node",
			args: ["second.mjs"],
		});
	});

	it("commits a batch only when every expected definition still matches", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		settings.applyMcpServerChanges(
			"global",
			new Map([
				["docs", { command: "node", args: ["docs.mjs"] }],
				["search", { url: "https://mcp.example.test/search" }],
			]),
		);
		await settings.flushOrThrow();
		const current = settings.getGlobalSettings().mcpServers!;

		const committed = await settings.commitMcpServerChanges(
			"global",
			new Map([
				["docs", current.docs],
				["search", current.search],
			]),
			new Map([
				["docs", { command: "node", args: ["next.mjs"] }],
				["search", undefined],
			]),
		);

		expect(committed).toBe(true);
		expect(settings.getGlobalSettings().mcpServers).toEqual({
			docs: { command: "node", args: ["next.mjs"] },
		});
	});
});
