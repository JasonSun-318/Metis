import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	externalizeLargeToolOutput,
	LARGE_TOOL_OUTPUT_MAX_CHARS,
	TOOL_OUTPUT_PREVIEW_BYTES,
} from "../src/core/large-tool-output.ts";

describe("externalizeLargeToolOutput", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "arcmind-large-tool-output-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("leaves output at the 50,000-character boundary unchanged", async () => {
		const result = await externalizeLargeToolOutput(
			[{ type: "text", text: "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS) }],
			join(tempDir, "tool-results"),
		);

		expect(result).toBeUndefined();
		expect(existsSync(join(tempDir, "tool-results"))).toBe(false);
	});

	it("stores oversized output and returns an explicit UTF-8-safe preview", async () => {
		const fullText = `${"a".repeat(TOOL_OUTPUT_PREVIEW_BYTES - 1)}你${"z".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS)}`;
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const outputDir = join(tempDir, "tool-results");
		const result = await externalizeLargeToolOutput([image, { type: "text", text: fullText }], outputDir);

		expect(result).toBeDefined();
		expect(result?.toolOutput).toMatchObject({
			truncated: true,
			originalBytes: Buffer.byteLength(fullText, "utf8"),
			previewBytes: TOOL_OUTPUT_PREVIEW_BYTES - 1,
		});
		expect(readFileSync(result!.toolOutput.fullOutputPath, "utf8")).toBe(fullText);
		if (process.platform !== "win32") {
			expect(statSync(outputDir).mode & 0o777).toBe(0o700);
			expect(statSync(result!.toolOutput.fullOutputPath).mode & 0o777).toBe(0o600);
		}
		expect(result?.content[0]).toEqual(image);
		const noticeBlock = result?.content.find((block) => block.type === "text");
		const notice = noticeBlock?.type === "text" ? noticeBlock.text : "";
		expect(notice).toContain("Tool output truncated: preview only");
		expect(notice).toContain(`Original size: ${Buffer.byteLength(fullText, "utf8")} bytes`);
		expect(notice).toContain(`Preview size: ${TOOL_OUTPUT_PREVIEW_BYTES - 1} bytes`);
		expect(notice).toContain(`Full output: ${result?.toolOutput.fullOutputPath}`);
		expect(notice).not.toContain("�");
	});

	it("fails without returning a truncated replacement when persistence is unavailable", async () => {
		const blockedPath = join(tempDir, "not-a-directory");
		writeFileSync(blockedPath, "block mkdir");

		await expect(
			externalizeLargeToolOutput([{ type: "text", text: "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1) }], blockedPath),
		).rejects.toThrow();
	});
});
