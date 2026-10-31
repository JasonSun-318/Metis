import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeInlineScript } from "../../src/core/permissions/script-analysis.ts";
import type { ShellAnalysisInput } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

const cwd = process.cwd();
const shellPath = getShellConfig().shell;

beforeAll(async () => {
	await initializeShellAnalysis();
});

function input(source: string, overrides: Partial<ShellAnalysisInput> = {}): ShellAnalysisInput {
	return { command: source, cwd, workspaceRoots: [cwd], shellPath, ...overrides };
}

function python(source: string, overrides: Partial<ShellAnalysisInput> = {}) {
	return analyzeInlineScript("python", source, input(source, overrides));
}

function javascript(source: string, overrides: Partial<ShellAnalysisInput> = {}) {
	return analyzeInlineScript("javascript", source, input(source, overrides));
}

function resolved(path: string): string {
	return canonicalizeActionPath(path, cwd);
}

describe("python static subset", () => {
	it("accepts literals, containers, JSON and console output", () => {
		const result = python("import json\nvalue = {'a': [1, 2], 'b': True}\nprint(json.dumps(value))");
		expect(result).toMatchObject({ complete: true, disposition: "safe", effects: [] });
	});

	it("accepts arithmetic, string operations and traced loops", () => {
		expect(python("total = 1 + 2 * 3\nprint(str(total).upper())")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
		expect(python("for i in range(10):\n    print(i)")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
	});

	it("records an explicit non-sensitive read", () => {
		const result = python("data = open('notes.txt').read()\nprint(data.upper())");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.readPaths).toEqual([resolved("notes.txt")]);
	});

	it("accepts pathlib reads of a determinate target", () => {
		const result = python("from pathlib import Path\nprint(Path('README.md').read_text())");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.readPaths).toEqual([resolved("README.md")]);
	});

	it("classifies Path.open and keyword file modes like builtin open", () => {
		expect(python("from pathlib import Path\nPath('output.txt').open('w')")).toMatchObject({
			disposition: "user",
			writePaths: [resolved("output.txt")],
		});
		expect(python("from pathlib import Path\nPath('output.txt').open(mode='w')")).toMatchObject({
			disposition: "user",
			writePaths: [resolved("output.txt")],
		});
		expect(python("open('out.txt', mode='a')")).toMatchObject({
			disposition: "user",
			writePaths: [resolved("out.txt")],
		});
		expect(python("open(file='out.txt', encoding='utf-8', mode='w')")).toMatchObject({
			disposition: "user",
			writePaths: [resolved("out.txt")],
		});
		expect(python("open('out.txt', 'r+b')")).toMatchObject({
			disposition: "user",
			writePaths: [resolved("out.txt")],
		});
		expect(python("from pathlib import Path\nprint(Path('notes.txt').open().read())")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
		expect(python("from pathlib import Path\nprint(Path('notes.txt').open('rb').read())")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
	});

	it("treats an explicit outside read as review", () => {
		const result = python("print(open('/etc/hosts').read())");
		expect(result).toMatchObject({ complete: true, disposition: "review" });
		expect(result.readPaths).toEqual([resolved("/etc/hosts")]);
	});

	it("treats a sensitive read as user with the effect", () => {
		const result = python("print(open('.env').read())");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
	});

	it("records a determinate write and refuses to call it read-only", () => {
		const result = python("open('out.txt', 'w').write('x')");
		expect(result.disposition).toBe("user");
		expect(result.writePaths).toEqual([resolved("out.txt")]);
	});

	it.each([
		["os process execution", "import os\nos.system('rm -rf /')"],
		["subprocess import", "import subprocess"],
		["eval", "eval('1+1')"],
		["exec", "exec('x = 1')"],
		["compile", "compile('1+1', 'x', 'eval')"],
		["reflection", "print(getattr(object, '__class__'))"],
		["dynamic import", "print(__import__('os').getcwd())"],
		["network module", "import requests\nrequests.get('https://example.com')"],
		["dynamic path", "path = input()\nprint(open(path).read())"],
		["function definition", "def f(x):\n    return x + 1\nprint(f(1))"],
		["unbounded loop", "while True:\n    print(1)"],
		["unknown function", "mystery(1)"],
		["class reflection", "class A:\n    pass\nprint(A())"],
	])("does not treat %s as safe", (_label, source) => {
		const result = python(source);
		expect(result.disposition).not.toBe("safe");
	});

	it("rejects syntax errors and oversized scripts", () => {
		expect(python("def f(:\n  pass")).toMatchObject({ disposition: "user", complete: false });
		expect(python(`print(${"a".repeat(33 * 1024)})`)).toMatchObject({
			disposition: "user",
			complete: false,
		});
	});

	it("denies a protected metadata write", () => {
		const result = python("open('.git/config', 'w').write('x')");
		expect(result.disposition).toBe("deny");
	});
});

describe("javascript static subset", () => {
	it("accepts literals, JSON and console output", () => {
		const result = javascript("const value = { a: [1, 2] };\nconsole.log(JSON.stringify(value));");
		expect(result).toMatchObject({ complete: true, disposition: "safe", effects: [] });
	});

	it("accepts arithmetic and traced loops", () => {
		expect(javascript("const x = 1 + 2 * 3;\nconsole.log(x);")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
		expect(javascript("for (let i = 0; i < 10; i++) console.log(i);")).toMatchObject({
			complete: true,
			disposition: "safe",
		});
	});

	it("records require-based and import-based file reads", () => {
		const required = javascript("const fs = require('node:fs');\nconsole.log(fs.readFileSync('README.md', 'utf8'));");
		expect(required).toMatchObject({ complete: true, disposition: "safe" });
		expect(required.readPaths).toEqual([resolved("README.md")]);

		const imported = javascript("import fs from 'node:fs';\nconsole.log(fs.readFileSync('README.md', 'utf8'));");
		expect(imported).toMatchObject({ complete: true, disposition: "safe" });
		expect(imported.readPaths).toEqual([resolved("README.md")]);
	});

	it("evaluates a static path.join target", () => {
		const result = javascript(
			"const fs = require('node:fs');\nconst path = require('node:path');\nconsole.log(fs.readFileSync(path.join('src', 'a.txt'), 'utf8'));",
		);
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.readPaths).toEqual([resolved("src/a.txt")]);
	});

	it("records a determinate write and refuses to call it read-only", () => {
		const result = javascript("const fs = require('node:fs');\nfs.writeFileSync('out.txt', 'x');");
		expect(result.disposition).toBe("user");
		expect(result.writePaths).toEqual([resolved("out.txt")]);
	});

	it("treats a sensitive read as user", () => {
		const result = javascript("const fs = require('node:fs');\nconsole.log(fs.readFileSync('.env', 'utf8'));");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
	});

	it.each([
		["child_process", "require('child_process').execSync('rm -rf /')"],
		["destructured child_process", "const { exec } = require('child_process');"],
		["eval", "eval('1 + 1')"],
		["Function constructor", "new Function('return 1')()"],
		["dynamic import", "import('node:fs')"],
		["network", "fetch('https://example.com')"],
		["process control", "process.exit(0)"],
		["environment access", "console.log(process.env.HOME)"],
		["reflection", "console.log(Reflect.ownKeys({}))"],
		["unknown function", "mystery(1)"],
		["dynamic path", "const fs = require('node:fs');\nconst path = process.argv[2];\nfs.readFileSync(path);"],
		["unbounded loop", "while (true) {}"],
		["arrow function", "console.log([1, 2].map((x) => x + 1))"],
		["promise", "Promise.resolve(1)"],
		["async", "async function f() { await fetch('x'); }"],
	])("does not treat %s as safe", (_label, source) => {
		expect(javascript(source).disposition).not.toBe("safe");
	});

	it("rejects syntax errors and oversized scripts", () => {
		expect(javascript("const x = {;")).toMatchObject({ disposition: "user", complete: false });
		expect(javascript(`console.log(${"a".repeat(33 * 1024)});`)).toMatchObject({
			disposition: "user",
			complete: false,
		});
	});
});

describe("script analysis safety boundaries", () => {
	it("never executes the analyzed script", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-script-no-exec-"));
		const marker = join(directory, "marker");
		try {
			writeFileSync(marker, "present");
			python(`import os\nos.remove(${JSON.stringify(marker)})`);
			javascript(`require('node:fs').unlinkSync(${JSON.stringify(marker)});`);
			expect(existsSync(marker)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not accept a script just because it avoids dangerous words", () => {
		expect(python("value = globals()\nprint(value)").disposition).toBe("user");
		expect(javascript("console.log(globalThis);").disposition).toBe("user");
	});
});
