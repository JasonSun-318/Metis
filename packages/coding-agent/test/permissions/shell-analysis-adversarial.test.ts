import { beforeAll, describe, expect, it } from "vitest";
import { analyzeShellCommand } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";

beforeAll(initializeShellAnalysis);

const analyze = (command: string) =>
	analyzeShellCommand({
		command,
		cwd: process.cwd(),
		workspaceRoots: [process.cwd()],
		shellPath: "/bin/bash",
	});

describe("independent adversarial command acceptance", () => {
	it.each([
		"git status --short && rm -rf ./dist",
		"printf '%s' \"$(rm -rf ./dist)\"",
		"rg --pre=./helper pattern src",
		"rg --hostname-bin ./helper --hyperlink-format default pattern src",
		"sort --compress-program=./helper README.md",
		"uniq README.md output.txt",
		"git diff --ext-diff",
		"git show --textconv HEAD",
		"git diff --output=output.txt",
		"PATH=./tools:$PATH git status",
		"printf -v PATH '%s' ./tools; cat README.md",
		"python3 <<'PY'\nprint('literal')\nPY",
		"python3 -S <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY",
		"python3 -I -S <<'PY'\nfrom pathlib import Path\nPath('output.txt').open('w')\nPY",
		"python3 -I -S <<'PY'\nfrom pathlib import Path\nPath('output.txt').open(mode='w')\nPY",
		"node --require ./preload.js <<'JS'\nconsole.log('literal');\nJS",
		"python3 -I <<'PY'\nprint('literal')\nPY",
		"python3 -I -S <<'PY'\nopen('output.txt', mode='a')\nPY",
		"python3 -I -S <<'PY'\nopen('output.txt', 'w')\nPY",
		"CAT README.md",
	])("does not automatically approve hidden behavior: %s", (command) => {
		expect(analyze(command).disposition).not.toBe("safe");
	});

	it.each([
		"NODE_OPTIONS='--require ./preload.js' node <<'JS'\nconsole.log('literal');\nJS",
		"NODE_OPTIONS=--import=./preload.js node <<'JS'\nconsole.log('literal');\nJS",
		"PATH=./tools rg --files src",
		"HOME=/tmp/other git status --short",
		"CURL_HOME=/tmp/other curl -q https://example.com",
		"git -c alias.status '!ls' status",
		"git --exec-path=./tools status",
		"git --exec-path=./tools status --short",
		"GIT_CONFIG_PARAMETERS=\"'core.fsmonitor=/tmp/never'\" git status",
		"GIT_CONFIG_COUNT=1 git status",
		"GIT_EXTERNAL_DIFF=./helper.sh git diff HEAD",
		"git config diff.probe.textconv /tmp/never-called && git diff",
	])("does not reuse scope when environment changes the executed program: %s", (command) => {
		expect(analyze(command)).toMatchObject({ disposition: "user", complete: false });
	});
	it("requires an isolated Python startup before proving inline standard-library code", () => {
		expect(analyze("python3 -I -S <<'PY'\nimport json\nprint(json.dumps({'ok': True}))\nPY")).toMatchObject({
			complete: true,
			disposition: "safe",
			effects: [],
		});
	});

	it("keeps complete source and validates a long supported safe program", () => {
		const command = Array.from({ length: 60 }, () => "rg --files src | head -n 1").join(" &&\n");
		expect(Buffer.byteLength(command)).toBeGreaterThan(256);
		expect(analyze(command)).toMatchObject({ complete: true, disposition: "safe", effects: [] });
	});
});
