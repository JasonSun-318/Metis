import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);
const readBytes = vi.hoisted(() => new Map<string, number>());

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const path = String(args[0]);
			opened.push(path);
			const handle = await actual.open(...args);
			return new Proxy(handle, {
				get(target, property) {
					if (property === "read") {
						return async (...readArgs: Parameters<typeof target.read>) => {
							const result = await target.read(...readArgs);
							readBytes.set(path, (readBytes.get(path) ?? 0) + result.bytesRead);
							return result;
						};
					}
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		},
	};
});

import { SessionManager } from "../src/core/session-manager.ts";

let root: string | undefined;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
	opened.length = 0;
	readBytes.clear();
});

describe("scheduled session catalog performance", () => {
	it("loads visible scheduled journals through the same bounded catalog path", async () => {
		root = mkdtempSync(join(tmpdir(), "metis-scheduled-catalog-"));
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
		const scheduledPath = scheduled.getSessionFile()!;
		scheduled.appendMessage({ role: "user", content: "Generate report", timestamp: Date.now() });
		scheduled.appendMessage({ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: Date.now() });
		ordinary.close();
		scheduled.close();
		opened.length = 0;

		const sessions = await SessionManager.list(cwd, sessionDir);
		expect(sessions.map(({ id }) => id)).toEqual(["scheduled-session", "ordinary-session"]);
		const scheduledInfo = sessions.find(({ id }) => id === "scheduled-session")!;
		expect(scheduledInfo).toMatchObject({
			messageCount: 0,
			firstMessage: "Generate report",
			allMessagesText: "Generate report",
		});
		expect(readBytes.get(scheduledPath)).toBeLessThan(statSync(scheduledPath).size);
		expect(opened.sort()).toEqual([ordinaryPath, scheduledPath].sort());
	});
});
