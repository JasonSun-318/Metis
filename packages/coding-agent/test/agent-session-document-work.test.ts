import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type FauxResponseInput, type Harness } from "./test-harness.ts";

describe("AgentSession document work directory", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	function createDocumentHarness(responses: FauxResponseInput[]): Harness {
		const harness = createHarness({ agentDir: "temp", responses });
		harnesses.push(harness);
		return harness;
	}

	it("does not create a document work root for a plain prompt", async () => {
		const harness = createDocumentHarness(["ok"]);

		await harness.session.prompt("hello");

		expect(existsSync(join(harness.tempDir, "tmp", "document-work"))).toBe(false);
	});

	it("does not create a document work root for ordinary bash", async () => {
		const harness = createDocumentHarness([
			{ toolCalls: [{ name: "bash", args: { command: "printf ordinary" } }] },
			"done",
		]);

		await harness.session.prompt("run a harmless command");

		expect(existsSync(join(harness.tempDir, "tmp", "document-work"))).toBe(false);
	});

	it("creates one work directory on demand and removes it after the prompt", async () => {
		const harness = createDocumentHarness([
			{
				toolCalls: [
					{
						name: "bash",
						args: {
							command:
								'test -d "$METIS_WORK_DIR" && test "$TMPDIR" = "$METIS_WORK_DIR" && test "$TMP" = "$METIS_WORK_DIR" && test "$TEMP" = "$METIS_WORK_DIR"',
						},
					},
				],
			},
			"done",
		]);

		await harness.session.prompt("prepare document work");

		const workRoot = join(harness.tempDir, "tmp", "document-work");
		expect(existsSync(workRoot)).toBe(true);
		expect(readdirSync(workRoot)).toEqual([]);
	});

	it("rejects rebinding the Metis-managed work directory", async () => {
		const harness = createDocumentHarness([
			{
				toolCalls: [
					{
						name: "bash",
						args: {
							command: 'export METIS_WORK_DIR="$PWD/escaped-document-work"; mkdir -p "$METIS_WORK_DIR"',
						},
					},
				],
			},
			"done",
		]);

		await harness.session.prompt("prepare document work");

		expect(existsSync(join(harness.tempDir, "escaped-document-work"))).toBe(false);
	});
});
