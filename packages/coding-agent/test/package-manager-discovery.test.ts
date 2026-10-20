import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectAncestorAgentsSkillDirs,
	collectAutoExtensionEntries,
	collectAutoPromptEntries,
	collectAutoSkillEntries,
	collectAutoThemeEntries,
	collectResourceFiles,
} from "../src/core/package-manager/resource-discovery.ts";

function writeFixture(path: string, content = ""): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

describe("package manager resource discovery", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pm-discovery-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("root extension manifest wins index and preserves valid declared order while skipping missing entries", () => {
		const root = join(tempDir, "manifest-root");
		const first = writeFixture(join(root, "first.ts"));
		const second = writeFixture(join(root, "second.ts"));
		writeFixture(join(root, "helper.ts"));
		writeFixture(join(root, "index.ts"));
		writeFixture(
			join(root, "package.json"),
			JSON.stringify({ metis: { extensions: ["./second.ts", "./missing.ts", "./first.ts"] } }),
		);

		expect(collectAutoExtensionEntries(root)).toEqual([second, first]);
		expect(collectResourceFiles(root, "extensions")).toEqual([second, first]);
	});

	it("falls back to index.ts then index.js when the manifest is missing, malformed or fully unresolved", () => {
		const missingManifest = join(tempDir, "missing-manifest");
		const indexTs = writeFixture(join(missingManifest, "index.ts"));
		writeFixture(join(missingManifest, "index.js"));
		writeFixture(join(missingManifest, "helper.ts"));

		const malformedManifest = join(tempDir, "malformed-manifest");
		writeFixture(join(malformedManifest, "package.json"), "{ not valid json");
		const indexJs = writeFixture(join(malformedManifest, "index.js"));
		writeFixture(join(malformedManifest, "helper.ts"));

		const unresolvedManifest = join(tempDir, "unresolved-manifest");
		writeFixture(join(unresolvedManifest, "package.json"), JSON.stringify({ metis: { extensions: ["./gone.ts"] } }));
		const unresolvedIndex = writeFixture(join(unresolvedManifest, "index.ts"));

		expect(collectAutoExtensionEntries(missingManifest)).toEqual([indexTs]);
		expect(collectAutoExtensionEntries(malformedManifest)).toEqual([indexJs]);
		expect(collectAutoExtensionEntries(unresolvedManifest)).toEqual([unresolvedIndex]);
	});

	it("root index suppresses unrelated helper modules and nested indexes", () => {
		const root = join(tempDir, "root-index");
		const index = writeFixture(join(root, "index.ts"));
		writeFixture(join(root, "helper.ts"));
		writeFixture(join(root, "nested", "index.ts"));
		writeFixture(join(root, "nested", "helper.ts"));

		expect(collectAutoExtensionEntries(root)).toEqual([index]);
	});

	it("nested extension discovery accepts top-level code and nested index/manifest entries only", () => {
		const root = join(tempDir, "nested-extensions");
		const topTs = writeFixture(join(root, "top.ts"));
		const topJs = writeFixture(join(root, "top.js"));
		writeFixture(join(root, "top.txt"));
		writeFixture(join(root, "ignored-root.ts"));
		writeFixture(join(root, ".gitignore"), "ignored-root.ts\nnested-ignored/\n");
		writeFixture(join(root, ".hidden", "hidden.ts"));
		writeFixture(join(root, "node_modules", "pkg", "index.ts"));
		writeFixture(join(root, "helper-only", "helper.ts"));
		const nestedIndex = writeFixture(join(root, "nested-index", "index.ts"));
		writeFixture(join(root, "nested-index", "ignored-helper.ts"));
		writeFixture(join(root, "nested-index", "sub", "index.ts"));
		const declared = writeFixture(join(root, "nested-manifest", "declared.ts"));
		writeFixture(
			join(root, "nested-manifest", "package.json"),
			JSON.stringify({ metis: { extensions: ["./declared.ts"] } }),
		);
		writeFixture(join(root, "nested-manifest", "other.ts"));
		writeFixture(join(root, "nested-ignored", "index.ts"));

		const entries = collectAutoExtensionEntries(root);

		expect(entries).toHaveLength(4);
		expect(entries).toEqual(expect.arrayContaining([topTs, topJs, nestedIndex, declared]));
		expect(entries).not.toContain(join(root, "helper-only", "helper.ts"));
		expect(entries).not.toContain(join(root, "nested-index", "ignored-helper.ts"));
		expect(entries).not.toContain(join(root, "nested-index", "sub", "index.ts"));
		expect(entries).not.toContain(join(root, "nested-manifest", "other.ts"));
		expect(entries).not.toContain(join(root, "ignored-root.ts"));
		expect(entries).not.toContain(join(root, "nested-ignored", "index.ts"));
	});

	it("distinguishes metis and agents skill modes, stops below SKILL.md and honors hidden/node_modules/ignore", () => {
		const root = join(tempDir, "skills");
		const loose = writeFixture(join(root, "loose.md"));
		writeFixture(join(root, "loose.txt"));
		const skill = writeFixture(join(root, "with-skill", "SKILL.md"));
		const nestedSkill = writeFixture(join(root, "with-skill", "deeper", "SKILL.md"));
		writeFixture(join(root, "helper", "nested.md"));
		writeFixture(join(root, ".hidden", "SKILL.md"));
		writeFixture(join(root, "node_modules", "pkg", "SKILL.md"));
		writeFixture(join(root, "ignored", "SKILL.md"));
		writeFixture(join(root, ".gitignore"), "ignored/\n");

		const metis = collectAutoSkillEntries(root, "metis");
		expect(metis).toHaveLength(2);
		expect(metis).toEqual(expect.arrayContaining([loose, skill]));
		expect(metis).not.toContain(nestedSkill);
		expect(metis).not.toContain(join(root, ".hidden", "SKILL.md"));
		expect(metis).not.toContain(join(root, "node_modules", "pkg", "SKILL.md"));
		expect(metis).not.toContain(join(root, "ignored", "SKILL.md"));
		expect(collectResourceFiles(root, "skills")).toEqual(metis);

		const agents = collectAutoSkillEntries(root, "agents");
		expect(agents).toEqual([skill]);
	});

	it("applies root and nested ignore rules with directory prefixes", () => {
		const root = join(tempDir, "ignore-rules");
		const keep = writeFixture(join(root, "keep.md"));
		const rootLocalSkip = writeFixture(join(root, "local-skip.md"));
		writeFixture(join(root, "ignored.md"));
		writeFixture(join(root, ".gitignore"), "ignored.md\nnested/drop.md\n");
		const nestedKeep = writeFixture(join(root, "nested", "keep.md"));
		writeFixture(join(root, "nested", "drop.md"));
		writeFixture(join(root, "nested", "local-skip.md"));
		writeFixture(join(root, "nested", ".gitignore"), "local-skip.md\n");

		const entries = collectResourceFiles(root, "prompts");

		expect(entries).toHaveLength(3);
		expect(entries).toEqual(expect.arrayContaining([keep, rootLocalSkip, nestedKeep]));
		expect(entries).not.toContain(join(root, "ignored.md"));
		expect(entries).not.toContain(join(root, "nested", "drop.md"));
		expect(entries).not.toContain(join(root, "nested", "local-skip.md"));
	});

	it("skips broken symlinks and traverses valid file and directory symlinks", () => {
		const root = join(tempDir, "symlinks");
		const linkedTarget = join(tempDir, "linked-target");
		const keep = writeFixture(join(root, "keep.md"));
		const alias = join(root, "alias.md");
		symlinkSync(keep, alias);
		const broken = join(root, "broken.md");
		symlinkSync(join(root, "does-not-exist.md"), broken);
		const linkedDir = join(root, "linked-dir");
		symlinkSync(linkedTarget, linkedDir, process.platform === "win32" ? "dir" : undefined);
		writeFixture(join(linkedTarget, "from-link.md"));
		const linkedFile = join(linkedDir, "from-link.md");

		const entries = collectResourceFiles(root, "prompts");

		expect(entries).toHaveLength(3);
		expect(entries).toEqual(expect.arrayContaining([keep, alias, linkedFile]));
		expect(entries).not.toContain(broken);
	});

	it("auto prompts/themes are flat-only while packaged prompts/themes are recursive with matching extensions", () => {
		const prompts = join(tempDir, "prompts");
		const prompt = writeFixture(join(prompts, "root.md"));
		writeFixture(join(prompts, "root.txt"));
		writeFixture(join(prompts, ".hidden.md"));
		writeFixture(join(prompts, "node_modules", "pkg", "hidden.md"));
		const nestedPrompt = writeFixture(join(prompts, "nested", "child.md"));
		writeFixture(join(prompts, "nested", "skip.md"));
		writeFixture(join(prompts, "ignored.md"));
		writeFixture(join(prompts, ".gitignore"), "ignored.md\nnested/skip.md\n");

		const themes = join(tempDir, "themes");
		const theme = writeFixture(join(themes, "root.json"));
		writeFixture(join(themes, "root.md"));
		const nestedTheme = writeFixture(join(themes, "nested", "child.json"));
		writeFixture(join(themes, "ignored.json"));
		writeFixture(join(themes, ".gitignore"), "ignored.json\n");

		expect(collectAutoPromptEntries(prompts)).toEqual([prompt]);
		const packagedPrompts = collectResourceFiles(prompts, "prompts");
		expect(packagedPrompts).toHaveLength(2);
		expect(packagedPrompts).toEqual(expect.arrayContaining([prompt, nestedPrompt]));

		expect(collectAutoThemeEntries(themes)).toEqual([theme]);
		const packagedThemes = collectResourceFiles(themes, "themes");
		expect(packagedThemes).toHaveLength(2);
		expect(packagedThemes).toEqual(expect.arrayContaining([theme, nestedTheme]));
	});

	it("handles broken links in smart extensions, skills and flat file discovery without losing valid linked entries", () => {
		const extensions = join(tempDir, "extensions");
		const extension = writeFixture(join(extensions, "real.ts"));
		const alias = join(extensions, "alias.ts");
		symlinkSync(extension, alias);
		symlinkSync(join(tempDir, "missing.ts"), join(extensions, "broken.ts"));
		const externalExtension = join(tempDir, "external-extension");
		writeFixture(join(externalExtension, "index.ts"));
		writeFixture(join(externalExtension, "helper.ts"));
		const linkedExtension = join(extensions, "linked-extension");
		symlinkSync(externalExtension, linkedExtension, process.platform === "win32" ? "dir" : undefined);
		expect(collectAutoExtensionEntries(extensions)).toEqual(
			expect.arrayContaining([extension, alias, join(linkedExtension, "index.ts")]),
		);
		expect(collectAutoExtensionEntries(extensions)).toHaveLength(3);

		const skills = join(tempDir, "skills");
		mkdirSync(skills);
		symlinkSync(join(tempDir, "missing-skill.md"), join(skills, "SKILL.md"));
		const externalSkill = join(tempDir, "external-skill");
		writeFixture(join(externalSkill, "SKILL.md"));
		const linkedSkill = join(skills, "linked-skill");
		symlinkSync(externalSkill, linkedSkill, process.platform === "win32" ? "dir" : undefined);
		for (const mode of ["metis", "agents"] as const) {
			expect(collectAutoSkillEntries(skills, mode)).toEqual([join(linkedSkill, "SKILL.md")]);
		}

		const prompts = join(tempDir, "prompts");
		const prompt = writeFixture(join(prompts, "real.md"));
		const promptAlias = join(prompts, "alias.md");
		symlinkSync(prompt, promptAlias);
		symlinkSync(join(tempDir, "missing-prompt.md"), join(prompts, "broken.md"));
		const entries = collectAutoPromptEntries(prompts);
		expect(entries).toEqual(expect.arrayContaining([prompt, promptAlias]));
		expect(entries).toHaveLength(2);
	});

	it("lists ancestor .agents/skills directories nearest-first and stops at the nearest .git directory", () => {
		const repo = join(tempDir, "repo");
		const start = join(repo, "packages", "pkg", "src");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(start, { recursive: true });

		expect(collectAncestorAgentsSkillDirs(start)).toEqual([
			join(start, ".agents", "skills"),
			join(repo, "packages", "pkg", ".agents", "skills"),
			join(repo, "packages", ".agents", "skills"),
			join(repo, ".agents", "skills"),
		]);
	});

	it("accepts a .git worktree file and stops at that nearest marker rather than an outer repository", () => {
		const outer = join(tempDir, "outer");
		const inner = join(outer, "inner");
		const start = join(inner, "pkg", "src");
		mkdirSync(join(outer, ".git"), { recursive: true });
		writeFixture(join(inner, ".git"), "gitdir: /tmp/fake-worktree\n");
		mkdirSync(start, { recursive: true });

		expect(collectAncestorAgentsSkillDirs(start)).toEqual([
			join(start, ".agents", "skills"),
			join(inner, "pkg", ".agents", "skills"),
			join(inner, ".agents", "skills"),
		]);
	});

	it("returns empty results for every discovery entry point when the directory is missing", () => {
		const missing = join(tempDir, "missing");
		const resourceTypes = ["extensions", "skills", "prompts", "themes"] as const;

		for (const resourceType of resourceTypes) {
			expect(collectResourceFiles(missing, resourceType)).toEqual([]);
		}
		expect(collectAutoExtensionEntries(missing)).toEqual([]);
		expect(collectAutoSkillEntries(missing, "metis")).toEqual([]);
		expect(collectAutoSkillEntries(missing, "agents")).toEqual([]);
		expect(collectAutoPromptEntries(missing)).toEqual([]);
		expect(collectAutoThemeEntries(missing)).toEqual([]);
	});
});
