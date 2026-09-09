import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { DeclarativeHook } from "../src/core/hooks/declarative-hooks.ts";
import { MAX_PIPE_BUFFER_BYTES, runHookProcess } from "../src/core/hooks/hook-bridge.ts";
import { interpretHookResult } from "../src/core/hooks/hook-protocol.ts";

const FIXTURES_DIR = path.join(__dirname, "fixtures", "hooks");

function makeHook(overrides: Partial<DeclarativeHook> = {}): DeclarativeHook {
	return {
		id: "test-proc-hook",
		name: "test-proc-hook",
		enabled: true,
		event: "PreToolUse",
		runMode: "process",
		protocol: "command-v1",
		command: process.execPath,
		args: [],
		...overrides,
	};
}

describe("hook process execution and bounds", () => {
	const cwd = os.tmpdir();

	it("executes normal JSON hook and feeds payload via stdin", async () => {
		const hook = makeHook({
			event: "SessionStart",
			args: [path.join(FIXTURES_DIR, "echo-json.mjs")],
		});
		const payload = {
			event: "SessionStart" as const,
			hook: { id: hook.id, name: hook.name },
			sessionId: "session-abc",
			cwd,
			timestamp: new Date().toISOString(),
		};

		const result = await runHookProcess(hook, payload, { cwd });
		expect(result.code).toBe(0);
		expect(result.spawnError).toBeNull();
		expect(result.timedOut).toBe(false);
		expect(result.aborted).toBe(false);
		expect(result.stdoutTruncated).toBe(false);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		const effect = interpretHookResult(hook, result);
		expect(effect.context).toContain("Echoed: session-abc");
	});

	it("handles nonexistent binary with spawn error without throwing", async () => {
		const hook = makeHook({
			command: "/nonexistent/binary/for/metis/hooks",
		});
		const payload = {
			event: "PreToolUse" as const,
			hook: { id: hook.id, name: hook.name },
			sessionId: "session-1",
			cwd,
			timestamp: new Date().toISOString(),
		};

		const result = await runHookProcess(hook, payload, { cwd });
		expect(result.spawnError).toBeTruthy();
		expect(result.code).toBeNull();

		const effect = interpretHookResult(hook, result);
		expect(effect.diagnostic).toContain("spawn");
	});

	it("captures non-zero exit codes and stderr", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "exit-code.mjs"), "1", "Something failed"],
		});
		const payload = {
			event: "PreToolUse" as const,
			hook: { id: hook.id, name: hook.name },
			sessionId: "s1",
			cwd,
			timestamp: new Date().toISOString(),
		};

		const result = await runHookProcess(hook, payload, { cwd });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Something failed");

		const effect = interpretHookResult(hook, result);
		expect(effect.diagnostic).toContain("1");
	});

	it("enforces timeout bound and terminates process tree", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "sleep.mjs"), "20000"],
			timeoutSeconds: 1,
		});
		const payload = {
			event: "PreToolUse" as const,
			hook: { id: hook.id, name: hook.name },
			sessionId: "s1",
			cwd,
			timestamp: new Date().toISOString(),
		};

		const start = Date.now();
		const result = await runHookProcess(hook, payload, { cwd });
		const duration = Date.now() - start;

		expect(result.timedOut).toBe(true);
		expect(duration).toBeLessThan(8000);

		const effect = interpretHookResult(hook, result);
		expect(effect.diagnostic).toContain("timed out");
	});

	it("aborts immediately if AbortSignal is already triggered before spawn", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "sleep.mjs"), "5000"],
		});
		const controller = new AbortController();
		controller.abort();

		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: hook.id, name: hook.name }, sessionId: "s", cwd, timestamp: "t" },
			{ cwd, signal: controller.signal },
		);

		expect(result.aborted).toBe(true);
		expect(result.code).toBeNull();
		expect(result.spawnError).toBeNull();
	});

	it("aborts while running and frees resources boundedly", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "sleep.mjs"), "20000"],
		});
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: hook.id, name: hook.name }, sessionId: "s", cwd, timestamp: "t" },
			{ cwd, signal: controller.signal },
		);

		const elapsed = Date.now() - start;
		expect(result.aborted).toBe(true);
		expect(elapsed).toBeLessThan(6000);
	});

	it("bounds stdout and stderr to 32 KiB and drains excess pipe without hang", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "large-output.mjs"), "100000"],
		});
		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: hook.id, name: hook.name }, sessionId: "s", cwd, timestamp: "t" },
			{ cwd },
		);

		expect(result.code).toBe(0);
		expect(result.stdoutTruncated).toBe(true);
		expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MAX_PIPE_BUFFER_BYTES);
	});

	it("does not hang when a grandchild process keeps inherited stdio open", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "grandchild-holder.mjs")],
			timeoutSeconds: 5,
		});

		const start = Date.now();
		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: hook.id, name: hook.name }, sessionId: "s", cwd, timestamp: "t" },
			{ cwd },
		);

		const elapsed = Date.now() - start;
		expect(result.code).toBe(0);
		// Should finish quickly via post-exit stdio grace, not hang for the full grandchild lifetime or hook timeout
		expect(elapsed).toBeLessThan(4000);
	});

	it("inherits shell environment including bundled tools and OfficeCLI flags", async () => {
		const hook = makeHook({
			args: [path.join(FIXTURES_DIR, "env-check.mjs")],
		});
		const result = await runHookProcess(
			hook,
			{ event: "PreToolUse", hook: { id: hook.id, name: hook.name }, sessionId: "s", cwd, timestamp: "t" },
			{ cwd },
		);

		expect(result.code).toBe(0);
		const envInfo = JSON.parse(result.stdout);
		expect(envInfo.officeCliSkipUpdate).toBe("1");
		expect(envInfo.hasPath).toBe(true);
	});
});
