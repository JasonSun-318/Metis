import { describe, expect, it } from "vitest";
import type { DeclarativeHook } from "../src/core/hooks/declarative-hooks.ts";
import type { HookPayload, HookRunResult } from "../src/core/hooks/hook-bridge.ts";
import {
	buildCommandHookPayload,
	interpretHookResult,
	mapToolInput,
	matchHook,
	validateHookMatcher,
} from "../src/core/hooks/hook-protocol.ts";

function makeHook(overrides: Partial<DeclarativeHook> = {}): DeclarativeHook {
	return {
		id: "test-hook-id",
		name: "test-hook",
		enabled: true,
		event: "PreToolUse",
		runMode: "process",
		protocol: "command-v1",
		command: "echo",
		...overrides,
	};
}

function makeRun(overrides: Partial<HookRunResult & { stdoutTruncated?: boolean }> = {}): HookRunResult & {
	stdoutTruncated?: boolean;
} {
	return {
		code: 0,
		signal: null,
		timedOut: false,
		aborted: false,
		spawnError: null,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		...overrides,
	};
}

function makePayload(overrides: Partial<HookPayload> = {}): HookPayload {
	return {
		event: "PreToolUse",
		hook: { id: "test-hook-id", name: "test-hook" },
		sessionId: "session-123",
		cwd: "/workspace/project",
		timestamp: "2026-09-09T00:00:00.000Z",
		...overrides,
	};
}

describe("hook-protocol matcher", () => {
	it("validates regex matchers in command-v1", () => {
		expect(validateHookMatcher(makeHook({ event: "PreToolUse", matcher: "Bash|Read" }))).toBeNull();
		expect(validateHookMatcher(makeHook({ event: "PreToolUse", matcher: "*" }))).toBeNull();
		expect(validateHookMatcher(makeHook({ event: "PreToolUse", matcher: "" }))).toBeNull();
		expect(validateHookMatcher(makeHook({ event: "PreToolUse", matcher: undefined }))).toBeNull();
		expect(validateHookMatcher(makeHook({ event: "PreToolUse", matcher: "[invalid(" }))).toContain("regex");
	});

	it("rejects non-empty matchers for Stop and UserPromptSubmit in command-v1", () => {
		expect(validateHookMatcher(makeHook({ event: "Stop", matcher: "bash" }))).toContain("not applicable");
		expect(validateHookMatcher(makeHook({ event: "UserPromptSubmit", matcher: "bash" }))).toContain("not applicable");
		expect(validateHookMatcher(makeHook({ event: "Stop", matcher: "" }))).toBeNull();
		expect(validateHookMatcher(makeHook({ event: "Stop", matcher: undefined }))).toBeNull();
	});

	it("matches tool events against real tool names and compatible aliases", () => {
		const bashHook = makeHook({ event: "PreToolUse", matcher: "^Bash$" });
		expect(matchHook(bashHook, { toolName: "bash" })).toBe(true);
		expect(matchHook(bashHook, { toolName: "Bash" })).toBe(true);
		expect(matchHook(bashHook, { toolName: "read" })).toBe(false);

		const globHook = makeHook({ event: "PreToolUse", matcher: "Glob" });
		expect(matchHook(globHook, { toolName: "find" })).toBe(true);

		const grepHook = makeHook({ event: "PreToolUse", matcher: "Grep" });
		expect(matchHook(grepHook, { toolName: "grep" })).toBe(true);

		const multiHook = makeHook({ event: "PreToolUse", matcher: "Read|Write" });
		expect(matchHook(multiHook, { toolName: "read" })).toBe(true);
		expect(matchHook(multiHook, { toolName: "write" })).toBe(true);
		expect(matchHook(multiHook, { toolName: "edit" })).toBe(false);

		const starHook = makeHook({ event: "PreToolUse", matcher: "*" });
		expect(matchHook(starHook, { toolName: "any_custom_tool" })).toBe(true);
	});

	it("matches MCP tools by their real registered identifiers only", () => {
		const mcpHook = makeHook({ event: "PreToolUse", matcher: "^mcp__github__.*" });
		expect(matchHook(mcpHook, { toolName: "mcp__github__create_issue" })).toBe(true);
		expect(matchHook(mcpHook, { toolName: "mcp__slack__post_message" })).toBe(false);
	});

	it("matches SessionStart against startup reason", () => {
		const startHook = makeHook({ event: "SessionStart", matcher: "^(user|startup)$" });
		expect(matchHook(startHook, { reason: "user" })).toBe(true);
		expect(matchHook(startHook, { reason: "resume" })).toBe(false);
	});

	it("preserves legacy matcher semantics when protocol is legacy or omitted", () => {
		const legacyHook = makeHook({ protocol: "legacy", matcher: "Write, Edit; BASH" });
		expect(matchHook(legacyHook, { toolName: "write" })).toBe(true);
		expect(matchHook(legacyHook, { toolName: "bash" })).toBe(true);
		expect(matchHook(legacyHook, { toolName: "read" })).toBe(false);
	});
});

