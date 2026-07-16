import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const aliasRace = vi.hoisted(() => ({
	sourcePath: undefined as string | undefined,
	outputPath: undefined as string | undefined,
	kind: undefined as "hardlink" | "symlink" | undefined,
	injected: false,
}));

vi.mock("../src/core/durable-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/durable-file.ts")>();
	const fs = await import("node:fs");
	return {
		...actual,
		replaceFileAtomicallySync: (
			path: string,
			data: string | Uint8Array,
			options?: Parameters<typeof actual.replaceFileAtomicallySync>[2],
		) => {
			if (path === aliasRace.outputPath && aliasRace.sourcePath && aliasRace.kind) {
				aliasRace.injected = true;
				if (aliasRace.kind === "hardlink") fs.linkSync(aliasRace.sourcePath, path);
				else fs.symlinkSync(aliasRace.sourcePath, path);
			}
			return actual.replaceFileAtomicallySync(path, data, options);
		},
	};
});

describe("standalone HTML export", () => {
	it("reads a session while its live runtime holds the writer lease", async () => {
		const directory = mkdtempSync(join(tmpdir(), "arcmind-export-readonly-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(directory, directory);
			manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			const outputPath = join(directory, "session.html");

			await expect(exportFromFile(manager.getSessionFile()!, { outputPath })).resolves.toBe(outputPath);
			expect(existsSync(outputPath)).toBe(true);
		} finally {
			manager?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite the source journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "arcmind-export-source-"));
		let manager: SessionManager | undefined;
		try {
			manager = SessionManager.create(directory, directory);
			manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			const sessionFile = manager.getSessionFile()!;
			const before = readFileSync(sessionFile, "utf8");

			await expect(exportFromFile(sessionFile, { outputPath: sessionFile })).rejects.toThrow(
				"must not overwrite the source session",
			);
			expect(readFileSync(sessionFile, "utf8")).toBe(before);
		} finally {
			manager?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each(["hardlink", "symlink"] as const)(
		"atomically replaces a late %s alias without truncating the source journal",
		async (kind) => {
			const directory = mkdtempSync(join(tmpdir(), "arcmind-export-alias-race-"));
			let manager: SessionManager | undefined;
			try {
				manager = SessionManager.create(directory, directory);
				manager.appendMessage({ role: "user", content: "do not truncate", timestamp: 1 });
				const sessionFile = manager.getSessionFile()!;
				const outputPath = join(directory, "session.html");
				const before = readFileSync(sessionFile, "utf8");

				aliasRace.sourcePath = sessionFile;
				aliasRace.outputPath = outputPath;
				aliasRace.kind = kind;
				aliasRace.injected = false;

				await expect(exportFromFile(sessionFile, { outputPath })).resolves.toBe(outputPath);

				expect(aliasRace.injected).toBe(true);
				expect(readFileSync(sessionFile, "utf8")).toBe(before);
				expect(readFileSync(outputPath, "utf8")).toContain("<!DOCTYPE html>");
				const sourceStats = statSync(sessionFile);
				const outputStats = statSync(outputPath);
				expect([outputStats.dev, outputStats.ino]).not.toEqual([sourceStats.dev, sourceStats.ino]);
			} finally {
				aliasRace.sourcePath = undefined;
				aliasRace.outputPath = undefined;
				aliasRace.kind = undefined;
				aliasRace.injected = false;
				manager?.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
