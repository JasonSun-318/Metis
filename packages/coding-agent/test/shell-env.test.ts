import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getShellEnv } from "../src/utils/shell.ts";

describe("shell environment", () => {
	it("exposes unpacked binaries to the OS when package code lives inside ASAR", () => {
		const temporary = mkdtempSync(join(tmpdir(), "metis runtime "));
		const relativePackage = join("node_modules", "@metis", "coding-agent");
		const packageDir = join(temporary, "app.asar", relativePackage);
		const vendor = join(temporary, "app.asar.unpacked", relativePackage, "dist", "vendor");
		const tools = join(vendor, "tools", `${process.platform}-${process.arch}`);
		mkdirSync(tools, { recursive: true });
		vi.stubEnv("METIS_PACKAGE_DIR", packageDir);
		vi.stubEnv("PATH", process.platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin");
		try {
			const env = getShellEnv();
			const shellPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
			expect(shellPath?.split(delimiter)[0]).toBe(tools);
			if (process.platform !== "win32") {
				const binary = join(tools, "officecli");
				writeFileSync(binary, "#!/bin/sh\nprintf 'bundled-office-ok'");
				chmodSync(binary, 0o755);
				const result = spawnSync("/bin/bash", ["-c", "officecli"], { env, encoding: "utf8" });
				expect(result.status).toBe(0);
				expect(result.stdout).toBe("bundled-office-ok");
			}
		} finally {
			vi.unstubAllEnvs();
			rmSync(temporary, { recursive: true, force: true });
		}
	});
	it("keeps bundled OfficeCLI offline and non-resident", () => {
		const previousResidentFlush = process.env.OFFICECLI_RESIDENT_FLUSH;
		process.env.OFFICECLI_RESIDENT_FLUSH = "each";
		try {
			const env = getShellEnv();

			expect(env.OFFICECLI_SKIP_UPDATE).toBe("1");
			expect(env.OFFICECLI_NO_AUTO_INSTALL).toBe("1");
			expect(env.OFFICECLI_NO_AUTO_RESIDENT).toBe("1");
			expect(env.OFFICECLI_RESIDENT_FLUSH).toBeUndefined();
		} finally {
			if (previousResidentFlush === undefined) delete process.env.OFFICECLI_RESIDENT_FLUSH;
			else process.env.OFFICECLI_RESIDENT_FLUSH = previousResidentFlush;
		}
	});
});
