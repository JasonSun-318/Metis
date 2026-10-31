import { createBashTool } from "@metis/coding-agent/host";
import { describe, expect, it } from "vitest";
import { ProcessProjector } from "../src/process-projector.ts";
import { SessionProjection } from "../src/projection/session-projection.ts";

const start = (toolCallId: string, command = "echo hello") => ({
	type: "tool_execution_start" as const,
	toolCallId,
	toolName: "bash",
	args: { command },
});
const update = (toolCallId: string, text: string) => ({
	type: "tool_execution_update" as const,
	toolCallId,
	toolName: "bash",
	args: {},
	partialResult: { content: [{ type: "text", text }] },
});
const end = (toolCallId: string, text: string, isError = false) => ({
	type: "tool_execution_end" as const,
	toolCallId,
	toolName: "bash",
	isError,
	result: { content: [{ type: "text", text }] },
});

describe("Process projection", () => {
	it("tracks matching permission reviews until execution is allowed or the tool ends", () => {
		const projector = new ProcessProjector();
		const review = {
			type: "permission_review_started" as const,
			actionId: "command",
			reviewer: "user" as const,
			riskLevel: "low" as const,
		};
		projector.apply(start("command"), "child");
		expect(projector.apply(review)).toBeUndefined();
		expect(projector.apply(review, "child")?.state).toBe("awaiting_approval");
		expect(
			projector.apply({ type: "permission_decision", actionId: "command", source: "user" }, "child")?.state,
		).toBe("running");
		expect(projector.apply(end("command", "done"), "child")?.state).toBe("completed");
		expect(projector.apply(review, "child")).toBeUndefined();

		projector.apply(start("command"), "child");
		projector.apply(review, "child");
		expect(projector.apply(end("command", "Permission denied", true), "child")).toMatchObject({
			state: "failed",
			output: "Permission denied",
		});
	});

	it("keeps the latest output in reconnect snapshots", () => {
		const session = {
			sessionId: "session",
			mode: "code" as const,
			cwdOrigin: "user-selected" as const,
			cwd: "/tmp",
			createdAt: "2026-09-12T00:00:00.000Z",
			updatedAt: "2026-09-12T00:00:00.000Z",
			state: "idle" as const,
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		};
		const projection = new SessionProjection({ session });
		const projector = new ProcessProjector();
		const process = projector.apply(start("current"))!;
		projection.apply({ type: "session/processChanged", sessionId: session.sessionId, process });
		expect(projection.snapshot("epoch", 1).process).toEqual(process);
		const completed = projector.apply(end("current", "hello"))!;
		projection.apply({ type: "session/processChanged", sessionId: session.sessionId, process: completed });
		expect(projection.snapshot("epoch", 2).process).toEqual(completed);
		const retry = { attempt: 1, maxAttempts: 5, delayMs: 2000 };
		projection.apply({ type: "session/retryChanged", sessionId: session.sessionId, retry });
		expect(projection.snapshot("epoch", 3).retry).toEqual(retry);
		projection.apply({ type: "session/retryChanged", sessionId: session.sessionId, retry: null });
		expect(projection.snapshot("epoch", 4).retry).toBeUndefined();
	});
	it("streams a real shell command before it exits, then retains the final output", async () => {
		const projector = new ProcessProjector();
		const command = "printf 'first\\n'; sleep 0.15; printf 'second\\n' >&2";
		projector.apply(start("real", command));
		const outputs: string[] = [];
		const result = await createBashTool(process.cwd()).execute("real", { command }, undefined, (partialResult) => {
			const view = projector.apply({ ...update("real", ""), partialResult });
			if (view) outputs.push(view.output);
		});
		expect(outputs).toContain("first\n");
		expect(projector.apply({ ...end("real", ""), result })).toMatchObject({
			state: "completed",
			output: "first\nsecond\n",
		});
		expect(projector.apply(update("real", "late"))).toBeUndefined();
	});

	it("clears on each start and ignores older or unrelated tools, including concurrent agents", () => {
		const projector = new ProcessProjector();
		projector.apply(start("same"));
		projector.apply(update("same", "old"));
		const next = projector.apply(start("same", "new command"), "child");
		expect(next).toMatchObject({ command: "new command", output: "", state: "running" });
		expect(projector.apply(update("same", "old late"))).toBeUndefined();
		expect(projector.apply(end("same", "old done"))).toBeUndefined();
		expect(projector.apply({ ...start("other"), toolName: "read" })).toBeUndefined();
		expect(projector.apply(end("same", "failed", true), "child")).toMatchObject({
			output: "failed",
			state: "failed",
		});
		expect(projector.apply(start("empty"))).toMatchObject({ output: "", truncated: false });
		expect(projector.apply(end("empty", ""))).toMatchObject({ output: "", state: "completed" });
	});

	it("bounds UTF-8 output and preserves truncation when the error result omits details", () => {
		const projector = new ProcessProjector();
		projector.apply(start("large"));
		const view = projector.apply(update("large", "大".repeat(100_000)))!;
		expect(Buffer.byteLength(view.output)).toBeLessThanOrEqual(64 * 1024);
		expect(view.output).not.toContain("�");
		expect(view.truncated).toBe(true);
		expect(projector.apply(end("large", "Command aborted", true))?.truncated).toBe(true);
	});
});
