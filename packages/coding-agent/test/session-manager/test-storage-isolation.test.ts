import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

function inside(parent: string, path: string): boolean {
	const child = relative(parent, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

it("isolates default session and fork storage from the real user agent directory", () => {
	// Check the runner guard before invoking either default-writing API.
	const configured = process.env.METIS_CODING_AGENT_DIR;
	expect(configured).toBeTruthy();
	const agentDir = realpathSync(getAgentDir());
	expect(agentDir).toBe(realpathSync(configured!));
	expect(inside(realpathSync(tmpdir()), agentDir)).toBe(true);
	expect(agentDir).not.toBe(join(homedir(), ".metis", "agent"));
	const temporary = realpathSync(mkdtempSync(join(tmpdir(), "metis-storage-isolation-")));
	const cwd = join(temporary, "source");
	const targetCwd = join(temporary, "fork");
	mkdirSync(cwd);
	mkdirSync(targetCwd);
	let source: SessionManager | undefined;
	let fork: SessionManager | undefined;
	try {
		source = SessionManager.create(cwd);
		source.appendSessionInfo("Storage isolation fixture");
		const sourceFile = source.getSessionFile()!;
		expect(inside(join(agentDir, "sessions"), realpathSync(sourceFile)), sourceFile).toBe(true);
		source.close();
		fork = SessionManager.forkFrom(sourceFile, targetCwd);
		expect(inside(join(agentDir, "sessions"), realpathSync(fork.getSessionFile()!))).toBe(true);
		expect(fork.getCwd()).toBe(targetCwd);
	} finally {
		fork?.close();
		source?.close();
		rmSync(temporary, { recursive: true, force: true });
	}
});
