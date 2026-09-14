import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.ts";

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
});
