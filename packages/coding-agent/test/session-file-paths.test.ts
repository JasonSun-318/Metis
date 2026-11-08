import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir, getSessionsDir } from "../src/config.ts";
import {
	getSessionAgentDir,
	getSessionDisplayMetadataPath,
	getSessionImageDir,
	getSessionToolOutputDir,
	getSessionUnreadStatePath,
} from "../src/core/session-file-paths.ts";
import { createSessionId } from "../src/core/session-id.ts";
import { canonicalizePathForCreation, resolvePath } from "../src/utils/paths.ts";

describe("session file paths", () => {
	it("keeps default-session assets under the agent images/tool-results roots", () => {
		const sessionFile = join(getSessionsDir(), "project", "session.jsonl");
		const canonical = canonicalizePathForCreation(sessionFile);
		const key = createHash("sha256").update(resolve(canonical)).digest("hex");
		const agentDir = canonicalizePathForCreation(getAgentDir());
		expect(getSessionImageDir(sessionFile)).toBe(join(agentDir, "images", key));
		expect(getSessionToolOutputDir(sessionFile)).toBe(join(agentDir, "tool-results", key));
	});

	it("places non-default session assets next to the session file", () => {
		const sessionFile = join("/tmp", "metis-session-assets", "session.jsonl");
		const canonical = canonicalizePathForCreation(sessionFile);
		const key = createHash("sha256").update(resolve(canonical)).digest("hex");
		expect(getSessionImageDir(sessionFile)).toBe(join(dirname(canonical), "images", key));
	});

	it("derives metadata and unread paths from the canonical session path", () => {
		const sessionFile = join("/tmp", "metis-session-paths", "session.jsonl");
		const canonical = canonicalizePathForCreation(sessionFile);
		expect(getSessionDisplayMetadataPath(sessionFile)).toBe(`${canonical}.metadata.json`);
		expect(getSessionUnreadStatePath(sessionFile)).toBe(`${canonical}.unread.json`);
	});

	it("builds the agent directory only for valid session ids", () => {
		const sessionId = createSessionId();
		expect(getSessionAgentDir("/tmp/metis-agent", sessionId)).toBe(
			join(resolvePath("/tmp/metis-agent"), "agents", sessionId),
		);
		expect(() => getSessionAgentDir("/tmp/metis-agent", "../escape")).toThrow();
	});
});
