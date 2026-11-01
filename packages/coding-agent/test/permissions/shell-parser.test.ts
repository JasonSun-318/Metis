import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	getShellParserStatus,
	initializeShellAnalysis,
	parseInlineScriptSyntax,
	parseShellSyntax,
} from "../../src/core/permissions/shell-parser.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

const shellPath = getShellConfig().shell;

beforeAll(async () => {
	await initializeShellAnalysis();
});

describe("trusted shell parser", () => {
	it("parses a whole compound without evaluating it", () => {
		const source = "printf '%s\\n' '权限' | head -1 && pwd";
		const parsed = parseShellSyntax(source, shellPath);
		try {
			expect(parsed.complete).toBe(true);
			expect(parsed.root?.text).toBe(source);
		} finally {
			parsed.dispose();
		}
	});

	it("does not count a flat conditional chain as nested shell scopes", () => {
		const source = Array.from({ length: 80 }, () => "pwd | head -n 1").join(" &&\n");
		const parsed = parseShellSyntax(source, shellPath);
		try {
			expect(parsed.complete, parsed.reason).toBe(true);
			expect(parsed.root?.text).toBe(source);
		} finally {
			parsed.dispose();
		}
	});

	it("reports an incomplete tree for trailing syntax errors", () => {
		const parsed = parseShellSyntax("if true; then\n  echo hi\n", shellPath);
		try {
			expect(parsed.complete).toBe(false);
			expect(parsed.root).toBeNull();
			expect(parsed.reason).toBeTruthy();
		} finally {
			parsed.dispose();
		}
	});

	it("accepts exactly 32 KiB and rejects one byte more", () => {
		const allowed = `echo ${"a".repeat(32 * 1024 - 5)}`;
		expect(Buffer.byteLength(allowed, "utf8")).toBe(32 * 1024);
		const allowedParsed = parseShellSyntax(allowed, shellPath);
		try {
			expect(allowedParsed.complete).toBe(true);
		} finally {
			allowedParsed.dispose();
		}

		const rejected = `${allowed}a`;
		expect(Buffer.byteLength(rejected, "utf8")).toBe(32 * 1024 + 1);
		const rejectedParsed = parseShellSyntax(rejected, shellPath);
		try {
			expect(rejectedParsed.complete).toBe(false);
			expect(rejectedParsed.root).toBeNull();
			expect(rejectedParsed.reason).toMatch(/32 KiB/u);
		} finally {
			rejectedParsed.dispose();
		}
	});

	it("rejects trees deeper than the nesting budget", () => {
		let source = "pwd";
		for (let depth = 0; depth < 40; depth += 1) {
			source = `{ ${source}; }`;
		}
		const parsed = parseShellSyntax(source, shellPath);
		try {
			expect(parsed.complete).toBe(false);
			expect(parsed.root).toBeNull();
			expect(parsed.reason).toMatch(/nesting/u);
		} finally {
			parsed.dispose();
		}
	});

	it("honors an explicit shared deadline and never extends the standalone budget", () => {
		const startedAt = Date.now();
		const expired = parseShellSyntax("pwd", shellPath, Date.now() - 1);
		try {
			expect(expired.complete).toBe(false);
			expect(expired.reason).toMatch(/time budget/u);
		} finally {
			expired.dispose();
		}
		expect(Date.now() - startedAt).toBeLessThan(50);

		// A deadline far in the future must not extend the standalone 100ms budget.
		const now = Date.now();
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValueOnce(now);
		clock.mockReturnValue(now + 1_000);
		try {
			const parsed = parseShellSyntax("pwd", shellPath, now + 10_000);
			try {
				expect(parsed.complete).toBe(false);
				expect(parsed.reason).toMatch(/time budget/u);
			} finally {
				parsed.dispose();
			}
		} finally {
			clock.mockRestore();
		}
	});

	it("applies the shared absolute deadline to inline scripts too", () => {
		const expired = parseInlineScriptSyntax("print(1)", "python", Date.now() - 1);
		try {
			expect(expired.complete).toBe(false);
			expect(expired.reason).toMatch(/time budget/u);
		} finally {
			expired.dispose();
		}
	});

	it("rejects trees larger than the node budget", () => {
		const source = Array.from({ length: 4_000 }, () => "echo a").join("; ");
		expect(Buffer.byteLength(source, "utf8")).toBeLessThan(32 * 1024);
		const parsed = parseShellSyntax(source, shellPath);
		try {
			expect(parsed.complete).toBe(false);
			expect(parsed.root).toBeNull();
			expect(parsed.reason).toMatch(/node budget/u);
		} finally {
			parsed.dispose();
		}
	});

	it("stops parsing when the time budget expires and recovers on the next parse", () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValueOnce(now);
		clock.mockReturnValue(now + 1_000);
		try {
			const parsed = parseShellSyntax("pwd", shellPath);
			try {
				expect(parsed.complete).toBe(false);
				expect(parsed.root).toBeNull();
				expect(parsed.reason).toMatch(/time budget/u);
			} finally {
				parsed.dispose();
			}
		} finally {
			clock.mockRestore();
		}

		const recovered = parseShellSyntax("pwd", shellPath);
		try {
			expect(recovered.complete).toBe(true);
			expect(recovered.root?.text).toBe("pwd");
		} finally {
			recovered.dispose();
		}
	});

	it("never executes the source it parses", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-parser-no-exec-"));
		const marker = join(directory, "marker");
		try {
			const parsed = parseShellSyntax(`touch '${marker}'`, shellPath);
			try {
				expect(parsed.complete).toBe(true);
			} finally {
				parsed.dispose();
			}
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses shells the Bash grammar cannot represent", () => {
		const parsed = parseShellSyntax("pwd", "/bin/sh");
		try {
			expect(parsed.complete).toBe(false);
			expect(parsed.reason).toMatch(/unsupported/u);
		} finally {
			parsed.dispose();
		}
	});

	it("exposes the same trusted runtime for later Python and JavaScript analysis", () => {
		for (const [language, source, rootText] of [
			["python", "value = {'ok': True}", "value = {'ok': True}"],
			["javascript", "const value = { ok: true };", "const value = { ok: true };"],
		] as const) {
			const parsed = parseInlineScriptSyntax(source, language);
			try {
				expect(parsed.complete).toBe(true);
				expect(parsed.root?.text).toBe(rootText);
			} finally {
				parsed.dispose();
			}
		}
	});

	it("reports ready only after initialization", () => {
		expect(getShellParserStatus().ready).toBe(true);
		expect(getShellParserStatus().reason).toBeUndefined();
	});
});

