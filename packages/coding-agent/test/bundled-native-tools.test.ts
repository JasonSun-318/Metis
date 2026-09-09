import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledToolPath } from "../src/utils/tools-manager.ts";

describe("bundled native tools", () => {
	let packageDir: string;

	beforeEach(() => {
		packageDir = join(tmpdir(), `metis-native-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(packageDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(packageDir, { recursive: true, force: true });
	});

	function stage(tool: "rg" | "fd", contents: string): string {
		const directory = join(packageDir, "dist", "vendor", "tools", "darwin-arm64");
		mkdirSync(directory, { recursive: true });
		const binary = join(directory, tool);
		writeFileSync(binary, contents);
		chmodSync(binary, 0o755);
		const manifestPath = join(directory, "manifest.json");
		const tools = {
			[tool]: {
				version: "test",
				binary: tool,
				binarySha256: createHash("sha256").update(contents).digest("hex"),
			},
		};
		writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, pair: "darwin-arm64", tools }));
		return binary;
	}

	it("returns a verified executable from the packaged platform pair", () => {
		const binary = stage("rg", "verified-rg");
		linkSync(binary, join(packageDir, "package-manager-store-link"));
		expect(getBundledToolPath("rg", { packageDir, platform: "darwin", arch: "arm64", requireBundle: true })).toBe(
			binary,
		);
	});

	it("fails closed when a packaged executable is corrupted", () => {
		const binary = stage("fd", "verified-fd");
		writeFileSync(binary, "tampered");
		expect(() =>
			getBundledToolPath("fd", { packageDir, platform: "darwin", arch: "arm64", requireBundle: true }),
		).toThrow("failed its integrity check");
	});

	it("resolves ASAR assets to real paths before integrity checks and execution", () => {
		const parent = packageDir;
		packageDir = join(parent, "app.asar.unpacked", "agent");
		try {
			const binary = stage("rg", "verified-rg");
			expect(
				getBundledToolPath("rg", {
					packageDir: join(parent, "app.asar", "agent"),
					platform: "darwin",
					arch: "arm64",
					requireBundle: true,
				}),
			).toBe(binary);
		} finally {
			packageDir = parent;
		}
	});

	it("reports an incomplete install instead of downloading a missing platform pair", () => {
		expect(() =>
			getBundledToolPath("rg", { packageDir, platform: "win32", arch: "x64", requireBundle: true }),
		).toThrow("no runtime download will be attempted");
	});

	it("uses system dependencies on Linux and does not require bundled assets", () => {
		expect(getBundledToolPath("rg", { packageDir, platform: "linux", arch: "x64", requireBundle: true })).toBeNull();
	});
});
