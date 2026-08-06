import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type IDisposable, type IPty, spawn as spawnPty } from "node-pty";
import type {
	DesktopCreateTerminalInput,
	DesktopResizeTerminalInput,
	DesktopTerminalEvent,
	DesktopTerminalInfo,
	DesktopWriteTerminalInput,
} from "../shared/desktop-api.ts";

type SpawnPty = typeof spawnPty;

interface TerminalRecord {
	readonly process: IPty;
	readonly data: IDisposable;
	readonly exit: IDisposable;
}

function loginShell(): { readonly file: string; readonly args: string[] } {
	if (process.platform === "win32") {
		return { file: process.env.ComSpec || "powershell.exe", args: [] };
	}
	const configured = process.env.SHELL;
	const file =
		configured && isAbsolute(configured) && existsSync(configured)
			? configured
			: existsSync("/bin/zsh")
				? "/bin/zsh"
				: "/bin/bash";
	return { file, args: ["-l"] };
}

function shellEnvironment(): Record<string, string> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

export class TerminalManager {
	private readonly terminals = new Map<string, TerminalRecord>();
	private readonly creating = new Set<string>();
	private readonly listeners = new Set<(event: DesktopTerminalEvent) => void>();
	private readonly spawn: SpawnPty;

	constructor(spawn: SpawnPty = spawnPty) {
		this.spawn = spawn;
	}

	onEvent(listener: (event: DesktopTerminalEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async create(input: DesktopCreateTerminalInput): Promise<DesktopTerminalInfo> {
		if (this.terminals.has(input.terminalId) || this.creating.has(input.terminalId)) {
			throw new Error("Terminal already exists");
		}
		this.creating.add(input.terminalId);
		try {
			const cwd = await realpath(input.cwd);
			if (!(await stat(cwd)).isDirectory()) throw new Error("Terminal working directory is not a directory");
			const shell = loginShell();
			const process = this.spawn(shell.file, shell.args, {
				name: "xterm-256color",
				cols: input.cols,
				rows: input.rows,
				cwd,
				env: shellEnvironment(),
			});
			let record!: TerminalRecord;
			const data = process.onData((value) => this.emit({ type: "data", terminalId: input.terminalId, data: value }));
			const exit = process.onExit(({ exitCode, signal }) => {
				if (this.terminals.get(input.terminalId) !== record) return;
				this.terminals.delete(input.terminalId);
				data.dispose();
				exit.dispose();
				this.emit({
					type: "exit",
					terminalId: input.terminalId,
					exitCode,
					...(signal === undefined ? {} : { signal }),
				});
			});
			record = { process, data, exit };
			this.terminals.set(input.terminalId, record);
			return { terminalId: input.terminalId, pid: process.pid, cwd, shell: shell.file };
		} finally {
			this.creating.delete(input.terminalId);
		}
	}

	write(input: DesktopWriteTerminalInput): void {
		const terminal = this.terminals.get(input.terminalId);
		if (!terminal) throw new Error("Terminal is not running");
		terminal.process.write(input.data);
	}

	resize(input: DesktopResizeTerminalInput): void {
		const terminal = this.terminals.get(input.terminalId);
		if (!terminal) throw new Error("Terminal is not running");
		terminal.process.resize(input.cols, input.rows);
	}

	close(terminalId: string): void {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) return;
		this.terminals.delete(terminalId);
		terminal.data.dispose();
		terminal.exit.dispose();
		terminal.process.kill();
	}

	closeAll(): void {
		for (const terminalId of [...this.terminals.keys()]) this.close(terminalId);
	}

	private emit(event: DesktopTerminalEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
