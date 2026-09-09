import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	createHookId,
	type DeclarativeHook,
	HOOKS_CONFIG_FILENAME,
	hookMatchesTool,
	loadDeclarativeHooks,
	parseHookMatcher,
	saveDeclarativeHooks,
	validateDeclarativeHook,
} from "../src/core/hooks/declarative-hooks.ts";
import { createDeclarativeHooksBridge, runHookProcess } from "../src/core/hooks/hook-bridge.ts";

function makeHook(overrides: Partial<DeclarativeHook> = {}): DeclarativeHook {
	return {
		id: createHookId(),
		name: "test hook",
		enabled: true,
		event: "PreToolUse",
		runMode: "process",
		command: process.execPath,
		args: ["-e", "process.exit(0)"],
		...overrides,
	};
}

/** Minimal ExtensionAPI capture: records metis.on registrations. */
type CapturedHandler = (event: any, ctx: any) => Promise<any> | any;
function captureApi() {
	const handlers = new Map<string, CapturedHandler>();
	const api = {
		on: (event: string, handler: CapturedHandler) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

function makeCtx(cwd: string) {
	return {
		cwd,
		sessionManager: { getSessionId: () => "session-1" },
		signal: undefined,
	} as any;
}

describe("declarative hooks config", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hooks-test-"));
	});
	afterEach(() => fs.rmSync(agentDir, { recursive: true, force: true }));

	it("roundtrips through hooks.json", () => {
		const hook = makeHook({
			matcher: "Write, Edit",
			timeoutSeconds: 30,
			statusMessage: "running",
			metadata: { a: 1 },
		});
		saveDeclarativeHooks(agentDir, [hook]);
		const loaded = loadDeclarativeHooks(agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.hooks).toEqual([hook]);
	});

	it("returns empty when the file is missing or malformed", () => {
		expect(loadDeclarativeHooks(agentDir)).toEqual({ hooks: [], errors: [] });
		fs.writeFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), "{ not json");
		expect(loadDeclarativeHooks(agentDir)).toEqual({ hooks: [], errors: [] });
		fs.writeFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), JSON.stringify({ hooks: "nope" }));
		expect(loadDeclarativeHooks(agentDir)).toEqual({ hooks: [], errors: [] });
	});

	it("collects invalid entries as errors without dropping valid ones", () => {
		const good = makeHook();
		const bad = makeHook({ id: "bad", event: "PermissionRequest" as never });
		fs.writeFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), JSON.stringify({ hooks: [good, bad] }));
		const loaded = loadDeclarativeHooks(agentDir);
		expect(loaded.hooks).toEqual([good]);
		expect(loaded.errors).toHaveLength(1);
	});

	it("validates fields", () => {
		expect(validateDeclarativeHook(makeHook({ event: "Nope" as never }))).toContain("event");
		expect(validateDeclarativeHook(makeHook({ runMode: "nope" as never }))).toContain("runMode");
		expect(validateDeclarativeHook(makeHook({ command: "" }))).toContain("command");
		expect(validateDeclarativeHook(makeHook({ timeoutSeconds: 0 }))).toContain("timeoutSeconds");
		expect(validateDeclarativeHook(makeHook({ timeoutSeconds: 601 }))).toContain("timeoutSeconds");
		expect(validateDeclarativeHook(makeHook({ args: ["ok", 1 as never] }))).toContain("args");
		expect(validateDeclarativeHook(makeHook())).toBeNull();
	});

	it("rejects duplicate ids on save", () => {
		const hook = makeHook();
		expect(() => saveDeclarativeHooks(agentDir, [hook, hook])).toThrow(/Duplicate hook id/);
	});

	it("parses matchers case-insensitively; empty matches all", () => {
		expect(parseHookMatcher("Write, edit; bash")).toEqual(["write", "edit", "bash"]);
		expect(parseHookMatcher("   ")).toEqual([]);
		expect(hookMatchesTool(makeHook({ matcher: "Write, Edit" }), "write")).toBe(true);
		expect(hookMatchesTool(makeHook({ matcher: "Write, Edit" }), "BASH")).toBe(false);
		expect(hookMatchesTool(makeHook(), "anything")).toBe(true);
	});

	it("preserves missing protocol on legacy hooks and roundtrips command-v1", () => {
		const legacyHook = makeHook({ protocol: undefined });
		const v1Hook = makeHook({ protocol: "command-v1" });
		saveDeclarativeHooks(agentDir, [legacyHook, v1Hook]);

		const loaded = loadDeclarativeHooks(agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.hooks).toHaveLength(2);
		expect(loaded.hooks[0].protocol).toBeUndefined();
		expect(loaded.hooks[1].protocol).toBe("command-v1");

		const raw = JSON.parse(fs.readFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), "utf8"));
		expect(raw.hooks[0].protocol).toBeUndefined();
		expect(raw.hooks[1].protocol).toBe("command-v1");
	});

	it("rejects unknown protocol on validateDeclarativeHook", () => {
		expect(validateDeclarativeHook(makeHook({ protocol: "legacy" }))).toBeNull();
		expect(validateDeclarativeHook(makeHook({ protocol: "command-v1" }))).toBeNull();
		expect(validateDeclarativeHook(makeHook({ protocol: "future-v2" as never }))).toContain("protocol");
		expect(validateDeclarativeHook(makeHook({ protocol: 123 as never }))).toContain("protocol");
	});

	it("surfaces unknown protocol in hooks.json as loadError without executing or downgrading", () => {
		const good = makeHook();
		const bad = { ...makeHook({ id: "bad-proto" }), protocol: "unknown-proto" };
		fs.writeFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), JSON.stringify({ hooks: [good, bad] }));

		const loaded = loadDeclarativeHooks(agentDir);
		expect(loaded.hooks).toEqual([good]);
		expect(loaded.errors).toHaveLength(1);
		expect(loaded.errors[0]).toContain("protocol");
	});

	it("reloading reflects removal of the last hook", () => {
		const hook = makeHook();
		saveDeclarativeHooks(agentDir, [hook]);
		expect(loadDeclarativeHooks(agentDir).hooks).toHaveLength(1);

		saveDeclarativeHooks(agentDir, []);
		expect(loadDeclarativeHooks(agentDir).hooks).toEqual([]);
	});
});

