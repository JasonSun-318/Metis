import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeliverFileToolDefinition, parseDeliverFileDetails } from "../src/core/deliver-file.ts";
import {
	copySessionDeliveredFiles,
	MAX_SESSION_DELIVERED_FILES,
	resolveDeliveredFilePath,
	stageDeliveredFile,
} from "../src/core/session-attachments.ts";

describe("deliver_file", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("stages a workspace file and exposes it by file id", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const source = join(cwd, "report.txt");
		writeFileSync(source, "hello deliver");
		const sessionId = "session-deliver-test";

		const tool = createDeliverFileToolDefinition(() => ({
			cwd,
			agentDir,
			sessionId,
		}));
		const result = await tool.execute!(
			"call-1",
			{ path: "report.txt", message: "Please review" },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.details?.fileId).toMatch(/^[a-f0-9]{16}$/iu);
		expect(result.details?.name).toBe("report.txt");
		expect(result.details?.byteLength).toBe(Buffer.byteLength("hello deliver"));
		expect(result.details?.message).toBe("Please review");

		const resolved = resolveDeliveredFilePath(agentDir, sessionId, result.details!.fileId);
		expect(resolved).toBeTruthy();
		expect(readFileSync(resolved!, "utf8")).toBe("hello deliver");
	});

	it("rejects files outside the allowed workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "nope");

		expect(() =>
			stageDeliveredFile({
				agentDir,
				sessionId: "session-deliver-test",
				cwd,
				sourcePath: outside,
			}),
		).toThrow(/outside the allowed workspace/iu);
	});

	it("parses deliver file details from tool payloads", () => {
		expect(
			parseDeliverFileDetails({
				fileId: "aaaaaaaaaaaaaaaa",
				name: "report.xlsx",
				byteLength: 12,
				deliveredAt: "2026-08-18T00:00:00.000Z",
			}),
		).toMatchObject({ name: "report.xlsx" });
		expect(parseDeliverFileDetails({ fileId: "bad", name: "x", byteLength: 1, deliveredAt: "t" })).toBeUndefined();
	});

	it("uses the journal-backed delivered count instead of orphaned disk files", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "second.txt"), "second");
		const sessionId = "session-deliver-count";
		const first = stageDeliveredFile({ agentDir, sessionId, cwd, sourcePath: join(cwd, "second.txt") });
		expect(first.fileId).toMatch(/^[a-f0-9]{16}$/iu);

		expect(() =>
			stageDeliveredFile({
				agentDir,
				sessionId,
				cwd,
				sourcePath: join(cwd, "second.txt"),
				name: "blocked.txt",
				activeDeliveredFileCount: MAX_SESSION_DELIVERED_FILES,
			}),
		).toThrow(/at most 32 files/iu);
	});

	it("copies delivered files when forking a session branch", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-deliver-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, "fork-me.txt"), "fork");
		const sourceSessionId = "session-source";
		const targetSessionId = "session-target";
		const staged = stageDeliveredFile({
			agentDir,
			sessionId: sourceSessionId,
			cwd,
			sourcePath: join(cwd, "fork-me.txt"),
		});
		copySessionDeliveredFiles({
			agentDir,
			sourceSessionId,
			targetSessionId,
			fileIds: [staged.fileId],
		});
		const resolved = resolveDeliveredFilePath(agentDir, targetSessionId, staged.fileId);
		expect(resolved).toBeTruthy();
		expect(readFileSync(resolved!, "utf8")).toBe("fork");
	});
});
