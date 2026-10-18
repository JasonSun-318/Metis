import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCommandArgs } from "../core/prompt-templates.ts";
import { sanitizeTerminalText } from "./ansi.ts";
import { spawnProcess } from "./child-process.ts";

/** Launch asynchronously so a stopped TUI releases Windows console input. */
export function launchExternalEditor(command: string, filePath: string): Promise<number | null> {
	const [editor, ...args] = parseCommandArgs(command);
	if (!editor) return Promise.reject(new Error("No external editor configured"));
	return new Promise((resolve, reject) => {
		const child = spawnProcess(editor, [...args, filePath], { stdio: "inherit" });
		child.once("error", reject);
		child.once("close", resolve);
	});
}

type ExternalEditorTui = {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
};

/**
 * Write `text` to a temporary file, edit it with the external editor, then apply the
 * result through `setText` before cleaning up and restarting the TUI. `setText` is
 * called after the launch completes so callsites can resolve their current editor.
 * `onError` runs inside the failure path, before cleanup and restart, so callsites
 * keep their original display ordering and formatting.
 */
export async function editTextInExternalEditor(options: {
	command: string;
	text: string;
	setText: (text: string) => void;
	fileNamePrefix: string;
	fileNameSuffix: string;
	tui: ExternalEditorTui;
	onError: (error: unknown) => void;
}): Promise<void> {
	const tmpFile = path.join(os.tmpdir(), `${options.fileNamePrefix}${Date.now()}${options.fileNameSuffix}`);

	try {
		fs.writeFileSync(tmpFile, options.text, "utf-8");
		options.tui.stop();
		process.stdout.write(
			`Launching external editor: ${sanitizeTerminalText(options.command)}\nMetis will resume when the editor exits.\n`,
		);
		const status = await launchExternalEditor(options.command, tmpFile);

		if (status === 0) {
			const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
			options.setText(newContent);
		}
	} catch (error) {
		options.onError(error);
	} finally {
		try {
			fs.unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors
		}
		options.tui.start();
		// Force full re-render since external editor uses alternate screen
		options.tui.requestRender(true);
	}
}
