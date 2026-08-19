import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { resolveDeliveredFilePath } from "@metis/coding-agent";

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
	readonly agentDir: string;
	readonly sessionId: string;
	readonly fileId: string;
	readonly action: "default" | "reveal";
}): Promise<void> {
	const path = resolveDeliveredFilePath(options.agentDir, options.sessionId, options.fileId);
	if (!path) throw new Error("Delivered file was not found");

	if (process.platform === "darwin") {
		await spawnCommand("open", options.action === "reveal" ? ["-R", path] : [path]);
		return;
	}
	if (process.platform === "win32") {
		await spawnCommand("explorer.exe", options.action === "reveal" ? [`/select,${path}`] : [path]);
		return;
	}
	await spawnCommand("xdg-open", options.action === "reveal" ? [dirname(path)] : [path]);
}
