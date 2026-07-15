import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@arcmind/ai";

export const LARGE_TOOL_OUTPUT_MAX_CHARS = 50_000;
export const TOOL_OUTPUT_PREVIEW_BYTES = 2 * 1024;

export interface PersistedToolOutput {
	truncated: true;
	originalBytes: number;
	previewBytes: number;
	fullOutputPath: string;
}

export interface ExternalizedToolOutput {
	content: (TextContent | ImageContent)[];
	toolOutput: PersistedToolOutput;
}

function firstUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
	// A bounded UTF-16 slice avoids allocating a Buffer for the complete large result.
	const bytes = Buffer.from(text.slice(0, maxBytes), "utf8");
	const decoder = new StringDecoder("utf8");
	const preview = decoder.write(bytes.subarray(0, maxBytes));
	return { text: preview, bytes: Buffer.byteLength(preview, "utf8") };
}

export async function externalizeLargeToolOutput(
	content: (TextContent | ImageContent)[],
	outputDir: string,
): Promise<ExternalizedToolOutput | undefined> {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
	if (totalChars <= LARGE_TOOL_OUTPUT_MAX_CHARS) return undefined;

	const fullText = textBlocks.map((block) => block.text).join("");
	const originalBytes = Buffer.byteLength(fullText, "utf8");
	await mkdir(outputDir, { recursive: true, mode: 0o700 });

	const fullOutputPath = join(outputDir, `${randomUUID()}.txt`);
	const outputFile = await open(fullOutputPath, "wx", 0o600);
	try {
		await outputFile.writeFile(fullText, { encoding: "utf8" });
		await outputFile.close();
	} catch (error) {
		await outputFile.close().catch(() => undefined);
		await rm(fullOutputPath, { force: true }).catch(() => undefined);
		throw error;
	}

	const preview = firstUtf8Bytes(fullText, TOOL_OUTPUT_PREVIEW_BYTES);
	const toolOutput: PersistedToolOutput = {
		truncated: true,
		originalBytes,
		previewBytes: preview.bytes,
		fullOutputPath,
	};
	const notice = [
		"[Tool output truncated: preview only]",
		`Original size: ${toolOutput.originalBytes} bytes`,
		`Preview size: ${toolOutput.previewBytes} bytes`,
		`Full output: ${toolOutput.fullOutputPath}`,
		"",
		preview.text,
	].join("\n");

	let noticeInserted = false;
	const boundedContent = content.flatMap((block): (TextContent | ImageContent)[] => {
		if (block.type === "image") return [block];
		if (noticeInserted) return [];
		noticeInserted = true;
		return [{ type: "text", text: notice }];
	});

	return { content: boundedContent, toolOutput };
}
