import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeShellCommand } from "../../src/core/permissions/shell-analysis.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";

let home: string;
let desktop: string;
let support: string;

beforeAll(initializeShellAnalysis);
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "metis-shell-filesystem-"));
	desktop = join(home, "Desktop");
	support = join(home, "Library", "Application Support");
	for (const path of [
		desktop,
		join(support, "ClashX"),
		join(support, "clash-next"),
		join(support, "Google", "Chrome"),
		join(home, ".ssh"),
	]) {
		mkdirSync(path, { recursive: true });
	}
	writeFileSync(join(home, ".ssh", "id_rsa"), "fixture secret");
	writeFileSync(join(support, "Google", "Chrome", "Cookies"), "fixture browser data");
	vi.stubEnv("HOME", home);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function analyze(command: string) {
	return analyzeShellCommand({ command, cwd: desktop, workspaceRoots: [desktop], shellPath: "/bin/bash" });
}

function physical(path: string): string {
	return canonicalizeActionPath(path, desktop);
}

describe("disk usage reads", () => {
	it("analyzes the reported compound inventory without introducing write scope", () => {
		mkdirSync(join(desktop, "reports"));
		writeFileSync(join(desktop, "reports", "note.txt"), "hello");
		const result = analyze('cd ~/Desktop && du -sh */ 2>/dev/null; echo "---"; du -sh . 2>/dev/null');
		expect(result).toMatchObject({ disposition: "safe", complete: true, writePaths: [], effects: [] });
		expect(result.readPaths).toEqual([physical(desktop)]);
	});

	it.each([
		"du -sh .",
		"du -ak .",
		"du -d1 .",
		"du -d 1 .",
		"du --apparent-size --max-depth=1 .",
		"du --block-size=1K --exclude='*.log' .",
	])("supports bounded BSD/GNU options: %s", (command) => {
		expect(analyze(command)).toMatchObject({ disposition: "safe", complete: true, writePaths: [] });
	});

	it.each(["du --files0-from=list", "du -L .", "du -H .", "du --exclude-from=list", "du --unknown ."])(
		"does not silently authorize unsupported input or traversal: %s",
		(command) => {
			expect(analyze(command)).toMatchObject({ disposition: "user", complete: false });
		},
	);

	it.each(["du -d1 .env", "head -n5 .env", "tail -c10 .env", "cut -f1 .env"])(
		"does not skip a sensitive operand after an attached short option: %s",
		(command) => {
			writeFileSync(join(desktop, ".env"), "fixture secret");
			const result = analyze(command);
			expect(result.disposition).toBe("user");
			expect(result.effects).toContain("sensitive-read");
			expect(result.readPaths).toContain(physical(join(desktop, ".env")));
		},
	);
});

describe("glob read scope", () => {
	it("keeps the reported Clash patterns eligible for review despite sensitive siblings", () => {
		const result = analyze(
			"ls -la ~/Library/Application\\ Support/ClashX* 2>/dev/null | head -5; ls -d ~/Library/Application\\ Support/*lash* 2>/dev/null; ls -d /Applications/ClashX* /Applications/Clash* 2>/dev/null",
		);
		expect(result).toMatchObject({ disposition: "review", complete: true, writePaths: [], effects: [] });
		expect(result.readPaths).toContain(physical(support));
	});

	it("does not attribute an unmatched sensitive workspace sibling to a narrow glob", () => {
		writeFileSync(join(desktop, ".env"), "fixture secret");
		writeFileSync(join(desktop, "report.txt"), "hello");
		expect(analyze("cat report* | head -5")).toMatchObject({ disposition: "safe", complete: true, effects: [] });
	});

	it.each(["cat ~/.ssh/id_*", "cat .env*", "cat creden*"])(
		"still identifies matching sensitive paths: %s",
		(command) => {
			writeFileSync(join(desktop, ".env.local"), "fixture secret");
			writeFileSync(join(desktop, "credentials.json"), "fixture secret");
			const result = analyze(command);
			expect(result.disposition).toBe("user");
			expect(result.effects).toContain("sensitive-read");
		},
	);

	it.runIf(process.platform === "darwin")("keeps actual browser-data matches sensitive", () => {
		const result = analyze("ls -R ~/Library/Application\\ Support/G*");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
	});

	it("checks matched symlinks against their physical sensitive destination", () => {
		symlinkSync(join(home, ".ssh"), join(support, "ClashSecrets"));
		const result = analyze("ls -la ~/Library/Application\\ Support/Clash*");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
		expect(result.readPaths).toContain(physical(join(home, ".ssh")));
	});

	it("includes physical scope for a matched ordinary symlink", () => {
		const destination = join(home, "reports");
		mkdirSync(destination);
		symlinkSync(destination, join(support, "ClashReports"));
		const result = analyze("ls -d ~/Library/Application\\ Support/Clash*");
		expect(result).toMatchObject({ disposition: "review", complete: true, effects: [] });
		expect(result.readPaths).toContain(physical(destination));
	});

	it("does not inherit workspace authorization through a globbed symlink", () => {
		const destination = join(home, "reports");
		mkdirSync(destination);
		symlinkSync(destination, join(desktop, "report-link"));
		const result = analyze("ls -d report*");
		expect(result).toMatchObject({ disposition: "review", complete: true, effects: [] });
		expect(result.readPaths).toContain(physical(destination));
	});

	it("keeps unresolved multi-level globs incomplete", () => {
		expect(analyze("cat */*/notes.txt")).toMatchObject({ disposition: "user", complete: false });
	});

	it("includes the parent directory matched by a Bash dot-glob", () => {
		const result = analyze("du -sh .*");
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
		expect(result.readPaths).toContain(physical(home));
	});
});

describe("finite literal loops", () => {
	it("analyzes the reported read-only directory counting pipeline", () => {
		const result = analyze(
			'for d in Claude-Desktop-Shell-Spec claude-permission-review; do echo "$d $(find "$d" -type f -not -name .DS_Store | wc -l | tr -d " ")"; done',
		);
		expect(result).toMatchObject({ disposition: "safe", complete: true, writePaths: [], effects: [] });
		expect(result.readPaths).toEqual([
			physical(join(desktop, "Claude-Desktop-Shell-Spec")),
			physical(join(desktop, "claude-permission-review")),
		]);
	});

	it("does not reuse a stale value for a loop variable", () => {
		const result = analyze('f=report.txt; for f in .env; do cat "$f"; done');
		expect(result.disposition).toBe("user");
		expect(result.effects).toContain("sensitive-read");
	});

	it.each([
		'f=report.txt; for f in "$UNKNOWN"; do cat "$f"; done',
		'f=report.txt; for f; do cat "$f"; done',
		"for f in 'report.txt .env'; do cat $f; done",
		"for PATH in /tmp; do ls; done",
	])("keeps unresolved lists and command resolution changes incomplete: %s", (command) => {
		expect(analyze(command)).toMatchObject({ disposition: "user", complete: false });
	});
});
