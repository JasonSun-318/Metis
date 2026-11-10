import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const bindMountsAvailable = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;

describe("Linux XDG trash", () => {
	let root = "";
	let previousXdg: string | undefined;
	let previousHome: string | undefined;

	beforeEach(() => {
		setPlatform("linux");
		root = mkdtempSync(join(tmpdir(), "metis-xdg-trash-"));
		previousXdg = process.env.XDG_DATA_HOME;
		previousHome = process.env.HOME;
		process.env.XDG_DATA_HOME = join(root, "xdg-data");
	});

	afterEach(() => {
		if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdg;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	});

	function dataHome(): string {
		const home = process.env.XDG_DATA_HOME;
		if (!home) throw new Error("XDG_DATA_HOME is unset");
		return home;
	}

	function writeSource(name: string, content: string): string {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		return path;
	}

	it("renames a file into the home trash without calling the trash command", () => {
		const source = writeSource("sessions/chat.jsonl", "session");
		const before = statSync(source);

		expect(trashPathsSync([source])).toBeUndefined();

		const trashed = join(dataHome(), "Trash", "files", "chat.jsonl");
		expect(existsSync(source)).toBe(false);
		expect(readFileSync(trashed, "utf8")).toBe("session");
		const after = statSync(trashed);
		expect(after.dev).toBe(before.dev);
		expect(after.ino).toBe(before.ino);
		expect(statSync(join(dataHome(), "Trash")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dataHome(), "Trash", "files")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dataHome(), "Trash", "info")).mode & 0o777).toBe(0o700);
		expect(spawnProcessSync).not.toHaveBeenCalled();
	});

	it("writes a percent-encoded trashinfo record and keeps the original bytes", async () => {
		const source = writeSource("a b/会议.txt", "notes");
		const before = Date.now();

		expect(await trashPath(source)).toBeUndefined();

		const encoded = source
			.split("/")
			.map((part) => (part === "a b" ? "a%20b" : part === "会议.txt" ? "%E4%BC%9A%E8%AE%AE.txt" : part))
			.join("/");
		const lines = readFileSync(join(dataHome(), "Trash", "info", "会议.txt.trashinfo"), "utf8").split("\n");
		expect(lines[0]).toBe("[Trash Info]");
		expect(lines[1]).toBe(`Path=${encoded}`);
		expect(lines[2]).toMatch(/^DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
		expect(lines[3]).toBe("");
		const [year, month, day, hour, minute, second] = lines[2]!
			.slice("DeletionDate=".length)
			.split(/[-T:]/)
			.map(Number);
		const deletedAt = new Date(year!, (month ?? 1) - 1, day, hour, minute, second);
		expect(Math.abs(deletedAt.getTime() - before)).toBeLessThan(5_000);
		expect(existsSync(join(dataHome(), "Trash", "files", "会议.txt"))).toBe(true);
		expect(spawnProcessSync).not.toHaveBeenCalled();
	});

	it("renames a directory tree and a symlink, leaving the symlink target in place", () => {
		const directory = join(root, "bundle");
		mkdirSync(directory);
		writeFileSync(join(directory, "nested.txt"), "kept");
		const directoryBefore = lstatSync(directory);
		const target = writeSource("target.txt", "data");
		const link = join(root, "link.txt");
		symlinkSync(target, link);
		const linkBefore = lstatSync(link);

		expect(trashPathsSync([directory, link])).toBeUndefined();

		const trashedDirectory = join(dataHome(), "Trash", "files", "bundle");
		expect(lstatSync(trashedDirectory).ino).toBe(directoryBefore.ino);
		expect(readFileSync(join(trashedDirectory, "nested.txt"), "utf8")).toBe("kept");
		const trashedLink = join(dataHome(), "Trash", "files", "link.txt");
		expect(lstatSync(trashedLink).isSymbolicLink()).toBe(true);
		expect(lstatSync(trashedLink).ino).toBe(linkBefore.ino);
		expect(readlinkSync(trashedLink)).toBe(target);
		expect(readFileSync(target, "utf8")).toBe("data");
	});

	it("keeps both files when two trashed names collide", () => {
		const first = writeSource("a/note.txt", "first");
		const second = writeSource("b/note.txt", "second");

		expect(trashPathsSync([first, second])).toBeUndefined();

		const files = join(dataHome(), "Trash", "files");
		expect(readFileSync(join(files, "note.txt"), "utf8")).toBe("first");
		expect(readFileSync(join(files, "note.txt.2"), "utf8")).toBe("second");
		const infoDir = join(dataHome(), "Trash", "info");
		expect(readFileSync(join(infoDir, "note.txt.trashinfo"), "utf8")).toContain(`Path=${first}`);
		expect(readFileSync(join(infoDir, "note.txt.2.trashinfo"), "utf8")).toContain(`Path=${second}`);
	});

	it("trashes a leading-dash name and still moves the sibling when one path is missing", () => {
		const present = writeSource("-secret.txt", "secret");
		const missing = join(root, "missing.txt");

		expect(trashPathsSync([missing, present])).toContain("ENOENT");

		expect(existsSync(present)).toBe(false);
		expect(readFileSync(join(dataHome(), "Trash", "files", "-secret.txt"), "utf8")).toBe("secret");
		expect(spawnProcessSync).not.toHaveBeenCalled();
	});

	it("leaves the file in place when the home trash directory cannot be created", async () => {
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "x");
		process.env.XDG_DATA_HOME = blocker;
		const source = writeSource("stay.txt", "stay");

		expect(trashPathsSync([source])).toEqual(expect.any(String));
		await expect(trashPath(source)).rejects.toThrow(/^Trash failed:/);
		expect(readFileSync(source, "utf8")).toBe("stay");
		expect(spawnProcessSync).not.toHaveBeenCalled();
	});

	it("ignores a relative XDG_DATA_HOME and uses the home trash", () => {
		const home = join(root, "home");
		mkdirSync(home);
		process.env.HOME = home;
		process.env.XDG_DATA_HOME = "relative/data";
		const source = writeSource("note.txt", "note");

		expect(trashPathsSync([source])).toBeUndefined();

		expect(readFileSync(join(home, ".local", "share", "Trash", "files", "note.txt"), "utf8")).toBe("note");
		expect(existsSync(join(process.cwd(), "relative"))).toBe(false);
	});

	it("does not change the mode of a trash directory the user already created", () => {
		const trashDir = join(dataHome(), "Trash");
		mkdirSync(trashDir, { recursive: true });
		chmodSync(trashDir, 0o755);
		const source = writeSource("already.txt", "ok");

		expect(trashPathsSync([source])).toBeUndefined();

		expect(statSync(trashDir).mode & 0o777).toBe(0o755);
		expect(existsSync(source)).toBe(false);
	});

	it.skipIf(!bindMountsAvailable)("refuses a home trash directory owned by another user", () => {
		const trashDir = join(dataHome(), "Trash");
		mkdirSync(trashDir, { recursive: true });
		const chown = spawnSync("sudo", ["-n", "chown", "root:root", trashDir], { stdio: "ignore" });
		expect(chown.status).toBe(0);
		const source = writeSource("owned.txt", "owned");
		try {
			expect(trashPathsSync([source])).toEqual(expect.any(String));
			expect(readFileSync(source, "utf8")).toBe("owned");
		} finally {
			spawnSync("sudo", ["-n", "chown", `${process.getuid?.()}:${process.getgid?.()}`, trashDir], {
				stdio: "ignore",
			});
		}
	});

	it.skipIf(!bindMountsAvailable)("renames a file on another mount into that mount's trash", () => {
		withBindMount((mountPoint) => {
			const source = join(mountPoint, "session.jsonl");
			writeFileSync(source, "session");
			const before = statSync(source);

			expect(trashPathsSync([source])).toBeUndefined();

			const uid = String(process.getuid?.());
			const dest = join(mountPoint, `.Trash-${uid}`, "files", "session.jsonl");
			expect(existsSync(source)).toBe(false);
			const after = statSync(dest);
			expect(after.dev).toBe(before.dev);
			expect(after.ino).toBe(before.ino);
			expect(readFileSync(dest, "utf8")).toBe("session");
			expect(existsSync(join(dataHome(), "Trash", "files", "session.jsonl"))).toBe(false);
			expect(readFileSync(join(mountPoint, `.Trash-${uid}`, "info", "session.jsonl.trashinfo"), "utf8")).toContain(
				`Path=${source}`,
			);
		});
	});

	it.skipIf(!bindMountsAvailable)("uses the administrator trash when it is a sticky real directory", () => {
		withBindMount((mountPoint) => {
			const admin = join(mountPoint, ".Trash");
			mkdirSync(admin);
			chmodSync(admin, 0o1777);
			const source = join(mountPoint, "admin.txt");
			writeFileSync(source, "admin");

			expect(trashPathsSync([source])).toBeUndefined();

			const uid = String(process.getuid?.());
			expect(readFileSync(join(admin, uid, "files", "admin.txt"), "utf8")).toBe("admin");
			expect(existsSync(join(mountPoint, `.Trash-${uid}`))).toBe(false);
		});
	});

	it.skipIf(!bindMountsAvailable)(
		"falls back to .Trash-$uid when the sticky administrator trash is not writable",
		() => {
			withBindMount((mountPoint) => {
				const admin = join(mountPoint, ".Trash");
				mkdirSync(admin);
				chmodSync(admin, 0o1555);
				const source = join(mountPoint, "locked.txt");
				writeFileSync(source, "locked");
				const before = statSync(source);
				try {
					expect(trashPathsSync([source])).toBeUndefined();
					const uid = String(process.getuid?.());
					const dest = join(mountPoint, `.Trash-${uid}`, "files", "locked.txt");
					expect(existsSync(source)).toBe(false);
					expect(existsSync(join(admin, uid))).toBe(false);
					expect(statSync(dest).ino).toBe(before.ino);
					expect(statSync(dest).dev).toBe(before.dev);
					expect(readFileSync(dest, "utf8")).toBe("locked");
				} finally {
					chmodSync(admin, 0o755);
				}
			});
		},
	);

	it.skipIf(!bindMountsAvailable)(
		"falls back to .Trash-$uid when the per-user administrator trash is a symlink",
		() => {
			withBindMount((mountPoint) => {
				const admin = join(mountPoint, ".Trash");
				mkdirSync(admin);
				chmodSync(admin, 0o1777);
				const outside = join(root, "uid-symlink-target");
				mkdirSync(outside);
				const uid = String(process.getuid?.());
				symlinkSync(outside, join(admin, uid));
				const source = join(mountPoint, "sym.txt");
				writeFileSync(source, "sym");
				const before = statSync(source);

				expect(trashPathsSync([source])).toBeUndefined();

				const dest = join(mountPoint, `.Trash-${uid}`, "files", "sym.txt");
				expect(existsSync(source)).toBe(false);
				expect(lstatSync(join(admin, uid)).isSymbolicLink()).toBe(true);
				expect(existsSync(join(outside, "files"))).toBe(false);
				expect(statSync(dest).ino).toBe(before.ino);
				expect(statSync(dest).dev).toBe(before.dev);
				expect(readFileSync(dest, "utf8")).toBe("sym");
			});
		},
	);

	it.skipIf(!bindMountsAvailable)("ignores an administrator trash without the sticky bit", () => {
		withBindMount((mountPoint) => {
			mkdirSync(join(mountPoint, ".Trash"));
			const source = join(mountPoint, "plain.txt");
			writeFileSync(source, "plain");

			expect(trashPathsSync([source])).toBeUndefined();

			const uid = String(process.getuid?.());
			expect(existsSync(join(mountPoint, ".Trash", uid))).toBe(false);
			expect(readFileSync(join(mountPoint, `.Trash-${uid}`, "files", "plain.txt"), "utf8")).toBe("plain");
		});
	});

	it.skipIf(!bindMountsAvailable)("does not follow a symlink administrator trash", () => {
		withBindMount((mountPoint) => {
			const outside = join(root, "outside-trash");
			mkdirSync(outside);
			chmodSync(outside, 0o1777);
			symlinkSync(outside, join(mountPoint, ".Trash"));
			const source = join(mountPoint, "linked.txt");
			writeFileSync(source, "linked");

			expect(trashPathsSync([source])).toBeUndefined();

			const uid = String(process.getuid?.());
			expect(existsSync(join(outside, uid))).toBe(false);
			expect(readFileSync(join(mountPoint, `.Trash-${uid}`, "files", "linked.txt"), "utf8")).toBe("linked");
		});
	});

	it.skipIf(!bindMountsAvailable)("leaves the original file when the other filesystem cannot host a trash", () => {
		withBindMount((mountPoint) => {
			const source = join(mountPoint, "keep.txt");
			writeFileSync(source, "keep");
			const before = statSync(source);
			chmodSync(mountPoint, 0o555);
			try {
				expect(trashPathsSync([source])).toEqual(expect.any(String));
				expect(readFileSync(source, "utf8")).toBe("keep");
				expect(statSync(source).ino).toBe(before.ino);
				expect(existsSync(join(dataHome(), "Trash", "files", "keep.txt"))).toBe(false);
			} finally {
				chmodSync(mountPoint, 0o755);
			}
		});
	});
});

function withBindMount(run: (mountPoint: string) => void): void {
	const backing = mkdtempSync(join(tmpdir(), "metis-trash-bind-"));
	const mountPoint = mkdtempSync(join(tmpdir(), "metis-trash-mnt-"));
	const mounted = spawnSync("sudo", ["-n", "mount", "--bind", backing, mountPoint], { stdio: "ignore" }).status === 0;
	if (!mounted) {
		rmSync(backing, { recursive: true, force: true });
		rmSync(mountPoint, { recursive: true, force: true });
		throw new Error("bind mount is not available");
	}
	try {
		run(mountPoint);
	} finally {
		const unmounted = spawnSync("sudo", ["-n", "umount", mountPoint], { stdio: "ignore" });
		if (unmounted.status !== 0) spawnSync("sudo", ["-n", "umount", "-l", mountPoint], { stdio: "ignore" });
		rmSync(backing, { recursive: true, force: true });
		rmSync(mountPoint, { recursive: true, force: true });
	}
}
