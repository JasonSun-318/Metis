import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	analyzeShellCommand,
	mergeShellDisposition,
	type ShellAnalysisInput,
} from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

const cwd = process.cwd();
const shellPath = getShellConfig().shell;

beforeAll(async () => {
	await initializeShellAnalysis();
});

function analyze(command: string, overrides: Partial<ShellAnalysisInput> = {}) {
	return analyzeShellCommand({
		command,
		cwd,
		workspaceRoots: [cwd],
		shellPath,
		...overrides,
	});
}

function resolved(path: string): string {
	return canonicalizeActionPath(path, cwd);
}

describe("complete compound analysis", () => {
	it("accepts a complete safe command longer than 256 bytes", () => {
		const command = Array.from({ length: 20 }, () => "rg --files src").join(" && ");
		const result = analyze(command);
		expect(Buffer.byteLength(command, "utf8")).toBeGreaterThan(256);
		expect(result).toMatchObject({ complete: true, disposition: "safe", effects: [] });
	});

	it("does not let a safe prefix hide a destructive tail", () => {
		const result = analyze("git status --short && rm -rf ./dist");
		expect(result.disposition).not.toBe("safe");
		expect(result.effects).toContain("destructive");
		expect(result.writePaths).toContain(resolved("dist"));
	});

	it.each([
		["pipe", "cat package.json | head -n 1 | wc -l"],
		["semicolon inside quotes", "printf '%s\\n' 'a;b'"],
		["short circuit tail", "pwd || ls"],
		["subshell", "(cd src && ls) || pwd"],
		["command substitution", 'echo "$(printf hi)"'],
		["if branches", "if true; then pwd; else cat package.json; fi"],
		["while with known condition", "while false; do pwd; done"],
		["for without dynamic expansion", "for f in a b; do pwd; done"],
		["case branches", "case x in a) pwd;; *) pwd;; esac"],
		["heredoc input", "cat <<'EOF' | wc -l\nhello\nEOF"],
		["unicode path", "cat '文档/说明.txt'"],
		["emoji path", "cat '文档/🚀.txt'"],
		["stderr to dev null", "cat package.json 2>/dev/null"],
	])("keeps a fully understood %s safe", (_label, command) => {
		expect(analyze(command)).toMatchObject({ complete: true, disposition: "safe" });
	});

	it("propagates cd before a relative read", () => {
		const result = analyze("cd src && cat package.json");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.readPaths).toEqual([resolved("src/package.json")]);
	});

	it("merges divergent branch cwds conservatively", () => {
		const result = analyze("if [ -d a ]; then cd a; else cd b; fi; cat x");
		expect(result.disposition).toBe("user");
		expect(result.complete).toBe(false);
	});

	it("keeps a destructive command substitution visible", () => {
		const result = analyze('echo "$(rm -rf dist)"');
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("destructive");
	});

	it("keeps a destructive branch visible", () => {
		const result = analyze("if true; then rm -rf dist; fi");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("destructive");
	});
});

