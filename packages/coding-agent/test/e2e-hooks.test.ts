/**
 * End-to-end: a declarative hook in hooks.json fires when a real session is
 * created through the same services path the desktop and CLI use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { saveDeclarativeHooks } from "../src/core/hooks/declarative-hooks.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("declarative hooks end-to-end", () => {
	let agentDir: string;
	let marker: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hooks-e2e-"));
		marker = path.join(agentDir, "session-started.flag");
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("fires a SessionStart hook when a session starts", async () => {
		// Install the hook: shell mode writes the event payload to a marker file.
		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-session-start",
				name: "e2e session start",
				enabled: true,
				event: "SessionStart",
				runMode: "shell",
				command: `cat > ${JSON.stringify(marker)}`,
			},
		]);

		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		// Same call the app-server runtime host makes when a session comes up.
		await session.bindExtensions({});
		session.dispose();

		expect(fs.existsSync(marker)).toBe(true);
		const payload = JSON.parse(fs.readFileSync(marker, "utf8"));
		expect(payload.event).toBe("SessionStart");
		expect(payload.hook.name).toBe("e2e session start");
		expect(payload.sessionId).toBe("e2e-session");
		expect(payload.cwd).toBe(agentDir);
	});

	it("does not fire any hook when hooks.json is empty", async () => {
		saveDeclarativeHooks(agentDir, []);
		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-2",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		await session.bindExtensions({});
		session.dispose();

		expect(fs.existsSync(marker)).toBe(false);
	});

	it("applies command-v1 SessionStart context to a newly bound session", async () => {
		saveDeclarativeHooks(agentDir, [
			{
				id: "e2e-cmd-session-start",
				name: "e2e cmd start",
				enabled: true,
				event: "SessionStart",
				protocol: "command-v1",
				runMode: "shell",
				command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"STARTUP_CONTEXT"}}'`,
			},
		]);

		const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
		const sessionManager = SessionManager.create(agentDir, path.join(agentDir, "sessions"), {
			id: "e2e-session-3",
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "ask",
		});
		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		await session.bindExtensions({});

		// The pending session start context should be captured
		expect((session as any)._pendingSessionStartContext).toBe("[Hook: e2e cmd start]\nSTARTUP_CONTEXT");
		session.dispose();
	});
});
