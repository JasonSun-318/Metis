import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { runMigrations } from "../src/migrations.ts";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe("keybindings migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves the original configuration when atomic replacement fails", () => {
		const agentDir = createAgentDir({ cursorUp: "ctrl+p" });
		const configPath = path.join(agentDir, "keybindings.json");
		const original = fs.readFileSync(configPath, "utf8");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.mocked(fs.renameSync).mockImplementationOnce(() => {
			throw new Error("replacement failed");
		});
		runMigrations(agentDir);
		expect(fs.readFileSync(configPath, "utf8")).toBe(original);
		expect(fs.readdirSync(agentDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	function createAgentDir(config: Record<string, unknown>): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-keybindings-test-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "keybindings.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return agentDir;
	}

	it("rewrites old key names to namespaced ids", () => {
		const agentDir = createAgentDir({
			cursorUp: ["up", "ctrl+p"],
			expandTools: "ctrl+x",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"tui.editor.cursorUp": ["up", "ctrl+p"],
			"app.tools.expand": "ctrl+x",
		});
	});

	it("keeps the namespaced value when old and new names both exist", () => {
		const agentDir = createAgentDir({
			expandTools: "ctrl+x",
			"app.tools.expand": "ctrl+y",
		});
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		runMigrations(agentDir);
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "keybindings.json"), "utf-8")) as Record<
			string,
			unknown
		>;
		expect(migrated).toEqual({
			"app.tools.expand": "ctrl+y",
		});
	});

	it("loads old key names in memory before the file is rewritten", () => {
		const agentDir = createAgentDir({
			selectConfirm: "enter",
			interrupt: "ctrl+x",
		});

		const keybindings = KeybindingsManager.create(agentDir);

		expect(keybindings.getUserBindings()).toEqual({
			"tui.select.confirm": "enter",
			"app.interrupt": "ctrl+x",
		});
		const effective = keybindings.getEffectiveConfig();
		expect(effective["tui.select.confirm"]).toBe("enter");
		expect(effective["app.interrupt"]).toBe("ctrl+x");
	});
});