describe("read-only command semantics", () => {
	it.each([
		["pwd", "pwd"],
		["ls", "ls -la src"],
		["rg", "rg --files src"],
		["grep", "grep -rn -e pattern src"],
		["cat", "cat package.json"],
		["head", "head -n 5 package.json"],
		["tail", "tail -20 package.json"],
		["wc", "wc -l package.json"],
		["sort", "sort package.json"],
		["uniq", "uniq package.json"],
		["cut", "cut -d, -f1 package.json"],
		["echo", "echo hello"],
		["printf", "printf '%s\\n' hello"],
		["git status", "git status --short"],
		["git diff", "git diff --stat"],
		["git log", "git log -n 5 --oneline"],
		["git show", "git show HEAD"],
	])("accepts read-only %s", (_label, command) => {
		const result = analyze(command);
		expect(result.disposition).toBe("safe");
		expect(result.complete).toBe(true);
		expect(result.writePaths).toEqual([]);
	});

	it("records input targets for read filters", () => {
		const result = analyze("cat package.json | grep -n name");
		expect(result.readPaths).toContain(resolved("package.json"));
	});

	it("treats an explicit outside read as review rather than safe", () => {
		const result = analyze("cat /etc/hosts");
		expect(result.complete).toBe(true);
		expect(result.disposition).toBe("review");
		expect(result.readPaths).toContain(resolved("/etc/hosts"));
	});

	it("treats a sensitive read as user", () => {
		const result = analyze("cat .env");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
	});

	it.each([
		["sort output", "sort -o out.txt package.json"],
		["sort long output", "sort --output=out.txt package.json"],
		["uniq output", "uniq in.txt out.txt"],
		["output redirect", "echo hello > out.txt"],
		["append redirect", "echo hello >> out.txt"],
		["find delete", "find . -name '*.tmp' -delete"],
		["find exec", "find . -name '*.tmp' -exec rm {} \\;"],
		["sed in place", "sed -i 's/a/b/' package.json"],
		["tee", "tee out.txt"],
		["xargs", "printf a | xargs rm"],
		["shell wrapper", "sh -c 'rm -rf /'"],
		["eval", "eval 'ls'"],
		["source", "source ./script.sh"],
		["exec", "exec ls"],
		["timeout wrapper", "timeout 5 ls"],
		["npm test", "npm test"],
		["npm install", "npm install"],
		["git config injection", "git -c core.pager=cat log"],
		["git external helper", "git --exec-path=/tmp log"],
		["PATH mutation", "PATH=/tmp:$PATH ls"],
		["IFS mutation", "export IFS=,"],
		["dynamic target", 'ls "$UNKNOWN_VAR"'],
	])("never treats %s as safe", (_label, command) => {
		expect(analyze(command).disposition).not.toBe("safe");
	});

	it("keeps sort -o write facts", () => {
		const result = analyze("sort -o out.txt package.json");
		expect(result.writePaths).toContain(resolved("out.txt"));
		expect(result.readPaths).toContain(resolved("package.json"));
	});

	it("allows harmless output to /dev/null", () => {
		expect(analyze("echo hello >/dev/null")).toMatchObject({ complete: true, disposition: "safe" });
	});
});

describe("destructive and protected writes", () => {
	it("denies filesystem root deletion", () => {
		const result = analyze("rm -rf /");
		expect(result.disposition).toBe("deny");
		expect(result.effects).toContain("destructive");
	});

	it("denies whole-home deletion", () => {
		const result = analyze("rm -rf ~");
		expect(result.disposition).toBe("deny");
		expect(result.effects).toContain("destructive");
	});

	it("denies a protected metadata write through redirection", () => {
		const result = analyze("echo hacked > .git/config");
		expect(result.disposition).toBe("deny");
	});

	it("denies a protected metadata deletion", () => {
		const result = analyze("rm -rf .git");
		expect(result.disposition).toBe("deny");
		expect(result.effects).toContain("destructive");
	});

	it("keeps a normal recursive delete as user with destructive effect", () => {
		const result = analyze("rm -rf dist");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("destructive");
		expect(result.writePaths).toContain(resolved("dist"));
	});

	it("does not trust a function that shadows a safe command", () => {
		const result = analyze("ls() { rm -rf /; }; ls");
		expect(result.disposition).toBe("deny");
	});
});

describe("curl network semantics", () => {
	it("keeps exact endpoints for a determinate HTTP read", () => {
		const result = analyze("curl --url https://api.example.com:8443/v1/items");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.networkEndpoints).toEqual([{ hostname: "api.example.com", port: 8443 }]);
	});

	it("defaults the port and accepts -q only as the first argument", () => {
		const result = analyze("curl -q https://example.com/path");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
		expect(result.networkEndpoints).toEqual([{ hostname: "example.com", port: 443 }]);
		expect(analyze("curl https://example.com -q").disposition).toBe("user");
	});

	it("collects every declared endpoint", () => {
		const result = analyze("curl https://one.example/a --url http://two.example:8080/b");
		expect(result.networkEndpoints).toEqual(
			expect.arrayContaining([
				{ hostname: "one.example", port: 443 },
				{ hostname: "two.example", port: 8080 },
			]),
		);
	});

	it.each([
		["json body", "curl --json '{}' https://example.com"],
		["data body", "curl -d a=1 https://example.com"],
		["upload", "curl -T file https://example.com"],
		["config file", "curl --config curlrc https://example.com"],
		["output file", "curl -o out.html https://example.com"],
		["proxy", "curl --proxy http://proxy:8080 https://example.com"],
		["insecure", "curl -k https://example.com"],
		["missing url", "curl"],
		["dynamic url", 'curl "$URL"'],
		["file scheme", "curl file:///etc/passwd"],
	])("does not approve %s", (_label, command) => {
		expect(analyze(command).disposition).toBe("user");
	});

	it("records the output file of a downloading curl as a write", () => {
		const result = analyze("curl -o out.html https://example.com");
		expect(result.writePaths).toContain(resolved("out.html"));
	});
});

