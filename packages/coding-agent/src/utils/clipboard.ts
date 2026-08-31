import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { runClipboardCommand } from "./clipboard-process.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

async function readWith(command: string, args: readonly string[] = []): Promise<string | null> {
	const result = await runClipboardCommand(command, args, { timeoutMs: 5_000 });
	const text = result.stdout.toString("utf8");
	return result.ok && text ? text : null;
}

async function copyWith(command: string, args: readonly string[], text: string): Promise<boolean> {
	return (await runClipboardCommand(command, args, { input: text, timeoutMs: 5_000, maxBufferBytes: 0 })).ok;
}

/** Read plain text from the system clipboard using platform tools. */
export async function readClipboardText(): Promise<string | null> {
	const p = platform();
	if (p === "darwin") return readWith("pbpaste");
	if (p === "win32") return readWith("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
	if (process.env.TERMUX_VERSION) return readWith("termux-clipboard-get");
	if (isWaylandSession()) return readWith("wl-paste", ["--no-newline"]);
	return (await readWith("xclip", ["-selection", "clipboard", "-o"])) ?? readWith("xsel", ["--clipboard", "--output"]);
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	const remote = isRemoteSession();

	if (p === "darwin") {
		copied = await copyWith("pbcopy", [], text);
	} else if (p === "win32") {
		copied = await copyWith("clip", [], text);
	} else {
		if (process.env.TERMUX_VERSION) copied = await copyWith("termux-clipboard-set", [], text);

		if (!copied) {
			const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
			const hasX11Display = Boolean(process.env.DISPLAY);
			if (isWaylandSession() && hasWaylandDisplay) {
				copied = await copyWith("wl-copy", [], text);
			}
			if (!copied && hasX11Display) {
				copied =
					(await copyWith("xclip", ["-selection", "clipboard"], text)) ||
					(await copyWith("xsel", ["--clipboard", "--input"], text));
			}
		}
	}

	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
