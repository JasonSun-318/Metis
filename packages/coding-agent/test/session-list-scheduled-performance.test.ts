import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			opened.push(String(args[0]));
			return actual.open(...args);
		},
	};
});

import { SessionManager } from "../src/core/session-manager.ts";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	opened.length = 0;
});

describe("scheduled session catalog performance", () => {
	it("skips scheduled journals after the header without scanning their transcripts", async () => {
		root = mkdtempSync(join(tmpdir(), "arcmind-scheduled-catalog-"));
		const cwd = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd);
		mkdirSync(sessionDir);

		const ordinary = SessionManager.create(cwd, sessionDir, { id: "ordinary-session" });
		const scheduled = SessionManager.create(cwd, sessionDir, {
			id: "scheduled-session",
			scheduled: { taskId: "scheduled-task", runId: "scheduled-run" },
		});
		const ordinaryPath = ordinary.getSessionFile()!;
		ordinary.close();
		scheduled.close();
		opened.length = 0;

		expect((await SessionManager.list(cwd, sessionDir)).map(({ id }) => id)).toEqual(["ordinary-session"]);
		expect(opened).toEqual([ordinaryPath]);
	});
});
