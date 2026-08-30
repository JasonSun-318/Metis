import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const durableMock = vi.hoisted(() => ({ failure: null as Error | null, failAfterPublish: false }));

vi.mock("../src/core/durable-file.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/durable-file.ts")>();
	return {
		...actual,
		replaceFileAtomicallySync: (...args: Parameters<typeof actual.replaceFileAtomicallySync>) => {
			if (durableMock.failure && !durableMock.failAfterPublish) throw durableMock.failure;
			const result = actual.replaceFileAtomicallySync(...args);
			if (durableMock.failure) throw durableMock.failure;
			return result;
		},
	};
});

import { FileSettingsStorage } from "../src/core/settings-manager.ts";

describe("FileSettingsStorage atomic writes", () => {
	const testDir = join(process.cwd(), "test-settings-storage-atomic-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const settingsPath = join(agentDir, "settings.json");

	beforeEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		durableMock.failure = null;
		durableMock.failAfterPublish = false;
	});

	afterEach(() => {
		durableMock.failure = null;
		durableMock.failAfterPublish = false;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("accepts a replacement that was published before directory sync reported failure", () => {
		const storage = new FileSettingsStorage(projectDir, agentDir);
		durableMock.failure = new Error("directory sync failed");
		durableMock.failAfterPublish = true;

		expect(() => storage.withWriteLock("global", () => JSON.stringify({ theme: "light" }))).not.toThrow();
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light" });
	});

	it("preserves the previous settings file when atomic replacement fails", () => {
		const previous = JSON.stringify({ theme: "dark" });
		writeFileSync(settingsPath, previous);
		const storage = new FileSettingsStorage(projectDir, agentDir);
		durableMock.failure = new Error("disk full");

		expect(() => storage.withWriteLock("global", () => JSON.stringify({ theme: "light" }))).toThrow("disk full");
		expect(readFileSync(settingsPath, "utf8")).toBe(previous);

		durableMock.failure = null;
		storage.withWriteLock("global", () => JSON.stringify({ theme: "light" }));
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light" });
	});
});