describe("hook process runner", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hook-run-"));
	});
	afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

	it("feeds the payload JSON on stdin", async () => {
		const out = path.join(workDir, "payload.json");
		const hook = makeHook({
			event: "SessionStart",
			runMode: "shell",
			command: `cat > ${JSON.stringify(out)}`,
		});
		const result = await runHookProcess(
			hook,
			{
				event: "SessionStart",
				hook: { id: hook.id, name: hook.name },
				sessionId: "s1",
				cwd: workDir,
				timestamp: "t",
			},
			{ cwd: workDir },
		);
		expect(result.code).toBe(0);
		const payload = JSON.parse(fs.readFileSync(out, "utf8"));
		expect(payload.event).toBe("SessionStart");
		expect(payload.sessionId).toBe("s1");
	});

	it("kills the process after the timeout", async () => {
		const hook = makeHook({
			args: ["-e", "setTimeout(() => {}, 30_000)"],
			timeoutSeconds: 1,
		});
		const started = Date.now();
		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: "x", name: "x" }, sessionId: "s", cwd: workDir, timestamp: "t" },
			{ cwd: workDir },
		);
		expect(result.timedOut).toBe(true);
		expect(result.code).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("captures spawn errors instead of rejecting", async () => {
		const hook = makeHook({ command: "/nonexistent/metis-hook-binary" });
		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: "x", name: "x" }, sessionId: "s", cwd: workDir, timestamp: "t" },
			{ cwd: workDir },
		);
		expect(result.spawnError).toBeTruthy();
	});
});

