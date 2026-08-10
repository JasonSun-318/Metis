import crypto from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	externalizeLargeToolOutput,
	importToolOutputFile,
	isOwnedToolOutputFile,
	LARGE_TOOL_OUTPUT_MAX_CHARS,
	persistToolOutputText,
	TOOL_OUTPUT_PREVIEW_BYTES,
} from "../src/core/large-tool-output.ts";

describe("externalizeLargeToolOutput", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "metis-large-tool-output-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
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
		expect(statSync(result!.toolOutput.fullOutputPath).nlink).toBe(1);
		expect(result?.content[0]).toEqual(image);
		const noticeBlock = result?.content.find((block) => block.type === "text");
		const notice = noticeBlock?.type === "text" ? noticeBlock.text : "";
		expect(notice).toContain("Tool output truncated: preview only");
		expect(notice).toContain(`Original size: ${Buffer.byteLength(fullText, "utf8")} bytes`);
		expect(notice).toContain(`Preview size: ${TOOL_OUTPUT_PREVIEW_BYTES - 1} bytes`);
		expect(notice).toContain(`Full output: ${result?.toolOutput.fullOutputPath}`);
		expect(notice).toContain("If you need the full output, read the saved file.");
		expect(notice).not.toContain("�");
	});

	it("fails without returning a truncated replacement when persistence is unavailable", async () => {
		const blockedPath = join(tempDir, "not-a-directory");
		writeFileSync(blockedPath, "block mkdir");

		await expect(
			externalizeLargeToolOutput([{ type: "text", text: "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1) }], blockedPath),
		).rejects.toThrow();
	});

	it("persists arbitrary text through the same hardened output store", async () => {
		const outputDir = join(tempDir, "tool-results");
		const path = await persistToolOutputText("complete\nresult", outputDir);

		expect(readFileSync(path, "utf8")).toBe("complete\nresult");
		expect(await isOwnedToolOutputFile(path, outputDir)).toBe(true);
		expect(statSync(path).nlink).toBe(1);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("copies an existing full output without loading it into the caller", async () => {
		const sourcePath = join(tempDir, "legacy-bash.log");
		const outputDir = join(tempDir, "tool-results");
		writeFileSync(sourcePath, "full bash output".repeat(10_000));

		const importedPath = await importToolOutputFile(sourcePath, outputDir);

		expect(importedPath).not.toBe(sourcePath);
		expect(readFileSync(importedPath)).toEqual(readFileSync(sourcePath));
		expect(await isOwnedToolOutputFile(importedPath, outputDir)).toBe(true);
	});

	it("reuses a verified file already owned by the session", async () => {
		const outputDir = join(tempDir, "tool-results");
		const storedPath = await persistToolOutputText("already owned", outputDir);

		expect(await importToolOutputFile(storedPath, outputDir)).toBe(storedPath);
		expect(readdirSync(outputDir)).toHaveLength(1);
	});

	it("rejects a symlink source and does not expose its target", async ({ skip }) => {
		const targetPath = join(tempDir, "outside.txt");
		const sourcePath = join(tempDir, "source-link.txt");
		const outputDir = join(tempDir, "tool-results");
		writeFileSync(targetPath, "secret");
		try {
			symlinkSync(targetPath, sourcePath, "file");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Creating symlinks requires Windows Developer Mode");
				return;
			}
			throw error;
		}

		await expect(importToolOutputFile(sourcePath, outputDir)).rejects.toThrow("regular file");
		expect(existsSync(outputDir) ? readdirSync(outputDir) : []).toEqual([]);
	});

	it("rejects a symlinked output directory without writing through it", async ({ skip }) => {
		const targetDir = join(tempDir, "outside");
		const outputDir = join(tempDir, "tool-results");
		mkdirSync(targetDir);
		try {
			symlinkSync(targetDir, outputDir, "dir");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Creating directory symlinks requires Windows Developer Mode");
				return;
			}
			throw error;
		}

		await expect(
			externalizeLargeToolOutput([{ type: "text", text: "secret".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS) }], outputDir),
		).rejects.toThrow("not a real directory");
		expect(readdirSync(targetDir)).toEqual([]);
	});

	it("keeps an ancestor directory symlink usable", async ({ skip }) => {
		const targetParent = join(tempDir, "target-parent");
		const linkedParent = join(tempDir, "linked-parent");
		mkdirSync(targetParent);
		try {
			symlinkSync(targetParent, linkedParent, "dir");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Creating directory symlinks requires Windows Developer Mode");
				return;
			}
			throw error;
		}

		const fullText = "x".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS + 1);
		const result = await externalizeLargeToolOutput(
			[{ type: "text", text: fullText }],
			join(linkedParent, "tool-results"),
		);

		expect(readFileSync(result!.toolOutput.fullOutputPath, "utf8")).toBe(fullText);
	});

	it("rejects a directory swap before writing output content", async () => {
		const outputDir = join(tempDir, "tool-results");
		const movedDir = join(tempDir, "tool-results-original");
		mkdirSync(outputDir);
		const realRandomUUID = crypto.randomUUID.bind(crypto);
		vi.spyOn(crypto, "randomUUID").mockImplementationOnce(() => {
			renameSync(outputDir, movedDir);
			mkdirSync(outputDir);
			return realRandomUUID();
		});

		await expect(
			externalizeLargeToolOutput([{ type: "text", text: "secret".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS) }], outputDir),
		).rejects.toThrow("directory identity changed");
		expect(readdirSync(movedDir)).toEqual([]);
		const replacementFiles = readdirSync(outputDir);
		expect(replacementFiles).toHaveLength(1);
		expect(readFileSync(join(outputDir, replacementFiles[0]), "utf8")).toBe("");
	});

	it("does not remove a replaced leaf after a persistence failure", async () => {
		const outputDir = join(tempDir, "tool-results");
		const probePath = join(tempDir, "probe");
		const probe = await openFile(probePath, "w");
		const prototype = Object.getPrototypeOf(probe) as typeof probe;
		await probe.close();
		rmSync(probePath);

		let replacedPath: string | undefined;
		let orphanPath: string | undefined;
		vi.spyOn(prototype, "datasync").mockImplementationOnce(async function (this: typeof probe) {
			const close = this.close;
			this.close = async () => {
				const [name] = readdirSync(outputDir);
				replacedPath = join(outputDir, name);
				orphanPath = join(tempDir, "original-output.txt");
				renameSync(replacedPath, orphanPath);
				writeFileSync(replacedPath, "replacement");
				await close();
			};
			throw new Error("forced persistence failure");
		});

		const fullText = "secret".repeat(LARGE_TOOL_OUTPUT_MAX_CHARS);
		await expect(externalizeLargeToolOutput([{ type: "text", text: fullText }], outputDir)).rejects.toThrow(
			"forced persistence failure",
		);

		expect(replacedPath).toBeDefined();
		expect(readFileSync(replacedPath!, "utf8")).toBe("replacement");
		expect(readFileSync(orphanPath!, "utf8")).toBe(fullText);
	});
});