describe("inline interpreters", () => {
	it("analyzes a quoted Python heredoc under an isolated interpreter startup", () => {
		const result = analyze("python3 -I -S <<'PY'\nimport json\nprint(json.dumps({'a': 1}))\nPY");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
	});

	it("analyzes a quoted Node heredoc", () => {
		const result = analyze("node - <<'JS'\nconst value = { a: [1, 2] };\nconsole.log(JSON.stringify(value));\nJS");
		expect(result).toMatchObject({ complete: true, disposition: "safe" });
	});

	it("rejects interpreter modes and expansion that hide the source", () => {
		expect(analyze("python3 -c 'print(1)'").disposition).toBe("user");
		expect(analyze("node -e 'console.log(1)'").disposition).toBe("user");
		expect(analyze("python3 - <<PY\nprint('$HOME')\nPY").disposition).toBe("user");
		expect(analyze("python3 - <<'PY'\nprint(1)\nPY").disposition).toBe("user");
		expect(analyze("python3 -S <<'PY'\nprint(1)\nPY").disposition).toBe("user");
		expect(analyze("python3 -I <<'PY'\nprint(1)\nPY").disposition).toBe("user");
		expect(analyze("node --require ./preload.js <<'JS'\nconsole.log(1)\nJS").disposition).toBe("user");
	});

	it("rejects unsafe Python inside a heredoc", () => {
		const result = analyze("python3 -I -S <<'PY'\nimport os\nos.system('rm -rf /')\nPY");
		expect(result).toEqual(expect.objectContaining({ disposition: "user" }));
		expect(result.disposition).not.toBe("safe");
	});
});

describe("safety boundaries", () => {
	it("never executes the analyzed command", () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-analysis-no-exec-"));
		const marker = join(directory, "marker");
		try {
			writeFileSync(marker, "present");
			analyze(`rm -f '${marker}' && echo '${marker}'`);
			expect(existsSync(marker)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("keeps nested inline scripts inside the shared total time budget", () => {
		const script = `value = ${"1+".repeat(100)}1\nprint(value)\n`;
		const command = Array.from({ length: 2 }, () => `python3 -I -S <<'PY'\n${script}PY`).join(" && ");
		const startedAt = Date.now();
		const result = analyze(command);
		const elapsed = Date.now() - startedAt;
		// Per-layer budgets would multiply the worst case by the number of
		// nested scripts; the shared absolute deadline keeps one budget.
		expect(elapsed).toBeLessThan(400);
		expect(result.disposition).not.toBe("deny");
	});

	it("rejects a command beyond the analysis source limit", () => {
		const command = `echo ${"a".repeat(32 * 1024)}`;
		const result = analyze(command);
		expect(result.disposition).toBe("user");
		expect(result.complete).toBe(false);
	});

	it("rejects syntax errors without trusting a prefix", () => {
		const result = analyze("pwd && if true; then");
		expect(result.disposition).toBe("user");
		expect(result.complete).toBe(false);
	});

	it("rejects shells the Bash grammar cannot represent", () => {
		expect(analyze("pwd", { shellPath: "/bin/sh" })).toMatchObject({ disposition: "user", complete: false });
	});

	it("rejects unknown executables as incomplete", () => {
		expect(analyze("some-unknown-command --read-only")).toMatchObject({
			disposition: "user",
			complete: false,
		});
	});

	it("does not let casing borrow a trusted command name", () => {
		expect(analyze("CAT package.json")).toMatchObject({ disposition: "user", complete: false });
		expect(analyze("Git status --short")).toMatchObject({ disposition: "user", complete: false });
	});

	it("adds elevation for privileged wrappers", () => {
		const result = analyze("sudo ls");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("elevation");
	});
});

describe("mergeShellDisposition", () => {
	it("uses deny > user > review > safe", () => {
		expect(mergeShellDisposition([])).toBe("safe");
		expect(mergeShellDisposition(["safe", "review"])).toBe("review");
		expect(mergeShellDisposition(["review", "user"])).toBe("user");
		expect(mergeShellDisposition(["user", "deny", "safe"])).toBe("deny");
	});
});
