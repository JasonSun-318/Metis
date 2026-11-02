import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./child-process.ts";

const TRASH_TIMEOUT_MS = 30_000;

/**
 * JXA driver for -[NSFileManager trashItemAtURL:resultingItemURL:error:].
 * Paths arrive through osascript run-args, never inside the script source.
 * The script prints the first failure's localized description; empty stdout
 * means every path was trashed. Works on every macOS release, unlike the
 * `trash` CLI which only ships with macOS 26+.
 */
const MACOS_TRASH_SCRIPT = `
ObjC.import("Foundation");
function run(argv) {
	const fm = $.NSFileManager.defaultManager;
	for (const raw of argv) {
		const error = $();
		const ok = fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(ObjC.unwrap(raw)), null, error);
		if (!ok) return ObjC.unwrap(error.localizedDescription) || "trashItemAtURL failed";
	}
	return "";
}`;

function trashViaMacOSFileManager(paths: readonly string[]): string | undefined {
	const result = spawnProcessSync("osascript", ["-l", "JavaScript", "-e", MACOS_TRASH_SCRIPT, "--", ...paths], {
		encoding: "utf8",
		timeout: TRASH_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		return (
			result.error?.message ??
			result.stderr?.trim().split("\n")[0] ??
			`osascript exited with status ${result.status ?? "unknown"}`
		);
	}
	return result.stdout?.trim() || undefined;
}

/**
 * C# interop for the modern shell file-operation API. Interface IIDs and
 * method order follow ShObjIdl_core.h.
 *
 * Microsoft.VisualBasic.FileIO.FileSystem canonicalizes through
 * SHFileOperation, whose path handling is bounded by MAX_PATH, so long session
 * log paths fail there with "file not found" even though Node can access them.
 * IFileOperation + SHCreateItemFromParsingName is the current shell contract
 * for moving items to the Recycle Bin.
 *
 * FOFX_RECYCLEONDELETE (Windows 8+) makes the recycle intent explicit: if the
 * Recycle Bin is unavailable the operation fails instead of silently deleting.
 * GetAnyOperationsAborted is checked because PerformOperations can succeed
 * while the shell reports the operation as aborted.
 */
const WINDOWS_RECYCLE_TYPE_DEFINITION = `using System;
using System.Runtime.InteropServices;

public static class MetisRecycleBin
{
	private const uint FOF_SILENT = 0x0004;
	private const uint FOF_NOCONFIRMATION = 0x0010;
	private const uint FOF_ALLOWUNDO = 0x0040;
	private const uint FOF_NOERRORUI = 0x0400;
	private const uint FOFX_RECYCLEONDELETE = 0x00080000;
	private const uint FOFX_EARLYFAILURE = 0x00100000;

	[ComImport]
	[Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
	[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	public interface IShellItem
	{
		void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
		void GetParent(out IShellItem ppsi);
		void GetDisplayName(uint sigdnName, out IntPtr ppszName);
		void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
		void Compare(IShellItem psi, uint hint, out int piOrder);
	}

	[ComImport]
	[Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8")]
	[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	public interface IFileOperation
	{
		void Advise(IntPtr pfops, out uint pdwCookie);
		void Unadvise(uint dwCookie);
		void SetOperationFlags(uint dwOperationFlags);
		void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
		void SetProgressDialog(IntPtr popd);
		void SetProperties(IntPtr pproparray);
		void SetOwnerWindow(IntPtr hwndOwner);
		void ApplyPropertiesToItem(IShellItem psiItem);
		void ApplyPropertiesToItems(IntPtr punkItems);
		void RenameItem(IShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
		void RenameItems(IntPtr pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
		void MoveItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IntPtr pfopsItem);
		void MoveItems(IntPtr punkItems, IShellItem psiDestinationFolder);
		void CopyItem(IShellItem psiItem, IShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IntPtr pfopsItem);
		void CopyItems(IntPtr punkItems, IShellItem psiDestinationFolder);
		void DeleteItem(IShellItem psiItem, IntPtr pfopsItem);
		void DeleteItems(IntPtr punkItems);
		void NewItem(IShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IntPtr pfopsItem);
		void PerformOperations();
		void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool pfAnyOperationsAborted);
	}

	[ComImport]
	[Guid("3ad05575-8857-4850-9277-11b85bdb8e09")]
	private class FileOperation { }

	[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
	private static extern IShellItem SHCreateItemFromParsingName(
		[MarshalAs(UnmanagedType.LPWStr)] string pszPath,
		IntPtr pbc,
		ref Guid riid);

	public static void Recycle(string[] paths)
	{
		IFileOperation operation = (IFileOperation)new FileOperation();
		try
		{
			operation.SetOperationFlags(
				FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI |
				FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE);
			Guid iid = typeof(IShellItem).GUID;
			foreach (string path in paths)
			{
				IShellItem item = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid);
				try
				{
					operation.DeleteItem(item, IntPtr.Zero);
				}
				finally
				{
					Marshal.ReleaseComObject(item);
				}
			}
			operation.PerformOperations();
			bool aborted;
			operation.GetAnyOperationsAborted(out aborted);
			if (aborted)
				throw new InvalidOperationException("Shell reported the Recycle Bin operation as aborted");
		}
		finally
		{
			Marshal.ReleaseComObject(operation);
		}
	}
}`;

/**
 * Build a PowerShell script that moves each path to the Windows Recycle Bin via
 * IFileOperation. Paths are embedded as single-quoted literals (embedded quotes
 * doubled), so no `--` separator or shell quoting applies.
 */
function windowsTrashScript(paths: readonly string[]): string {
	const quotedPaths = paths.map((path) => `'${path.replaceAll("'", "''")}'`);
	return [
		"$ErrorActionPreference = 'Stop'",
		"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		`Add-Type -TypeDefinition @'\n${WINDOWS_RECYCLE_TYPE_DEFINITION}\n'@`,
		`$paths = @(\n${quotedPaths.join(",\n")}\n)`,
		"try { [MetisRecycleBin]::Recycle($paths) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
	].join("\n");
}

function trashViaWindowsRecycleBin(paths: readonly string[]): string | undefined {
	const result = spawnProcessSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", windowsTrashScript(paths)],
		{ encoding: "utf8", timeout: TRASH_TIMEOUT_MS, windowsHide: true },
	);
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? result.stderr?.trim().split(/\r?\n/)[0];
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
 * Bin through PowerShell's IFileOperation (see WINDOWS_RECYCLE_TYPE_DEFINITION).
 * Elsewhere the `trash` CLI is used, preserving prior behavior.
 */
export function trashPathsSync(paths: readonly string[]): string | undefined {
	if (paths.length === 0) return undefined;
	if (process.platform === "win32") {
		return trashViaWindowsRecycleBin(paths);
	}
	if (process.platform === "darwin") {
		return trashViaMacOSFileManager(paths);
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
	if (process.platform === "darwin") {
		const detail = trashViaMacOSFileManager([path]);
		if (detail) throw new Error(`Trash failed: ${detail}`);
		return;
	}
	const child = spawnProcess("trash", [path], { stdio: "ignore", timeout: TRASH_TIMEOUT_MS });
	const exitCode = await waitForChildProcess(child);
	if (exitCode !== 0) throw new Error(`Trash exited with status ${exitCode ?? "unknown"}`);
}
