import { spawnSync } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("rejects trust read through a symlink", ({ skip }) => {
		const outsidePath = join(tempDir, "outside-trust.json");
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(outsidePath, `${JSON.stringify({ [cwd]: true })}\n`, "utf-8");
		try {
			symlinkSync(outsidePath, trustPath);
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Creating symlinks requires Windows Developer Mode");
				return;
			}
			throw error;
		}

		const store = new ProjectTrustStore(agentDir);
		expect(() => store.get(cwd)).toThrow(`Failed to read trust store ${trustPath}`);
		expect(() => store.set(cwd, false)).toThrow(`Failed to read trust store ${trustPath}`);
		expect(lstatSync(trustPath).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(outsidePath, "utf-8"))).toEqual({ [cwd]: true });
	});

	it.skipIf(process.platform === "win32")("rejects a final trust FIFO without blocking", ({ skip }) => {
		const trustPath = join(agentDir, "trust.json");
		const mkfifo = spawnSync("mkfifo", [trustPath], { encoding: "utf8" });
		if (mkfifo.error && "code" in mkfifo.error && mkfifo.error.code === "ENOENT") {
			skip("mkfifo is unavailable");
			return;
		}
		expect(mkfifo.status, mkfifo.stderr).toBe(0);

		const moduleUrl = new URL("../src/core/trust-manager.ts", import.meta.url).href;
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`const { ProjectTrustStore } = await import(${JSON.stringify(moduleUrl)}); try { new ProjectTrustStore(process.argv[1]).get(process.argv[2]); } catch { process.exit(0); } process.exit(2);`,
				agentDir,
				cwd,
			],
			{ encoding: "utf8", timeout: 10_000 },
		);

		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
	});

	it("rejects trust read through a hard link", () => {
		const outsidePath = join(tempDir, "outside-trust.json");
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(outsidePath, `${JSON.stringify({ [cwd]: true })}\n`, "utf-8");
		linkSync(outsidePath, trustPath);

		const store = new ProjectTrustStore(agentDir);
		expect(() => store.get(cwd)).toThrow("Refusing to read aliased or non-regular file");
		expect(() => store.set(cwd, false)).toThrow("Refusing to read aliased or non-regular file");
		expect(JSON.parse(readFileSync(outsidePath, "utf-8"))).toEqual({ [cwd]: true });
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, ".arcmind", "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, ".arcmind", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, ".arcmind", "settings.json"), { force: true });

			mkdirSync(join(cwd, ".arcmind"), { recursive: true });
			writeFileSync(join(cwd, ".arcmind", "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, ".arcmind"), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});
});
