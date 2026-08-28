import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";

let agentDir: string;
let host: AgentSessionRuntimeHost;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "metis-agent-type-methods-"));
	host = new AgentSessionRuntimeHost({ agentDir });
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

const auditorType = {
	id: "auditor",
	displayName: "Auditor",
	description: "Read-only audit role.",
	allowedTools: ["read", "grep"],
	systemPrompt: "Cite file paths.",
	writePolicy: "deny" as const,
	mayDelegate: false,
};

describe("agentType methods", () => {
	it("lists only built-in types before any customization", async () => {
		const listed = await host.listAgentTypes();
		expect(listed.types.map((type) => type.id)).toEqual(["default", "explorer", "worker", "reviewer"]);
		expect(listed.types.every((type) => type.builtIn)).toBe(true);
		expect(listed.types.find((type) => type.id === "explorer")?.writePolicy).toBe("deny");
	});

	it("upserts a custom type, lists it after built-ins, and rejects built-in ids", async () => {
		await host.upsertAgentType({ requestId: crypto.randomUUID(), type: { ...auditorType } });
		const listed = await host.listAgentTypes();
		expect(listed.types.map((type) => type.id)).toEqual(["default", "explorer", "worker", "reviewer", "auditor"]);
		const auditor = listed.types.find((type) => type.id === "auditor");
		expect(auditor?.builtIn).toBe(false);
		expect(auditor?.systemPrompt).toBe("Cite file paths.");
		await expect(
			host.upsertAgentType({ requestId: crypto.randomUUID(), type: { ...auditorType, id: "explorer" } }),
		).rejects.toThrow();
	});

	it("removes a custom type and reports unknown ids", async () => {
		await host.upsertAgentType({ requestId: crypto.randomUUID(), type: { ...auditorType } });
		const removed = await host.removeAgentType({ requestId: crypto.randomUUID(), id: "auditor" });
		expect(removed.id).toBe("auditor");
		expect((await host.listAgentTypes()).types.map((type) => type.id)).not.toContain("auditor");
		await expect(host.removeAgentType({ requestId: crypto.randomUUID(), id: "auditor" })).rejects.toThrow();
	});
});
