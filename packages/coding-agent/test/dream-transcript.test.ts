import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DREAM_TRANSCRIPT_MAX_CHARS, serializeSessionForDream } from "../src/core/memory/dream/transcript.ts";
import { encodePathForStorage } from "../src/utils/paths.ts";

describe("dream transcript", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-dream-transcript-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(id: string, entries: unknown[], cwd?: string): string {
		const root = makeTemp();
		const dir = join(root, "sessions", encodePathForStorage(cwd ?? root));
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${id}.jsonl`);
		const header = {
			type: "session",
			version: 14,
			mode: "code",
			permissionPreset: "auto",
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: cwd ?? root,
		};
		writeFileSync(path, `${[header, ...entries].map((r) => JSON.stringify(r)).join("\n")}\n`, {
			mode: 0o600,
		});
		return path;
	}

	/** Per-session entry factory: ids/parentId chain must stay inside one file. */
	function chain(): (message: Record<string, unknown>) => Record<string, unknown> {
		let counter = 0;
		return (message) => {
			counter += 1;
			return {
				type: "message",
				id: `m${counter}`,
				parentId: counter === 1 ? null : `m${counter - 1}`,
				timestamp: `2026-01-01T00:00:${String(counter).padStart(2, "0")}.000Z`,
				message: { timestamp: counter * 1000, ...message },
			};
		};
	}

	it("includes user, assistant, and tool result text", () => {
		const entry = chain();
		const path = writeSession("s1", [
			entry({ role: "user", content: "please use pnpm" }),
			entry({
				role: "assistant",
				content: [
					{ type: "text", text: "running install" },
					{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm install" } },
				],
			}),
			entry({
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "added 42 packages" }],
				isError: false,
			}),
		]);
		const { text, polluted } = serializeSessionForDream(path);
		expect(text).toContain("User:\nplease use pnpm");
		expect(text).toContain("Assistant:\nrunning install");
		expect(text).toContain("Tool call: bash");
		expect(text).toContain("Tool result [bash]:\nadded 42 packages");
		expect(polluted).toBe(false);
	});

	it("redacts secret-looking lines", () => {
		const entry = chain();
		const path = writeSession("s2", [
			entry({ role: "user", content: "first line is safe\napi_key = sk-supersecretvalue123\nlast line too" }),
		]);
		const { text } = serializeSessionForDream(path);
		expect(text).toContain("first line is safe");
		expect(text).toContain("last line too");
		expect(text).toContain("[redacted]");
		expect(text).not.toContain("sk-supersecretvalue123");
	});

	it("marks sessions using web or MCP tools as polluted", () => {
		const entry = chain();
		const web = writeSession("s3", [
			entry({
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "web_fetch", arguments: { url: "https://x" } }],
			}),
			entry({
				role: "toolResult",
				toolCallId: "c1",
				toolName: "web_fetch",
				content: [{ type: "text", text: "fetched" }],
				isError: false,
			}),
		]);
		expect(serializeSessionForDream(web).polluted).toBe(true);

		const mcpEntry = chain();
		const mcp = writeSession("s4", [
			mcpEntry({
				role: "toolResult",
				toolCallId: "c1",
				toolName: "mcp__linear__list_issues",
				content: [{ type: "text", text: "issues" }],
				isError: false,
			}),
		]);
		expect(serializeSessionForDream(mcp).polluted).toBe(true);
	});

	it("keeps the tail within the transcript budget", () => {
		const entry = chain();
		const entries: unknown[] = [];
		for (let i = 0; i < 8; i++) {
			entries.push(entry({ role: "user", content: `marker-${i} ${"x".repeat(9_000)}` }));
		}
		entries.push(entry({ role: "user", content: "LAST-MARKER" }));
		const path = writeSession("s5", entries);
		const { text } = serializeSessionForDream(path);
		expect(text.length).toBeLessThanOrEqual(DREAM_TRANSCRIPT_MAX_CHARS + 100);
		expect(text).toContain("[Earlier transcript truncated]");
		expect(text).toContain("LAST-MARKER");
		expect(text).not.toContain("marker-0");
	});
});
