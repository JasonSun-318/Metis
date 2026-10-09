import type { Input } from "electron";

/** Cmd+W on macOS and Ctrl+W elsewhere close the focused workspace tab instead of the whole window. */
export function isCloseTabShortcut(
	input: Pick<Input, "type" | "key" | "meta" | "control" | "alt" | "shift" | "isComposing">,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (input.type !== "keyDown" || input.isComposing || input.alt || input.shift) return false;
	const modifier = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
	return modifier && input.key.toLowerCase() === "w";
}
