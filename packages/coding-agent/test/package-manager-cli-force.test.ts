import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

describe("legacy update --force compatibility", () => {
	let tempDir: string;
	let previousExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "metis-update-force-"));
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		vi.spyOn(process, "cwd").mockReturnValue(projectDir);
		vi.stubEnv("METIS_CODING_AGENT_DIR", join(tempDir, "agent"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue();
		previousExitCode = process.exitCode;
		process.exitCode = 0;
	});

	afterEach(() => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([{ args: ["--extensions", "--force"] }, { args: ["--force", "--extensions"] }])(
		"accepts update $args without changing the extension update",
		async ({ args }) => {
			expect(await handlePackageCommand(["update", ...args, "--no-approve"])).toBe(true);
			expect(process.exitCode).toBe(0);
			expect(DefaultPackageManager.prototype.update).toHaveBeenCalledExactlyOnceWith(undefined);
			expect(console.error).not.toHaveBeenCalled();
		},
	);

	it("keeps CLI self-update disabled when --force is present", async () => {
		expect(await handlePackageCommand(["update", "--force", "--no-approve"])).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(DefaultPackageManager.prototype.update).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Self-update is disabled."));
	});

	it.each(["install", "remove", "list"])("still rejects --force for %s", async (command) => {
		expect(await handlePackageCommand([command, "--force", "--no-approve"])).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(DefaultPackageManager.prototype.update).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`Unknown option --force for "${command}".`));
	});
});