describe("hook-protocol payload builder", () => {
	it("builds command-v1 compatibility fields for tool events", () => {
		const hook = makeHook({ event: "PreToolUse" });
		const payload = makePayload({
			event: "PreToolUse",
			toolName: "read",
			toolCallId: "tc-99",
			input: { path: "src/index.ts", offset: 1, limit: 50 },
		});

		const built = buildCommandHookPayload(hook, payload);
		expect(built.hook_event_name).toBe("PreToolUse");
		expect(built.session_id).toBe("session-123");
		expect(built.cwd).toBe("/workspace/project");
		expect(built.tool_name).toBe("Read");
		expect(built.toolName).toBe("read");
		expect(built.tool_use_id).toBe("tc-99");
		expect(built.tool_input).toEqual({ file_path: "src/index.ts", offset: 1, limit: 50 });
	});

	it("maps tool input path -> file_path for read, write, edit without inventing apply_patch", () => {
		expect(mapToolInput("read", { path: "foo.txt", offset: 10 })).toEqual({
			file_path: "foo.txt",
			offset: 10,
		});
		expect(mapToolInput("write", { path: "out.txt", content: "hello" })).toEqual({
			file_path: "out.txt",
			content: "hello",
		});
		const edits = [{ oldText: "a", newText: "b" }];
		expect(mapToolInput("edit", { path: "src/code.ts", edits })).toEqual({
			file_path: "src/code.ts",
			edits,
		});
		// bash, grep, find inputs keep their arguments
		expect(mapToolInput("bash", { command: "ls", timeout: 5 })).toEqual({ command: "ls", timeout: 5 });
		expect(mapToolInput("grep", { pattern: "test", path: "src" })).toEqual({ pattern: "test", path: "src" });
	});

	it("builds command-v1 compatibility fields for prompt, result, stop, and failure", () => {
		const promptBuilt = buildCommandHookPayload(
			makeHook({ event: "UserPromptSubmit" }),
			makePayload({ event: "UserPromptSubmit", text: "Please run tests" }),
		);
		expect(promptBuilt.prompt).toBe("Please run tests");

		const resultBuilt = buildCommandHookPayload(
			makeHook({ event: "PostToolUse" }),
			makePayload({
				event: "PostToolUse",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
			}),
		);
		expect(resultBuilt.tool_name).toBe("Bash");
		expect(resultBuilt.tool_response).toMatchObject({
			content: [{ type: "text", text: "ok" }],
			isError: false,
		});

		const stopBuilt = buildCommandHookPayload(
			makeHook({ event: "Stop" }),
			makePayload({
				event: "Stop",
				stopHookActive: true,
				lastAssistantMessage: "All tasks completed.",
			}),
		);
		expect(stopBuilt.stop_hook_active).toBe(true);
		expect(stopBuilt.last_assistant_message).toBe("All tasks completed.");
	});

	it("keeps legacy payload without compatibility fields when protocol is legacy", () => {
		const legacyHook = makeHook({ protocol: "legacy", event: "PreToolUse" });
		const payload = makePayload({ event: "PreToolUse", toolName: "read", toolCallId: "tc-1", input: { path: "a" } });
		const built = buildCommandHookPayload(legacyHook, payload);
		expect(built.toolName).toBe("read");
		expect(built.hook_event_name).toBeUndefined();
		expect(built.tool_name).toBeUndefined();
		expect(built.tool_input).toBeUndefined();
	});
});

