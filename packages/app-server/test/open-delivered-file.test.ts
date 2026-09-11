import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDeliveredFile } from "../src/open-delivered-file.ts";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn }));

describe("openDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		spawn.mockReset();
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("opens an already-authorized delivered file path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-open-deliver-"));
		roots.push(root);
		const path = join(root, "report.txt");
		writeFileSync(path, "hello");
		const child = new EventEmitter();
		spawn.mockReturnValue(child);
		const opened = openDeliveredFile({ path, action: "default" });
		child.emit("exit", 0);

		await expect(opened).resolves.toBeUndefined();
		expect(spawn).toHaveBeenCalledOnce();
	});
});
