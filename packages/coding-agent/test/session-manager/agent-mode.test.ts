import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager agent mode", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "metis-agent-mode-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("writes code by default and writes an explicit requested mode", () => {
		const code = SessionManager.create(directory, directory);
		expect(code.getMode()).toBe("code");
		expect(JSON.parse(readFileSync(code.getSessionFile()!, "utf8").split("\n")[0])).toMatchObject({
			mode: "code",
		});
		code.close();

		const chat = SessionManager.create(directory, directory, { mode: "chat" });
		expect(chat.getMode()).toBe("chat");
		expect(chat.getHeader()).toMatchObject({ mode: "chat" });
		chat.close();
	});

	it("loads a legacy header without mode as code", () => {
		const path = join(directory, "legacy.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "legacy",
				timestamp: "2026-07-17T00:00:00.000Z",
				cwd: directory,
			})}\n`,
		);

		const session = SessionManager.open(path, directory);
		expect(session.getMode()).toBe("code");
		expect(session.getHeader()?.mode).toBeUndefined();
		session.close();
	});

	it("does not expose mutable mode state through the session header", () => {
		const session = SessionManager.inMemory(directory, { mode: "code" });
		const header = session.getHeader();
		expect(header).not.toBeNull();

		header!.mode = "chat";
		expect(session.getMode()).toBe("code");
		session.close();
	});

	it("rejects an invalid persisted mode", () => {
		const path = join(directory, "invalid.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({
				type: "session",
				version: 5,
				id: "invalid-mode",
				timestamp: "2026-07-17T00:00:00.000Z",
				cwd: directory,
				mode: "focus",
			})}\n`,
		);

		expect(() => SessionManager.open(path, directory)).toThrow("Session header has an invalid mode");
	});

	it("inherits mode for manager-level new sessions unless explicitly changed", () => {
		const session = SessionManager.inMemory(directory, { mode: "chat" });
		expect(session.getMode()).toBe("chat");

		session.newSession();
		expect(session.getMode()).toBe("chat");

		session.newSession({ mode: "code" });
		expect(session.getMode()).toBe("code");
		session.close();
	});

	it("inherits source mode for branches and forks", () => {
		const source = SessionManager.create(directory, directory, { mode: "chat" });
		const leafId = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const sourcePath = source.getSessionFile()!;

		const branch = source.createBranchedSessionManager(leafId);
		expect(branch.getMode()).toBe("chat");
		branch.close();
		source.close();

		const fork = SessionManager.forkFrom(sourcePath, directory, directory);
		expect(fork.getMode()).toBe("chat");
		fork.close();
	});

	it("exposes the effective mode in session listings", async () => {
		const chat = SessionManager.create(directory, directory, { mode: "chat" });
		const chatPath = chat.getSessionFile();
		chat.close();

		const listed = await SessionManager.list(directory, directory);
		expect(listed.find((item) => item.path === chatPath)?.mode).toBe("chat");
	});

	it("keeps stored mode when continuing and uses the requested mode only as an empty fallback", () => {
		const stored = SessionManager.create(directory, directory, { mode: "chat" });
		stored.close();

		const continued = SessionManager.continueRecent(directory, directory, { mode: "code" });
		expect(continued.getMode()).toBe("chat");
		continued.close();

		const emptyDirectory = join(directory, "empty");
		mkdirSync(emptyDirectory);
		const fallback = SessionManager.continueRecent(directory, emptyDirectory, { mode: "chat" });
		expect(fallback.getMode()).toBe("chat");
		fallback.close();
	});

	it("preserves the source mode when importing", () => {
		const source = SessionManager.create(directory, directory, { mode: "chat" });
		const sourcePath = source.getSessionFile()!;
		source.close();

		const imported = SessionManager.importFrom(sourcePath, join(directory, "imported.jsonl"));
		expect(imported.getMode()).toBe("chat");
		imported.close();
	});
});
