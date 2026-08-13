import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./child-process.ts";

const TRASH_TIMEOUT_MS = 30_000;

/**
 * Build a PowerShell script that moves each path to the Windows Recycle Bin via
 * Microsoft.VisualBasic.FileIO. Paths are embedded as single-quoted literals
 * (embedded quotes doubled), so no `--` separator or shell quoting applies.
 */
function windowsTrashScript(paths: readonly string[]): string {
	const lines = ["Add-Type -AssemblyName Microsoft.VisualBasic"];
	for (const path of paths) {
		const quoted = `'${path.replaceAll("'", "''")}'`;
		lines.push(
			`if (Test-Path -LiteralPath ${quoted} -PathType Container) { ` +
				`[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${quoted}, 'OnlyErrorDialogs', 'SendToRecycleBin') } ` +
				`else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${quoted}, 'OnlyErrorDialogs', 'SendToRecycleBin') }`,
		);
	}
	return lines.join("\n");
}

function trashViaWindowsRecycleBin(paths: readonly string[]): string | undefined {
	const result = spawnProcessSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", windowsTrashScript(paths)],
		{ encoding: "utf8", timeout: TRASH_TIMEOUT_MS, windowsHide: true },
	);
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? result.stderr?.trim().split("\n")[0];
		return `Recycle Bin trash failed${detail ? `: ${detail}` : ` with status ${result.status ?? "unknown"}`}`;
	}
	return undefined;
}

/**
 * Move a set of paths to the OS trash. Returns a failure detail string when the
 * trash attempt itself failed (callers re-check path existence to decide whether
 * targets were actually removed), or undefined when the attempt succeeded.
 *
 * On Windows the `trash` CLI is not available, so items are moved to the Recycle
 * Bin through PowerShell's Microsoft.VisualBasic.FileIO. Elsewhere the `trash`
 * CLI is used, preserving prior behavior.
 */
export function trashPathsSync(paths: readonly string[]): string | undefined {
	if (paths.length === 0) return undefined;
	if (process.platform === "win32") {
		return trashViaWindowsRecycleBin(paths);
	}
	const trashArgs = paths.some((path) => path.startsWith("-")) ? ["--", ...paths] : [...paths];
	const result = spawnProcessSync("trash", trashArgs, { encoding: "utf8" });
	if (result.error || result.status !== 0) {
		return (
			result.error?.message ?? result.stderr?.trim().split("\n")[0] ?? `Trash exited with status ${result.status}`
		);
	}
	return undefined;
}

/** Move a single path to the OS trash, throwing on failure. */
export async function trashPath(path: string): Promise<void> {
	if (process.platform === "win32") {
		const detail = trashViaWindowsRecycleBin([path]);
		if (detail) throw new Error(`Trash failed: ${detail}`);
		return;
	}
	const child = spawnProcess("trash", [path], { stdio: "ignore", timeout: TRASH_TIMEOUT_MS });
	const exitCode = await waitForChildProcess(child);
	if (exitCode !== 0) throw new Error(`Trash exited with status ${exitCode ?? "unknown"}`);
}
