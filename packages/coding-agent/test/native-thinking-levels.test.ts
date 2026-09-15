import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "metis-native-thinking-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	return { root, cwd, agentDir };
}

describe("native thinking levels", () => {
	it("offers only the selected model's native levels", async () => {
		const { cwd, agentDir } = setup();
		const model = getModel("openai-codex", "gpt-5.5")!;
		const created = await createAgentSession({ cwd, agentDir, model });
		expect(created.session.getAvailableThinkingSelections()).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		created.session.setThinkingSelection("xhigh");
		expect(created.session.getThinkingSelection()).toBe("xhigh");
		expect(created.session.thinkingLevel).toBe("xhigh");
		expect(
			created.session.sessionManager
				.getDurableJournalSnapshot()
				.some((entry) => (entry.type as string) === "session_ultra_selection"),
		).toBe(false);
		created.session.dispose();
	});

	it("clamps the selection to each model's native levels across switches and restarts", async () => {
		const { cwd, agentDir } = setup();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.set("openai-codex", { type: "api_key", key: "test-codex-key" });
		authStorage.set("google", { type: "api_key", key: "test-google-key" });
		authStorage.set("openai", { type: "api_key", key: "test-openai-key" });

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("openai-codex", "gpt-6-astra")!,
			authStorage,
		});
		created.session.setThinkingSelection("max");
		expect(created.session.getThinkingSelection()).toBe("max");

		await created.session.setModel(getModel("google", "gemini-3.1-pro-preview")!);
		expect(created.session.getAvailableThinkingSelections()).toEqual(["low", "high"]);
		expect(created.session.getThinkingSelection()).toBe("high");

		await created.session.setModel(getModel("openai", "gpt-4")!);
		expect(created.session.getThinkingSelection()).toBe("off");
		created.session.dispose();

		const sessionsRoot = join(agentDir, "sessions");
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
			);
		const sessionFile = walk(sessionsRoot).find((file) => file.endsWith(".jsonl"));
		expect(sessionFile).toBeTruthy();
		const reopened = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			sessionManager: SessionManager.open(sessionFile!),
		});
		expect(reopened.session.getThinkingSelection()).toBe("off");
		expect(
			reopened.session.sessionManager
				.getDurableJournalSnapshot()
				.some((entry) => (entry.type as string) === "session_ultra_selection"),
		).toBe(false);
		reopened.session.dispose();
	});

	it("keeps the saved default level when a model switch clamps the selection to off", async () => {
		const { cwd, agentDir } = setup();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.set("openai-codex", { type: "api_key", key: "test-codex-key" });
		authStorage.set("openai", { type: "api_key", key: "test-openai-key" });

		const created = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("openai-codex", "gpt-6-astra")!,
			authStorage,
		});
		created.session.setThinkingSelection("high");
		expect(created.session.settingsManager.getDefaultThinkingLevel()).toBe("high");

		await created.session.setModel(getModel("openai", "gpt-4")!);
		expect(created.session.getThinkingSelection()).toBe("off");
		expect(created.session.settingsManager.getDefaultThinkingLevel()).toBe("high");
		created.session.dispose();
	});
});
