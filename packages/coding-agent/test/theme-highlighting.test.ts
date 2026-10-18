import { resetCapabilitiesCache, setCapabilities } from "@metis/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const highlightMock = vi.hoisted(() => vi.fn());
const supportsLanguageMock = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/syntax-highlight.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/syntax-highlight.ts")>();
	highlightMock.mockImplementation(actual.highlight);
	supportsLanguageMock.mockImplementation(actual.supportsLanguage);
	return { ...actual, highlight: highlightMock, supportsLanguage: supportsLanguageMock };
});

import { getMarkdownTheme, highlightCode, initTheme, setTheme } from "../src/modes/interactive/theme/theme.ts";
import type { highlight, supportsLanguage } from "../src/utils/syntax-highlight.ts";

const ANSI = {
	darkKeyword: "\x1b[38;2;86;156;214m",
	darkNumber: "\x1b[38;2;181;206;168m",
	darkCodeBlock: "\x1b[38;2;181;189;104m",
	lightKeyword: "\x1b[38;2;0;0;255m",
	lightNumber: "\x1b[38;2;9;134;88m",
	lightCodeBlock: "\x1b[38;2;88;132;88m",
	reset: "\x1b[39m",
} as const;

function mdCodeBlock(color: string, text: string): string {
	return `${color}${text}${ANSI.reset}`;
}

function highlightedConst(keyword: string, number: string): string {
	return `${keyword}const${ANSI.reset} value = ${number}1${ANSI.reset};`;
}

let actualHighlight: typeof highlight;
let actualSupportsLanguage: typeof supportsLanguage;

describe("theme highlighting", () => {
	beforeAll(async () => {
		const actual = await vi.importActual<typeof import("../src/utils/syntax-highlight.ts")>(
			"../src/utils/syntax-highlight.ts",
		);
		actualHighlight = actual.highlight;
		actualSupportsLanguage = actual.supportsLanguage;
	});

	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});

	afterEach(() => {
		highlightMock.mockReset();
		supportsLanguageMock.mockReset();
		highlightMock.mockImplementation(actualHighlight);
		supportsLanguageMock.mockImplementation(actualSupportsLanguage);
		vi.restoreAllMocks();
		resetCapabilitiesCache();
	});

	it("returns exact highlighted lines and preserves trailing newlines", () => {
		const expected = highlightedConst(ANSI.darkKeyword, ANSI.darkNumber);

		expect(highlightCode("const value = 1;\n", "typescript")).toEqual([expected, ""]);
		expect(highlightCode("const value = 1;", "typescript")).toEqual([expected]);
		expect(highlightCode("first\nsecond\n", "typescript")).toEqual(["first", "second", ""]);
		expect(highlightMock).toHaveBeenCalledWith("const value = 1;\n", {
			language: "typescript",
			ignoreIllegals: true,
			theme: expect.any(Object),
		});
	});

	it("skips the renderer and themes every line for unknown and absent languages", () => {
		expect(highlightCode("first\nsecond\n")).toEqual([
			mdCodeBlock(ANSI.darkCodeBlock, "first"),
			mdCodeBlock(ANSI.darkCodeBlock, "second"),
			mdCodeBlock(ANSI.darkCodeBlock, ""),
		]);
		expect(supportsLanguageMock).not.toHaveBeenCalled();
		expect(highlightMock).not.toHaveBeenCalled();

		expect(highlightCode("first\nsecond\n", "not-a-real-language")).toEqual([
			mdCodeBlock(ANSI.darkCodeBlock, "first"),
			mdCodeBlock(ANSI.darkCodeBlock, "second"),
			mdCodeBlock(ANSI.darkCodeBlock, ""),
		]);
		expect(supportsLanguageMock).toHaveBeenCalledWith("not-a-real-language");
		expect(highlightMock).not.toHaveBeenCalled();
	});

	it("uses distinct raw and themed fallbacks when highlighting throws", () => {
		highlightMock.mockImplementation(() => {
			throw new Error("forced highlight failure");
		});

		const raw = highlightCode("first\nsecond\n", "typescript");
		const themed = getMarkdownTheme().highlightCode!("first\nsecond\n", "typescript");

		expect(raw).toEqual(["first", "second", ""]);
		expect(themed).toEqual([
			mdCodeBlock(ANSI.darkCodeBlock, "first"),
			mdCodeBlock(ANSI.darkCodeBlock, "second"),
			mdCodeBlock(ANSI.darkCodeBlock, ""),
		]);
		expect(raw).not.toEqual(themed);
		expect(highlightMock).toHaveBeenCalledTimes(2);
		expect(highlightMock).toHaveBeenNthCalledWith(1, "first\nsecond\n", {
			language: "typescript",
			ignoreIllegals: true,
			theme: expect.any(Object),
		});
	});

	it("keeps language validation outside the highlight exception boundary", () => {
		supportsLanguageMock.mockImplementation(() => {
			throw new Error("forced language failure");
		});

		expect(() => highlightCode("first", "typescript")).toThrow("forced language failure");
		expect(() => getMarkdownTheme().highlightCode!("first", "typescript")).toThrow("forced language failure");
		expect(highlightMock).not.toHaveBeenCalled();
	});

	it("reads the current theme through a previously acquired markdown callback", () => {
		const markdownHighlight = getMarkdownTheme().highlightCode!;

		expect(markdownHighlight("first", "not-a-real-language")).toEqual([mdCodeBlock(ANSI.darkCodeBlock, "first")]);
		expect(highlightMock).not.toHaveBeenCalled();
		expect(setTheme("light")).toEqual({ success: true });
		expect(markdownHighlight("first", "not-a-real-language")).toEqual([mdCodeBlock(ANSI.lightCodeBlock, "first")]);
		expect(highlightMock).not.toHaveBeenCalled();
		expect(markdownHighlight("const value = 1;", "typescript")).toEqual([
			highlightedConst(ANSI.lightKeyword, ANSI.lightNumber),
		]);
		expect(highlightMock).toHaveBeenCalledWith("const value = 1;", {
			language: "typescript",
			ignoreIllegals: true,
			theme: expect.any(Object),
		});
	});

	it("renders cached cli highlight theme formatters with current theme colors", () => {
		expect(highlightCode("const value = 1;", "typescript")).toEqual([
			highlightedConst(ANSI.darkKeyword, ANSI.darkNumber),
		]);
		expect(setTheme("light")).toEqual({ success: true });
		expect(highlightCode("const value = 1;", "typescript")).toEqual([
			highlightedConst(ANSI.lightKeyword, ANSI.lightNumber),
		]);
	});
});
