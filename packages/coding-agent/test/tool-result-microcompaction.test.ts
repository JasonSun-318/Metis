import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@metis/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createToolResultMicrocompactor,
	MICROCOMPACTION_KEEP_RECENT,
	MICROCOMPACTION_TRIGGER_TOKENS,
} from "../src/core/tool-result-microcompaction.ts";

function result(id: string, text: string, overrides: Partial<Extract<AgentMessage, { role: "toolResult" }>> = {}) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text" as const, text }],
		details: {},
		isError: false,
		timestamp: Number(id.replace(/\D/g, "")) || 1,
		...overrides,
	};
}

function textOf(message: AgentMessage): string {
	return "content" in message && Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("")
		: "";
}

describe("tool-result microcompaction", () => {
	let root: string;
	let outputDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-microcompaction-"));
		outputDir = join(root, "tool-results");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("does no I/O below the 20,000-token threshold", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const messages = [result("1", "x".repeat(MICROCOMPACTION_TRIGGER_TOKENS * 4 - 4))];
		for (let index = 2; index <= MICROCOMPACTION_KEEP_RECENT + 1; index++) {
			messages.push(result(String(index), "recent"));
		}

		expect(await compact(messages)).toBe(messages);
		expect(existsSync(outputDir)).toBe(false);
	});

	it.each(["web_fetch", "web_search"])("clears older %s results at the exact threshold", async (toolName) => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const oldText = "x".repeat(MICROCOMPACTION_TRIGGER_TOKENS * 4);
		const messages = [result("1", oldText, { toolName })];
		for (let index = 2; index <= MICROCOMPACTION_KEEP_RECENT + 1; index++) {
			messages.push(result(String(index), `recent-${index}`));
		}
		const snapshot = structuredClone(messages);

		const projected = await compact(messages);

		expect(projected).not.toBe(messages);
		expect(textOf(projected[0]!)).toMatch(/^<tool-result-cleared>[\s\S]*Tool result saved to:/);
		expect(textOf(projected[0]!)).not.toContain(oldText);
		expect(projected.slice(1)).toEqual(messages.slice(1));
		expect(messages).toEqual(snapshot);
		expect(readFileSync(readdirSync(outputDir).map((name) => join(outputDir, name))[0]!, "utf8")).toBe(oldText);
	});

	it("clears every older eligible result when their combined size reaches the threshold", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const messages = [
			result("old-1", "a".repeat(40_000)),
			result("old-2", "b".repeat(40_000)),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];

		const projected = await compact(messages);

		expect(textOf(projected[0]!)).toContain("tool-result-cleared");
		expect(textOf(projected[1]!)).toContain("tool-result-cleared");
		expect(projected.slice(2)).toEqual(messages.slice(2));
		expect(readdirSync(outputDir)).toHaveLength(2);
	});

	it("counts only eligible results when protecting the latest five", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: (name) => name === "read" });
		const messages: AgentMessage[] = [result("old", "x".repeat(80_000))];
		for (let index = 0; index < 20; index++) {
			messages.push(result(`custom-${index}`, "custom", { toolName: "mcp_search" }));
		}
		for (let index = 0; index < 5; index++) messages.push(result(`recent-${index}`, "recent"));

		const projected = await compact(messages);

		expect(textOf(projected[0]!)).toContain("tool-result-cleared");
		expect(projected.slice(1, 21)).toEqual(messages.slice(1, 21));
	});

	it.each(["set_tasks", "spawn_agent", "mcp_search", "custom_tool"])("never clears %s results", async (toolName) => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const messages = [result("old", "x".repeat(100_000), { toolName })];
		for (let index = 0; index < 5; index++) messages.push(result(`recent-${index}`, "recent"));

		expect(await compact(messages)).toBe(messages);
		expect(existsSync(outputDir)).toBe(false);
	});

	it("clears bash only when a complete output path is declared", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const withoutPath = [
			result("old", "x".repeat(100_000), { toolName: "bash" }),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];

		expect(await compact(withoutPath)).toBe(withoutPath);
		expect(existsSync(outputDir)).toBe(false);

		const sourcePath = join(root, "bash-full.log");
		writeFileSync(sourcePath, "complete bash output");
		const withPath = [
			result("old", "x".repeat(100_000), { toolName: "bash", details: { fullOutputPath: sourcePath } }),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];
		const projected = await compact(withPath);

		expect(textOf(projected[0]!)).toContain("tool-result-cleared");
		expect(readdirSync(outputDir)).toHaveLength(1);
	});

	it("keeps shadowed builtins, image results, and allows eligible text errors", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: (name) => name !== "grep" });
		const shadowed = result("shadowed", "s".repeat(80_000), { toolName: "grep" });
		const image = result("image", "ignored", {
			content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});
		const error = result("error", "e".repeat(80_000), { isError: true });
		const messages = [shadowed, image, error];
		for (let index = 0; index < 5; index++) messages.push(result(`recent-${index}`, "recent"));

		const projected = await compact(messages);

		expect(projected[0]).toEqual(shadowed);
		expect(projected[1]).toEqual(image);
		expect(textOf(projected[2]!)).toContain("tool-result-cleared");
	});

	it("removes an existing preview only after importing its complete file", async () => {
		const sourcePath = join(root, "legacy-full.log");
		writeFileSync(sourcePath, "complete legacy output");
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const messages = [
			result("old", "preview only".repeat(8_000), { details: { fullOutputPath: sourcePath } }),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];

		const projected = await compact(messages);
		const placeholder = textOf(projected[0]!);
		const savedPath = placeholder.match(/Tool result saved to: (.+)/)?.[1];

		expect(savedPath).toBeDefined();
		expect(savedPath).not.toBe(sourcePath);
		expect(placeholder).not.toContain("preview only");
		expect(readFileSync(savedPath!, "utf8")).toBe("complete legacy output");
	});

	it("keeps the preview when its declared complete file is unavailable", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const messages = [
			result("old", "preview only".repeat(8_000), { details: { fullOutputPath: join(root, "missing.log") } }),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];

		const projected = await compact(messages);

		expect(projected[0]).toBe(messages[0]);
	});

	it("honors cancellation before persistence", async () => {
		const compact = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const messages = [
			result("old", "x".repeat(80_000)),
			...Array.from({ length: 5 }, (_, index) => result(`recent-${index}`, "recent")),
		];

		await expect(compact(messages, controller.signal)).rejects.toThrow("cancelled");
		expect(existsSync(outputDir)).toBe(false);
	});

	it("reuses stable paths across repeated projections and isolates concurrent sessions", async () => {
		const otherOutputDir = join(root, "other-tool-results");
		const first = createToolResultMicrocompactor({ outputDir, isBuiltinTool: () => true });
		const second = createToolResultMicrocompactor({ outputDir: otherOutputDir, isBuiltinTool: () => true });
		const messages = [
			result("old", "x".repeat(80_000)),
			...Array.from({ length: 5 }, (_, index) => result(`r-${index}`, "r")),
		];

		const [firstProjection, duplicateProjection, secondProjection] = await Promise.all([
			first(messages),
			first(structuredClone(messages)),
			second(messages),
		]);
		const repeated = await first(structuredClone(messages));

		expect(textOf(repeated[0]!)).toBe(textOf(firstProjection[0]!));
		expect(textOf(duplicateProjection[0]!)).toBe(textOf(firstProjection[0]!));
		expect(readdirSync(outputDir)).toHaveLength(1);
		expect(readdirSync(otherOutputDir)).toHaveLength(1);
		expect(textOf(firstProjection[0]!)).not.toBe(textOf(secondProjection[0]!));
	});
});
