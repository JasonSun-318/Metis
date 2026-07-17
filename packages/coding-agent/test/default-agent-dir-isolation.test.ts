import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("test session isolation", () => {
	it("keeps default session journals out of the user's agent directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "arcmind-session-isolation-"));
		try {
			const agentDir = getAgentDir();
			const fromTmp = relative(tmpdir(), agentDir);
			expect(fromTmp).not.toBe("..");
			expect(fromTmp.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)).toBe(false);
			expect(isAbsolute(fromTmp)).toBe(false);

			const manager = SessionManager.create(cwd);
			try {
				expect(manager.getSessionFile()?.startsWith(agentDir)).toBe(true);
			} finally {
				manager.close();
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
