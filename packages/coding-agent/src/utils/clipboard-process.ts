import { spawn } from "node:child_process";

export interface ClipboardCommandOptions {
	input?: string | Uint8Array;
	timeoutMs?: number;
	maxBufferBytes?: number;
	env?: NodeJS.ProcessEnv;
}

export interface ClipboardCommandResult {
	ok: boolean;
	stdout: Buffer;
}

export function runClipboardCommand(
	command: string,
	args: readonly string[],
	options: ClipboardCommandOptions = {},
): Promise<ClipboardCommandResult> {
	return new Promise((resolve) => {
		const maxBufferBytes = options.maxBufferBytes ?? 50 * 1024 * 1024;
		let settled = false;
		let stdoutBytes = 0;
		let timer: NodeJS.Timeout | undefined;
		const chunks: Buffer[] = [];
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ ok, stdout: ok ? Buffer.concat(chunks, stdoutBytes) : Buffer.alloc(0) });
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], {
				env: options.env,
				stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
			});
		} catch {
			resolve({ ok: false, stdout: Buffer.alloc(0) });
			return;
		}

		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, options.timeoutMs ?? 3_000);
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
		child.stdout?.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			stdoutBytes += buffer.length;
			if (stdoutBytes > maxBufferBytes) {
				child.kill("SIGKILL");
				finish(false);
				return;
			}
			chunks.push(buffer);
		});
		if (options.input !== undefined) {
			child.stdin?.once("error", () => {
				child.kill("SIGKILL");
				finish(false);
			});
			child.stdin?.end(options.input);
		}
	});
}
