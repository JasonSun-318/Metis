import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSession(name: string): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "metis-fork-"));
	directories.push(directory);
	return SessionManager.create(directory, directory, { id: name, mode: "chat", cwdOrigin: "user-selected" });
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("session fork branch creation", () => {
	it("creates an independent branch at an assistant reply with a fresh id and forked name", () => {
		const session = createSession("original");
		const user = session.appendMessage(userMsg("hello"));
		const assistant = session.appendMessage(assistantMsg("reply"));
		void user;

		// The app-server fork implementation performs exactly these steps:
		// createBranchedSessionManager(entryId) then appendSessionInfo(name).
		const branch = session.createBranchedSessionManager(assistant);
		const forkedName = "fork original";
		branch.appendSessionInfo(forkedName);
		const forkedId = branch.getSessionId();
		expect(forkedId).not.toBe("original");
		const sessionFile = branch.getSessionFile();
		expect(sessionFile).toBeDefined();
		branch.close();

		// The forked session is an independent, persisted file that carries the
		// branch path (including the assistant reply) and the forked name.
		const reopened = SessionManager.open(sessionFile!);
		try {
			expect(reopened.getSessionId()).toBe(forkedId);
			expect(reopened.getSessionName()).toBe(forkedName);
			const entries = reopened.getEntries().filter((entry) => entry.type === "message");
			expect(entries.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
		} finally {
			reopened.close();
		}

		// The original session is untouched and remains open.
		expect(session.getSessionId()).toBe("original");
		expect(session.getEntries()).toHaveLength(2);
		session.close();
	});

	it("rejects forking from an unknown entry id", () => {
		const session = createSession("original");
		session.appendMessage(userMsg("hello"));

		expect(() => session.createBranchedSessionManager("does-not-exist")).toThrow("Entry does-not-exist not found");
		session.close();
	});

	it("forks from a user message with the same branch semantics", () => {
		const session = createSession("original");
		const user = session.appendMessage(userMsg("hello"));
		session.appendMessage(assistantMsg("reply"));

		const branch = session.createBranchedSessionManager(user);
		const forkedId = branch.getSessionId();
		expect(forkedId).not.toBe("original");
		const sessionFile = branch.getSessionFile()!;
		branch.close();

		const reopened = SessionManager.open(sessionFile);
		try {
			const entries = reopened.getEntries().filter((entry) => entry.type === "message");
			// Branch rooted at the user message keeps only that message.
			expect(entries.map((entry) => entry.message.role)).toEqual(["user"]);
		} finally {
			reopened.close();
		}
		session.close();
	});
});
