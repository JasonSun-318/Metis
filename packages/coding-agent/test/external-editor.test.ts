import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnProcess } from "../src/utils/child-process.ts";
import { launchExternalEditor } from "../src/utils/external-editor.ts";

vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("external editor launch", () => {
	it.each([
		[
			'"/Applications/Visual Studio Code.app/bin/code" --wait "a b"',
			"/Applications/Visual Studio Code.app/bin/code",
			["--wait", "a b"],
		],
		['"C:\\Program Files\\Editor\\code.cmd" --wait', "C:\\Program Files\\Editor\\code.cmd", ["--wait"]],
	] as const)("passes quoted argv without enabling a shell: %s", async (command, executable, args) => {
		const child = new EventEmitter();
		vi.mocked(spawnProcess).mockReturnValue(child as ReturnType<typeof spawnProcess>);
		const path = "C:\\Temp\\user & name\\edit.md";
		const pending = launchExternalEditor(command, path);
		expect(spawnProcess).toHaveBeenCalledWith(executable, [...args, path], { stdio: "inherit" });
		child.emit("close", 0);
		await expect(pending).resolves.toBe(0);
	});

	it("reports process launch failures", async () => {
		const child = new EventEmitter();
		vi.mocked(spawnProcess).mockReturnValue(child as ReturnType<typeof spawnProcess>);
		const pending = launchExternalEditor("missing-editor", "/tmp/file.md");
		child.emit("error", new Error("ENOENT"));
		await expect(pending).rejects.toThrow("ENOENT");
	});
});
