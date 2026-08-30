import { spawn } from "node:child_process";
import { dirname } from "node:path";

function spawnCommand(command: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with code ${String(code ?? "unknown")}`));
		});
	});
}

export async function openDeliveredFile(options: {
	readonly path: string;
	readonly action: "default" | "reveal";
}): Promise<void> {
	if (process.platform === "darwin") {
		await spawnCommand("open", options.action === "reveal" ? ["-R", options.path] : [options.path]);
		return;
	}
	if (process.platform === "win32") {
		await spawnCommand("explorer.exe", options.action === "reveal" ? [`/select,${options.path}`] : [options.path]);
		return;
	}
	await spawnCommand("xdg-open", options.action === "reveal" ? [dirname(options.path)] : [options.path]);
}
