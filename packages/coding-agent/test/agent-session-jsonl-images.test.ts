import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getSessionImageDir, SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg } from "./utilities.ts";

describe("JSONL image export and import", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `arcmind-jsonl-images-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("exports one portable file and imports it into hash-backed storage", async () => {
		const data = Buffer.from("portable image").toString("base64");
		const source = SessionManager.create(tempDir, join(tempDir, "source-sessions"), { mode: "chat" });
		source.appendMessage({
			role: "user",
			content: [{ type: "image", data, mimeType: "image/png" }],
			timestamp: 1,
		});
		source.appendMessage(assistantMsg("ok"));

		const exportPath = join(tempDir, "export", "portable.jsonl");
		const session = { sessionManager: source } as unknown as AgentSession;
		AgentSession.prototype.exportToJsonl.call(session, exportPath);
		const exported = readFileSync(exportPath, "utf8");
		expect(JSON.parse(exported.split("\n")[0])).toMatchObject({ mode: "chat" });
		expect(exported).toContain(data);
		expect(exported).not.toContain('"type":"image_ref"');
		expect(existsSync(join(tempDir, "export", "images"))).toBe(false);

		const destinationDir = join(tempDir, "imported-sessions");
		mkdirSync(destinationDir);
		let imported: SessionManager | undefined;
		const importedManagers: SessionManager[] = [];
		const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), {
			_session: {
				sessionManager: { getSessionDir: () => destinationDir },
				sessionFile: undefined,
				assertCanDrainAgentEventPersistence: () => {},
			},
			_services: { cwd: tempDir, agentDir: tempDir },
			disposeRequested: false,
			lifecycleTail: Promise.resolve(),
			emitBeforeSwitch: async () => ({ cancelled: false }),
			teardownCurrent: async () => {},
			createRuntime: async ({ sessionManager }: { sessionManager: SessionManager }) => {
				imported = sessionManager;
				importedManagers.push(sessionManager);
				return {};
			},
			apply: () => {},
			finishSessionReplacement: async () => {},
		}) as AgentSessionRuntime;

		await AgentSessionRuntime.prototype.importFromJsonl.call(runtime, exportPath);
		expect(imported!.getMode()).toBe("chat");

		const importedPath = join(destinationDir, basename(exportPath));
		const stored = readFileSync(importedPath, "utf8");
		expect(stored).toContain('"type":"image_ref"');
		expect(stored).not.toContain(data);
		expect(existsSync(getSessionImageDir(importedPath))).toBe(true);
		const message = imported!.buildSessionContext().messages[0];
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toEqual([{ type: "image", data, mimeType: "image/png" }]);

		const sameDirectoryPath = join(destinationDir, "same-directory.jsonl");
		AgentSession.prototype.exportToJsonl.call(session, sameDirectoryPath);
		expect(readFileSync(sameDirectoryPath, "utf8")).toContain(data);

		await AgentSessionRuntime.prototype.importFromJsonl.call(runtime, sameDirectoryPath);
		const sameDirectoryStored = readFileSync(sameDirectoryPath, "utf8");
		expect(sameDirectoryStored).toContain('"type":"image_ref"');
		expect(sameDirectoryStored).not.toContain(data);

		for (const sessionManager of importedManagers) {
			sessionManager.close();
		}
		source.close();
	});
});
