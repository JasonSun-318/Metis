import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcessSync } from "../src/utils/child-process.ts";
import { trashPath, trashPathsSync } from "../src/utils/trash.ts";

vi.mock("../src/utils/child-process.ts", () => ({
	spawnProcess: vi.fn(),
	spawnProcessSync: vi.fn(),
	waitForChildProcess: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
if (!originalPlatform) throw new Error("process.platform descriptor is missing");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function spawnResult(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		status: 0,
		stdout: "",
		stderr: "",
		error: undefined,
		pid: 1,
		output: [],
		signal: null,
		...overrides,
	} as ReturnType<typeof spawnProcessSync>;
}

function lastWindowsScript(): string {
	const call = vi.mocked(spawnProcessSync).mock.calls.at(-1);
	if (!call) throw new Error("spawnProcessSync was not called");
	const args = call[1] as string[];
	const commandIndex = args.indexOf("-Command");
	expect(commandIndex).toBeGreaterThanOrEqual(0);
	return args[commandIndex + 1] as string;
}

afterEach(() => {
	Object.defineProperty(process, "platform", originalPlatform);
	vi.resetAllMocks();
});

describe("Windows Recycle Bin trash", () => {
	it("deletes through IFileOperation with forced recycle semantics", () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult());

		const result = trashPathsSync(["C:\\Users\\me\\.metis\\sessions\\long name.jsonl"]);

		expect(result).toBeUndefined();
		const call = vi.mocked(spawnProcessSync).mock.calls[0];
		expect(call?.[0]).toBe("powershell.exe");
		const script = lastWindowsScript();
		expect(script).toContain("IFileOperation");
		expect(script).toContain("SHCreateItemFromParsingName");
		expect(script).toContain("DeleteItem");
		expect(script).toContain("FOFX_RECYCLEONDELETE");
		expect(script).toContain("GetAnyOperationsAborted");
		expect(script).toContain("'C:\\Users\\me\\.metis\\sessions\\long name.jsonl'");
		// The VB helper is the API that could not reach long paths and must not
		// be kept as a silent fallback.
		expect(script).not.toContain("Microsoft.VisualBasic");
	});

	it("pins the COM IIDs and CLSID from ShObjIdl_core.h", () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult());

		trashPathsSync(["C:\\file.jsonl"]);

		const script = lastWindowsScript();
		// IFileOperation, IShellItem, CLSID_FileOperation.
		expect(script).toContain('Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8")');
		expect(script).toContain('Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")');
		expect(script).toContain('Guid("3ad05575-8857-4850-9277-11b85bdb8e09")');
		// 04b0f1a7-... is IFileOperationProgressSink, which this script does not
		// implement; using it for IFileOperation makes the cast fail E_NOINTERFACE.
		expect(script).not.toContain("04b0f1a7-9490-44bc-96e1-4296a31252e2");
		// Errors cross the PowerShell pipe as UTF-8 so non-ASCII paths survive.
		expect(script).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
	});

	it("escapes embedded single quotes in paths", () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult());

		trashPathsSync(["C:\\it's\\a path"]);

		expect(lastWindowsScript()).toContain("'C:\\it''s\\a path'");
	});

	it("reports the child stderr when PowerShell exits non-zero", () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(
			spawnResult({ status: 1, stderr: "Exception from HRESULT: 0x80070002\r\nstack line" }),
		);

		expect(trashPathsSync(["C:\\missing"])).toBe("Recycle Bin trash failed: Exception from HRESULT: 0x80070002");
	});

	it("reports spawn errors", () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult({ status: null, error: new Error("ENOENT") }));

		expect(trashPathsSync(["C:\\missing"])).toBe("Recycle Bin trash failed: ENOENT");
	});

	it("does not spawn when there is nothing to trash", () => {
		setPlatform("win32");

		expect(trashPathsSync([])).toBeUndefined();
		expect(spawnProcessSync).not.toHaveBeenCalled();
	});

	it("throws from trashPath when the async caller's recycle fails", async () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult({ status: 1, stderr: "denied" }));

		await expect(trashPath("C:\\missing")).rejects.toThrow("Trash failed: Recycle Bin trash failed: denied");
	});

	it("resolves from trashPath on success", async () => {
		setPlatform("win32");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult());

		await expect(trashPath("C:\\file.jsonl")).resolves.toBeUndefined();
	});
});

describe("macOS trash", () => {
	it("passes paths as osascript argv instead of embedding them in the script", () => {
		setPlatform("darwin");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult());

		trashPathsSync(["/tmp/a b.jsonl"]);

		const call = vi.mocked(spawnProcessSync).mock.calls[0];
		expect(call?.[0]).toBe("osascript");
		expect(call?.[1]).toEqual(expect.arrayContaining(["--", "/tmp/a b.jsonl"]));
	});

	it("reports osascript failures", () => {
		setPlatform("darwin");
		vi.mocked(spawnProcessSync).mockReturnValue(spawnResult({ status: 1, stderr: "boom" }));

		expect(trashPathsSync(["/tmp/x"])).toBe("boom");
	});
});
