import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWindowsSelfUpdateQuarantine } from "../src/utils/windows-self-update.ts";

const roots: string[] = [];

function layout(): { root: string; packageDir: string; quarantine: string } {
	const root = mkdtempSync(join(tmpdir(), "metis-quarantine-"));
	roots.push(root);
	const packageDir = join(root, "node_modules", "@metis", "coding-agent");
	mkdirSync(packageDir, { recursive: true });
	return { root, packageDir, quarantine: join(root, "node_modules", ".metis-native-quarantine") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("windows self-update quarantine cleanup", () => {
	it("removes a legacy quarantine directory from the nearest node_modules", () => {
		const { packageDir, quarantine } = layout();
		mkdirSync(join(quarantine, "native"), { recursive: true });
		writeFileSync(join(quarantine, "native", "addon.node"), "old addon");

		cleanupWindowsSelfUpdateQuarantine(packageDir);

		expect(existsSync(quarantine)).toBe(false);
	});

	it("is a no-op when the quarantine directory is absent", () => {
		const { packageDir } = layout();
		expect(() => cleanupWindowsSelfUpdateQuarantine(packageDir)).not.toThrow();
	});

	it("is a no-op when no node_modules ancestor exists", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-quarantine-"));
		roots.push(root);
		const packageDir = join(root, "standalone", "package");
		mkdirSync(packageDir, { recursive: true });
		expect(() => cleanupWindowsSelfUpdateQuarantine(packageDir)).not.toThrow();
	});

	it("swallows cleanup failures for a locked directory", () => {
		const { packageDir, quarantine } = layout();
		mkdirSync(quarantine, { recursive: true });
		// A non-writable parent makes the recursive removal fail.
		chmodSync(join(quarantine, ".."), 0o500);
		try {
			expect(() => cleanupWindowsSelfUpdateQuarantine(packageDir)).not.toThrow();
		} finally {
			chmodSync(join(quarantine, ".."), 0o700);
		}
	});
});