describe("hook-protocol result interpreter matrix", () => {
	it("interprets successful additionalContext for each event", () => {
		// SessionStart
		const startEffect = interpretHookResult(
			makeHook({ event: "SessionStart" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: "Project guidelines: npm test",
					},
				}),
			}),
		);
		expect(startEffect).toEqual({ context: "Project guidelines: npm test" });

		// UserPromptSubmit
		const promptEffect = interpretHookResult(
			makeHook({ event: "UserPromptSubmit" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "UserPromptSubmit",
						additionalContext: "Use node 22",
					},
				}),
			}),
		);
		expect(promptEffect).toEqual({ context: "Use node 22" });

		// PreToolUse
		const preEffect = interpretHookResult(
			makeHook({ event: "PreToolUse" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: "Extra tool note",
					},
				}),
			}),
		);
		expect(preEffect).toEqual({ context: "Extra tool note" });

		// PostToolUse
		const postEffect = interpretHookResult(
			makeHook({ event: "PostToolUse" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "Tool output advice",
					},
				}),
			}),
		);
		expect(postEffect).toEqual({ context: "Tool output advice" });

		// PostToolUseFailure
		const failEffect = interpretHookResult(
			makeHook({ event: "PostToolUseFailure" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PostToolUseFailure",
						additionalContext: "Fallback suggestion",
					},
				}),
			}),
		);
		expect(failEffect).toEqual({ context: "Fallback suggestion" });
	});

	it("interprets allowed blocking decisions for UserPromptSubmit and PreToolUse", () => {
		const promptBlock = interpretHookResult(
			makeHook({ event: "UserPromptSubmit" }),
			makeRun({ stdout: JSON.stringify({ decision: "block", reason: "Cannot submit prompt" }) }),
		);
		expect(promptBlock).toEqual({ blockReason: "Cannot submit prompt" });

		const preDeny = interpretHookResult(
			makeHook({ event: "PreToolUse" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "Dangerous command",
					},
				}),
			}),
		);
		expect(preDeny).toEqual({ blockReason: "Dangerous command" });
	});

	it("interprets allowed continuation for Stop event with decision:block and reason", () => {
		const stopContinue = interpretHookResult(
			makeHook({ event: "Stop" }),
			makeRun({
				stdout: JSON.stringify({
					decision: "block",
					reason: "Please verify test suite results before finishing",
				}),
			}),
		);
		expect(stopContinue).toEqual({ continueReason: "Please verify test suite results before finishing" });
	});

	it("diagnoses disallowed blocking decisions on SessionStart, PostToolUse, PostToolUseFailure, and empty Stop reason", () => {
		const startBlock = interpretHookResult(
			makeHook({ event: "SessionStart" }),
			makeRun({ stdout: JSON.stringify({ decision: "block", reason: "Disallowed" }) }),
		);
		expect(startBlock.diagnostic).toContain("SessionStart");
		expect(startBlock.blockReason).toBeUndefined();

		const postBlock = interpretHookResult(
			makeHook({ event: "PostToolUse" }),
			makeRun({ stdout: JSON.stringify({ decision: "block", reason: "Disallowed" }) }),
		);
		expect(postBlock.diagnostic).toContain("PostToolUse");
		expect(postBlock.blockReason).toBeUndefined();

		const stopEmptyReason = interpretHookResult(
			makeHook({ event: "Stop" }),
			makeRun({ stdout: JSON.stringify({ decision: "block", reason: "" }) }),
		);
		expect(stopEmptyReason.diagnostic).toContain("reason");
		expect(stopEmptyReason.continueReason).toBeUndefined();
	});

	it("rejects mismatched hookEventName in output", () => {
		const mismatch = interpretHookResult(
			makeHook({ event: "SessionStart" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						additionalContext: "Hello",
					},
				}),
			}),
		);
		expect(mismatch.diagnostic).toContain("mismatch");
		expect(mismatch.context).toBeUndefined();
	});

	it("reports diagnostics for unsupported behavior fields without executing them", () => {
		const allowOutput = interpretHookResult(
			makeHook({ event: "PreToolUse" }),
			makeRun({
				stdout: JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "allow",
					},
				}),
			}),
		);
		expect(allowOutput.diagnostic).toContain("allow");
		expect(allowOutput.blockReason).toBeUndefined();

		const updatedInputOutput = interpretHookResult(
			makeHook({ event: "PreToolUse" }),
			makeRun({
				stdout: JSON.stringify({
					updatedInput: { command: "rm -rf /" },
				}),
			}),
		);
		expect(updatedInputOutput.diagnostic).toContain("updatedInput");
	});

	it("handles malformed JSON, JSON arrays, and truncated output", () => {
		expect(
			interpretHookResult(makeHook({ event: "UserPromptSubmit" }), makeRun({ stdout: "['item1', 'item2']" }))
				.diagnostic,
		).toContain("array");

		expect(
			interpretHookResult(makeHook({ event: "UserPromptSubmit" }), makeRun({ stdout: "{ broken json" })).diagnostic,
		).toContain("invalid JSON");

		expect(
			interpretHookResult(
				makeHook({ event: "UserPromptSubmit" }),
				makeRun({ stdout: '{"decision": "block"', stdoutTruncated: true }),
			).diagnostic,
		).toContain("truncated");
	});

	it("treats plain text as context for SessionStart and UserPromptSubmit only", () => {
		expect(
			interpretHookResult(makeHook({ event: "SessionStart" }), makeRun({ stdout: "Some plain prompt" })),
		).toEqual({ context: "Some plain prompt" });

		expect(
			interpretHookResult(makeHook({ event: "UserPromptSubmit" }), makeRun({ stdout: "Additional info" })),
		).toEqual({ context: "Additional info" });

		const preText = interpretHookResult(makeHook({ event: "PreToolUse" }), makeRun({ stdout: "echoed message" }));
		expect(preText.context).toBeUndefined();
		expect(preText.diagnostic).toBeDefined();
	});

	it("enforces exit code 2 precedence over stdout JSON and falls back through stderr, stdout, default", () => {
		const runWithStderr = makeRun({
			code: 2,
			stderr: "stderr reason",
			stdout: JSON.stringify({ decision: "block", reason: "stdout reason" }),
		});
		expect(interpretHookResult(makeHook({ event: "PreToolUse" }), runWithStderr)).toEqual({
			blockReason: "stderr reason",
		});

		const runWithStdoutOnly = makeRun({
			code: 2,
			stderr: "",
			stdout: "stdout plain reason",
		});
		expect(interpretHookResult(makeHook({ event: "PreToolUse" }), runWithStdoutOnly)).toEqual({
			blockReason: "stdout plain reason",
		});

		const runEmpty = makeRun({
			code: 2,
			stderr: "",
			stdout: "",
		});
		expect(interpretHookResult(makeHook({ event: "PreToolUse" }), runEmpty).blockReason).toBeTruthy();
	});

	it("produces diagnostic for non 0/2 exit codes and process errors", () => {
		const exit1 = interpretHookResult(makeHook({ event: "PreToolUse" }), makeRun({ code: 1 }));
		expect(exit1.diagnostic).toContain("1");
		expect(exit1.blockReason).toBeUndefined();

		const timedOut = interpretHookResult(makeHook({ event: "PreToolUse" }), makeRun({ timedOut: true }));
		expect(timedOut.diagnostic).toContain("timed out");

		const spawnErr = interpretHookResult(makeHook({ event: "PreToolUse" }), makeRun({ spawnError: "ENOENT" }));
		expect(spawnErr.diagnostic).toContain("spawn");
	});
});
