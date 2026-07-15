/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   arcmind --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@arcmind/coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(arcmind: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = arcmind.getSessionName();
	return session ? `ArcMind - ${session} - ${cwd}` : `ArcMind - ${cwd}`;
}

export default function (arcmind: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(arcmind));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = arcmind.getSessionName();
			const title = session ? `${frame} ArcMind - ${session} - ${cwd}` : `${frame} ArcMind - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	arcmind.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	arcmind.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	arcmind.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
