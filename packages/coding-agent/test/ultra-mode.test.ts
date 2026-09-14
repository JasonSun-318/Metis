import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, getSupportedThinkingLevels } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelPattern } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getHighestSupportedThinkingLevel, isThinkingSelection } from "../src/core/thinking-selection.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "metis-ultra-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	return { root, cwd, agentDir };
}

describe("Ultra composite thinking selection", () => {
	it("keeps ultra out of provider thinking and persists the selection independently", async () => {
		const { cwd, agentDir } = setup();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({ cwd, agentDir, model, ultraAvailable: true });

		session.setThinkingSelection("ultra");
		expect(session.getThinkingSelection()).toBe("ultra");
		expect(session.thinkingLevel).toBe(getHighestSupportedThinkingLevel(model));
		expect(getSupportedThinkingLevels(model)).toContain(session.thinkingLevel);
		expect(session.sessionManager.getUltraSelected()).toBe(true);
		expect(session.sessionManager.getDurableJournalSnapshot().at(-2)?.type).not.toBe("thinking_level_change");
		expect(
			session.sessionManager
				.getDurableJournalSnapshot()
				.some((entry) => entry.type === "session_ultra_selection" && entry.selected),
		).toBe(true);

		session.setThinkingSelection("low");
		expect(session.getThinkingSelection()).toBe("low");
		expect(session.sessionManager.getUltraSelected()).toBe(false);
		session.dispose();
	});

	it("rejects Ultra for in-memory or raw recovery hosts", async () => {
		const { cwd, agentDir } = setup();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const memory = SessionManager.inMemory(cwd);
		const created = await createAgentSession({ cwd, agentDir, model, sessionManager: memory });
		expect(() => created.session.setThinkingSelection("ultra")).toThrow("persisted primary Code AgentSessionRuntime");
		created.session.dispose();
	});

	it("never offers Ultra to a persisted Chat session even when the host supports orchestration", async () => {
		const { root, cwd, agentDir } = setup();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const manager = SessionManager.create(cwd, join(root, "sessions"), { mode: "chat" });
		const created = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: manager,
			ultraAvailable: true,
		});

		expect(created.session.getAvailableThinkingSelections()).not.toContain("ultra");
		expect(() => created.session.setThinkingSelection("ultra")).toThrow("persisted primary Code AgentSessionRuntime");
		expect(created.session.sessionManager.getUltraSelected()).toBe(false);
		created.session.dispose();
	});

	it("keeps custom providers on the common thinking levels", async () => {
		const { cwd, agentDir } = setup();
		const model = {
			...getModel("anthropic", "claude-sonnet-4-5")!,
			provider: "my-custom-provider",
			thinkingLevelMap: { minimal: null },
		};
		const created = await createAgentSession({ cwd, agentDir, model, ultraAvailable: true });

		expect(created.session.getAvailableThinkingSelections()).toEqual(["off", "low", "medium", "high"]);
		expect(() => created.session.setThinkingSelection("ultra")).toThrow("persisted primary Code AgentSessionRuntime");
		created.session.dispose();
	});

	it("restores Ultra from a reopened persisted session without storing it as a provider level", async () => {
		const { cwd, agentDir } = setup();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const created = await createAgentSession({ cwd, agentDir, model, ultraAvailable: true });
		created.session.setThinkingSelection("ultra");
		const sessionFile = created.session.sessionManager.getSessionFile()!;
		created.session.dispose();

		const resumed = await createAgentSession({
			cwd,
			agentDir,
			model,
			ultraAvailable: true,
			sessionManager: SessionManager.open(sessionFile),
		});
		expect(resumed.session.getThinkingSelection()).toBe("ultra");
		expect(resumed.session.thinkingLevel).toBe(getHighestSupportedThinkingLevel(model));
		expect(JSON.stringify(resumed.session.sessionManager.getDurableJournalSnapshot())).not.toContain(
			'"thinkingLevel":"ultra"',
		);
		resumed.session.dispose();
	});

	it("recognizes Ultra only in the coding-agent selection type", () => {
		expect(isThinkingSelection("ultra")).toBe(true);
		expect(isThinkingSelection("maximum")).toBe(false);
	});

	it("parses Ultra as a model-selection suffix without turning it into a provider level", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		expect(parseModelPattern(`${model.id}:ultra`, [model])).toMatchObject({ model, thinkingLevel: "ultra" });
	});

	it("restores a saved Ultra preference only in a capable host and otherwise warns with a safe fallback", async () => {
		const capable = setup();
		SettingsManager.create(capable.cwd, capable.agentDir).setDefaultThinkingLevel("ultra");
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const supported = await createAgentSession({
			cwd: capable.cwd,
			agentDir: capable.agentDir,
			model,
			ultraAvailable: true,
		});
		expect(supported.session.getThinkingSelection()).toBe("ultra");
		expect(supported.session.thinkingLevel).toBe(getHighestSupportedThinkingLevel(model));
		supported.session.dispose();

		const unsupported = setup();
		SettingsManager.create(unsupported.cwd, unsupported.agentDir).setDefaultThinkingLevel("ultra");
		const fallback = await createAgentSession({ cwd: unsupported.cwd, agentDir: unsupported.agentDir, model });
		expect(fallback.session.getThinkingSelection()).not.toBe("ultra");
		expect(fallback.session.thinkingLevel).toBe(getHighestSupportedThinkingLevel(model));
		expect(fallback.modelFallbackMessage).toContain("Saved Ultra preference is unavailable");
		fallback.session.dispose();
	});
});