describe("shell parser trust boundary", () => {
	it("initializes cold grammar execution before budgeting an untrusted command", async () => {
		const requireRuntime = createRequire(
			join(import.meta.dirname, "../../dist/vendor/shell-analysis/tree-sitter.js"),
		);
		const runtime = requireRuntime("./tree-sitter.js") as typeof import("@vscode/tree-sitter-wasm");
		const originalParse = runtime.Parser.prototype.parse;
		let now = Date.now();
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const parse = vi.spyOn(runtime.Parser.prototype, "parse").mockImplementationOnce(function (
			this: InstanceType<typeof runtime.Parser>,
			...args
		) {
			// Model the first WASM invocation consuming the command's entire budget.
			now += 1_000;
			return originalParse.apply(this, args);
		});
		vi.resetModules();
		try {
			const parser = await import("../../src/core/permissions/shell-parser.ts");
			await parser.initializeShellAnalysis();
			expect(parser.getShellParserStatus().ready).toBe(true);
			const { analyzeShellCommand } = await import("../../src/core/permissions/shell-analysis.ts");
			expect(
				analyzeShellCommand({
					command: "echo sandbox-command-ok",
					cwd: process.cwd(),
					workspaceRoots: [process.cwd()],
					shellPath: "/bin/bash",
				}),
			).toMatchObject({ complete: true, disposition: "safe", writePaths: [] });
		} finally {
			parse.mockRestore();
			clock.mockRestore();
			vi.resetModules();
		}
	});

	it("reports missing assets without trusting a workspace fallback", async () => {
		const temporaryPackageDir = mkdtempSync(join(tmpdir(), "metis-missing-parser-"));
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const fs = await importOriginal<typeof import("node:fs")>();
			return {
				...fs,
				lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
					if (String(args[0]).includes("vendor/shell-analysis")) throw new Error("ENOENT");
					return fs.lstatSync(...args);
				},
			};
		});
		try {
			const parser = await import("../../src/core/permissions/shell-parser.ts");
			await parser.initializeShellAnalysis();
			expect(parser.getShellParserStatus().ready).toBe(false);
			expect(parser.getShellParserStatus().reason).toBeTruthy();
			const parsed = parser.parseShellSyntax("pwd", shellPath);
			try {
				expect(parsed.complete).toBe(false);
				expect(parsed.root).toBeNull();
			} finally {
				parsed.dispose();
			}
		} finally {
			vi.doUnmock("node:fs");
			vi.resetModules();
			rmSync(temporaryPackageDir, { recursive: true, force: true });
		}
	});

	it("ignores grammars planted in the workspace or an asset environment override", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-fake-parser-"));
		const marker = join(root, "executed");
		const fakeAssetDir = join(root, "project", "dist", "vendor", "shell-analysis");
		mkdirSync(fakeAssetDir, { recursive: true });
		writeFileSync(
			join(fakeAssetDir, "tree-sitter.js"),
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`,
		);
		const previousAssetDir = process.env.METIS_SHELL_ANALYSIS_DIR;
		process.env.METIS_SHELL_ANALYSIS_DIR = fakeAssetDir;
		vi.resetModules();
		try {
			const parser = await import("../../src/core/permissions/shell-parser.ts");
			await parser.initializeShellAnalysis();
			expect(parser.getShellParserStatus().ready).toBe(true);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (previousAssetDir === undefined) delete process.env.METIS_SHELL_ANALYSIS_DIR;
			else process.env.METIS_SHELL_ANALYSIS_DIR = previousAssetDir;
			vi.resetModules();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores a forged package override even with a matching asset manifest", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-fake-package-"));
		const assetDir = join(root, "dist", "vendor", "shell-analysis");
		const marker = join(root, "executed");
		cpSync(join(import.meta.dirname, "../../dist/vendor/shell-analysis"), assetDir, { recursive: true });
		const runtimePath = join(assetDir, "tree-sitter.js");
		writeFileSync(
			runtimePath,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n${readFileSync(runtimePath, "utf8")}`,
		);
		const manifestPath = join(assetDir, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		for (const entry of manifest.files) {
			const bytes = readFileSync(join(assetDir, entry.name));
			entry.sha256 = createHash("sha256").update(bytes).digest("hex");
			entry.bytes = bytes.byteLength;
		}
		writeFileSync(manifestPath, JSON.stringify(manifest));
		const previousPackageDir = process.env.METIS_PACKAGE_DIR;
		process.env.METIS_PACKAGE_DIR = root;
		vi.resetModules();
		try {
			const parser = await import("../../src/core/permissions/shell-parser.ts");
			await parser.initializeShellAnalysis();
			expect(parser.getShellParserStatus().ready).toBe(true);
			expect(existsSync(marker)).toBe(false);
		} finally {
			if (previousPackageDir === undefined) delete process.env.METIS_PACKAGE_DIR;
			else process.env.METIS_PACKAGE_DIR = previousPackageDir;
			vi.resetModules();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
