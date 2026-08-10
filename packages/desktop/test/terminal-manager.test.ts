import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalManager } from "../src/main/terminal-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("TerminalManager", () => {
	it("owns one PTY and forwards only its data, input, resize, and close lifecycle", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "metis-terminal-"));
		temporaryDirectories.push(cwd);
		let dataListener: ((data: string) => void) | undefined;
		let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
		const pty = {
			pid: 4321,
			cols: 80,
			rows: 24,
			process: "zsh",
			handleFlowControl: false,
			onData: vi.fn((listener) => {
				dataListener = listener;
				return { dispose: vi.fn() };
			}),
			onExit: vi.fn((listener) => {
				exitListener = listener;
				return { dispose: vi.fn() };
			}),
			write: vi.fn(),
			resize: vi.fn(),
			kill: vi.fn(),
			clear: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
		};
		const spawn = vi.fn(() => pty);
		const manager = new TerminalManager(spawn as never);
		const events: unknown[] = [];
		manager.onEvent((event) => events.push(event));
		const terminalId = "10000000-0000-4000-8000-000000000099";

		await expect(manager.create({ terminalId, cwd, cols: 80, rows: 24 })).resolves.toEqual({
			terminalId,
			pid: 4321,
			cwd: await realpath(cwd),
			shell: expect.any(String),
		});
		expect(spawn).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({
				cwd: await realpath(cwd),
				cols: 80,
				rows: 24,
				name: "xterm-256color",
			}),
		);

		dataListener?.("ready\r\n");
		expect(events).toEqual([{ type: "data", terminalId, data: "ready\r\n" }]);
		manager.write({ terminalId, data: "pwd\r" });
		manager.resize({ terminalId, cols: 120, rows: 40 });
		expect(pty.write).toHaveBeenCalledWith("pwd\r");
		expect(pty.resize).toHaveBeenCalledWith(120, 40);

		manager.close(terminalId);
		expect(pty.kill).toHaveBeenCalledTimes(1);
		exitListener?.({ exitCode: 0 });
		expect(events).toHaveLength(1);
		expect(() => manager.write({ terminalId, data: "late" })).toThrow("Terminal is not running");
	});
});
