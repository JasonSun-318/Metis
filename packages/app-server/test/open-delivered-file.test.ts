import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDeliveredFile } from "../src/open-delivered-file.ts";

describe("openDeliveredFile", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
	});

	it("opens an already-authorized delivered file path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-open-deliver-"));
		roots.push(root);
		const path = join(root, "report.txt");
		writeFileSync(path, "hello");

		await expect(openDeliveredFile({ path, action: "default" })).resolves.toBeUndefined();
	});
});