describe("declarative hooks bridge", () => {
	let agentDir: string;
	let workDir: string;

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hooks-bridge-"));
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-hooks-bridge-work-"));
	});
	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	function installBridge(hooks: DeclarativeHook[]) {
		saveDeclarativeHooks(agentDir, hooks);
		const bridge = createDeclarativeHooksBridge(agentDir);
		expect(bridge).toBeDefined();
		const { api, handlers } = captureApi();
		if (!bridge || typeof bridge === "function") throw new Error("expected a named inline extension");
		bridge.factory(api);
		return handlers;
	}

	it("is absent without hooks.json", () => {
		expect(createDeclarativeHooksBridge(agentDir)).toBeUndefined();
		fs.writeFileSync(path.join(agentDir, HOOKS_CONFIG_FILENAME), JSON.stringify({ hooks: [] }));
		expect(createDeclarativeHooksBridge(agentDir)).toBeUndefined();
	});

	it("does not restore hooks cleared before the factory is installed", async () => {
		saveDeclarativeHooks(agentDir, [makeHook()]);
		const bridge = createDeclarativeHooksBridge(agentDir);
		if (!bridge || typeof bridge === "function") throw new Error("expected a named inline extension");
		saveDeclarativeHooks(agentDir, []);
		const { api, handlers } = captureApi();
		await bridge.factory(api);
		expect(handlers.size).toBe(0);
	});

	it("blocks a tool call when a PreToolUse hook exits 2", async () => {
		const handlers = installBridge([makeHook({ args: ["-e", "console.error('nope'); process.exit(2)"] })]);
		const handler = handlers.get("tool_call")!;
		const result = await handler(
			{ type: "tool_call", toolName: "bash", toolCallId: "tc1", input: { command: "ls" } },
			makeCtx(workDir),
		);
		expect(result).toEqual({ block: true, reason: "Blocked by hook test hook: nope" });
	});

	it("does not block on exit 0 and skips mismatched tools and disabled hooks", async () => {
		const handlers = installBridge([
			makeHook({ id: "a", name: "all", matcher: "Write" }),
			makeHook({ id: "b", name: "disabled", enabled: false, args: ["-e", "process.exit(2)"] }),
		]);
		const handler = handlers.get("tool_call")!;
		// Tool not matching "Write" and the blocking hook disabled: runs nothing blocking.
		expect(
			await handler({ type: "tool_call", toolName: "bash", toolCallId: "tc1", input: {} }, makeCtx(workDir)),
		).toBeUndefined();
		// Matching tool with exit-0 hook still does not block.
		expect(
			await handler({ type: "tool_call", toolName: "write", toolCallId: "tc2", input: {} }, makeCtx(workDir)),
		).toBeUndefined();
	});

	it("splits PostToolUse and PostToolUseFailure from one tool_result handler", async () => {
		const marker = (name: string) =>
			makeHook({
				id: name,
				name,
				event: name === "success" ? "PostToolUse" : "PostToolUseFailure",
				matcher: "bash",
				runMode: "shell",
				command: `touch ${JSON.stringify(path.join(workDir, `${name}.flag`))}`,
			});
		const handlers = installBridge([marker("success"), marker("failure")]);
		const handler = handlers.get("tool_result")!;

		await handler(
			{ type: "tool_result", toolName: "bash", toolCallId: "tc", input: {}, content: [], isError: false },
			makeCtx(workDir),
		);
		expect(fs.existsSync(path.join(workDir, "success.flag"))).toBe(true);
		expect(fs.existsSync(path.join(workDir, "failure.flag"))).toBe(false);

		await handler(
			{ type: "tool_result", toolName: "bash", toolCallId: "tc", input: {}, content: [], isError: true },
			makeCtx(workDir),
		);
		expect(fs.existsSync(path.join(workDir, "failure.flag"))).toBe(true);
	});

	it("observes input and settled events without altering them", async () => {
		const out = path.join(workDir, "input.txt");
		const handlers = installBridge([
			makeHook({
				id: "i",
				name: "echo input",
				event: "UserPromptSubmit",
				runMode: "shell",
				command: `cat > ${JSON.stringify(out)}`,
			}),
			makeHook({ id: "s", name: "stop", event: "Stop", runMode: "shell", command: "true" }),
		]);
		await handlers.get("input")!({ type: "input", text: "hello", source: "rpc" }, makeCtx(workDir));
		expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
			event: "UserPromptSubmit",
			text: "hello",
			source: "rpc",
		});
		await expect(
			handlers.get("agent_settled")!({ type: "agent_settled" }, makeCtx(workDir)),
		).resolves.toBeUndefined();
	});

	it("never throws even when the hook command cannot spawn", async () => {
		const handlers = installBridge([
			makeHook({ id: "x", name: "broken", command: "/nonexistent/metis-hook-binary" }),
		]);
		await expect(
			handlers.get("tool_call")!(
				{ type: "tool_call", toolName: "bash", toolCallId: "tc", input: {} },
				makeCtx(workDir),
			),
		).resolves.toBeUndefined();
	});
});
