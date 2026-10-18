import { parseCommandArgs } from "../core/prompt-templates.ts";
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
