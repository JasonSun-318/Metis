import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";
import { launchPackagedDesktop, packagedExecutable, reservePort, stopProcess } from "./packaged-app-harness.ts";

test("packaged Windows repeated launch restores one existing desktop", async () => {
	test.skip(process.platform !== "win32", "Windows single-instance startup");
	test.setTimeout(180_000);
	const app = await launchPermissionApp({ preset: "auto", tools: () => undefined });
	let second: ReturnType<typeof launchPackagedDesktop> | undefined;
	try {
		const userData = app.dirs.userDataDir.replaceAll("'", "''");
		const windowState = (minimize = false) => {
			const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class StartupWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); }'; $items=@(Get-CimInstance Win32_Process -Filter "Name='Metis.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${userData}') -and -not $_.CommandLine.Contains('--type=') }); if($items.Count -ne 1){ @{count=$items.Count} | ConvertTo-Json -Compress; exit }; $p=Get-Process -Id $items[0].ProcessId; $h=$p.MainWindowHandle; ${minimize ? "$null=[StartupWindow]::ShowWindow($h,6);" : ""} @{count=1;minimized=[StartupWindow]::IsIconic($h)} | ConvertTo-Json -Compress`;
			return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true })) as { count: number; minimized?: boolean };
		};
		expect(windowState(true)).toEqual({ count: 1, minimized: true });
		second = launchPackagedDesktop({
			executable: packagedExecutable(),
			debuggingPort: await reservePort(),
			userDataDir: app.dirs.userDataDir,
			projectDir: app.projectDir,
			agentDir: app.agentDir,
			homeDir: app.homeDir,
			diagnostics: app.diagnostics,
		});
		await expect.poll(() => second?.exitCode, { timeout: 30_000 }).toBe(0);
		await expect.poll(() => windowState(), { timeout: 20_000 }).toEqual({ count: 1, minimized: false });
		await expect(app.page.locator(".workspace-titlebar")).toHaveAttribute("data-active-session-id", app.sessionId);
	} finally {
		if (second) await stopProcess(second);
		await app.close();
	}
});
