import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyAutoloadDisabledPatterns,
	applyPatterns,
	hasGlobPattern,
	isEnabledByOverrides,
	isOverridePattern,
	splitPatterns,
	toPosixPath,
} from "../src/core/package-manager/resource-patterns.ts";

const baseDir = resolve("package-manager-pattern-fixtures");

function fixture(...parts: string[]): string {
	return join(baseDir, ...parts);
}

describe("package manager resource patterns", () => {
	it("toPosixPath converts only the current platform separator", () => {
		const nativePath = join("root", "nested", "file.ts");
		expect(toPosixPath(nativePath)).toBe("root/nested/file.ts");

		const backslashPath = "root\\nested\\file.ts";
		expect(toPosixPath(backslashPath)).toBe(sep === "\\" ? "root/nested/file.ts" : backslashPath);
	});

	it("splitPatterns separates plain paths from override and glob patterns in order", () => {
		expect(splitPatterns([])).toEqual({ plain: [], patterns: [] });
		expect(splitPatterns(["a.ts", "!b.ts", "+c.ts", "-d.ts", "*.ts", "foo?.ts", "dir/file.ts"])).toEqual({
			plain: ["a.ts", "dir/file.ts"],
			patterns: ["!b.ts", "+c.ts", "-d.ts", "*.ts", "foo?.ts"],
		});
	});

	it("classifies override prefixes and glob characters without treating other syntax as globs", () => {
		expect(["!a", "+a", "-a"].map(isOverridePattern)).toEqual([true, true, true]);
		expect(["a", "*.ts", "foo?.ts"].map(isOverridePattern)).toEqual([false, false, false]);

		expect(["*.ts", "foo?.ts", "dir/*.ts"].map(hasGlobPattern)).toEqual([true, true, true]);
		expect(["plain.ts", "[abc].ts"].map(hasGlobPattern)).toEqual([false, false]);
	});

	it("applyPatterns defaults to every input when no include pattern is present", () => {
		const a = fixture("a.ts");
		const b = fixture("b.ts");
		const c = fixture("c.ts");
		const all = [a, b, c];

		expect([...applyPatterns(all, [], baseDir)]).toEqual(all);
		expect([...applyPatterns(all, ["!b.ts"], baseDir)]).toEqual([a, c]);
		expect([...applyPatterns(all, ["-b.ts"], baseDir)]).toEqual([a, c]);
		expect([...applyPatterns(all, ["+b.ts"], baseDir)]).toEqual(all);
	});

	it("applyPatterns applies includes before excludes", () => {
		const a = fixture("a.ts");
		const b = fixture("b.ts");
		const c = fixture("c.json");

		expect([...applyPatterns([a, b, c], ["*.ts", "!b.ts"], baseDir)]).toEqual([a]);
		expect([...applyPatterns([a, b, c], ["a.ts", "*.ts", "!b.ts"], baseDir)]).toEqual([a]);
	});

	it("applyPatterns force-includes exact paths independently of declaration order", () => {
		const a = fixture("a.ts");
		const b = fixture("b.ts");

		expect([...applyPatterns([a, b], ["!**", "+a.ts"], baseDir)]).toEqual([a]);
		expect([...applyPatterns([a, b], ["+a.ts", "!**"], baseDir)]).toEqual([a]);
	});

	it("applyPatterns force-excludes exact paths independently of declaration order", () => {
		const a = fixture("a.ts");
		const b = fixture("b.ts");

		expect([...applyPatterns([a, b], ["+a.ts", "-a.ts"], baseDir)]).toEqual([b]);
		expect([...applyPatterns([a, b], ["-a.ts", "+a.ts"], baseDir)]).toEqual([b]);
		expect([...applyPatterns([a, b], ["!**", "+a.ts", "-a.ts"], baseDir)]).toEqual([]);
	});

	it("applyPatterns keeps retained order, appends force-included inputs in source order and dedupes via Set", () => {
		const a = fixture("a.ts");
		const b = fixture("b.ts");
		const c = fixture("c.ts");
		const d = fixture("d.ts");

		expect([...applyPatterns([a, b, c, d], ["a.ts", "!b.ts", "+d.ts", "+b.ts"], baseDir)]).toEqual([a, b, d]);
		expect([...applyPatterns([a, a, b], ["*.ts", "!b.ts", "+b.ts"], baseDir)]).toEqual([a, b]);
		expect([...applyPatterns([a, a], [], baseDir)]).toEqual([a]);
	});

	it("exact patterns do not match unrelated siblings by basename but support ./ and absolute paths", () => {
		const target = fixture("extensions", "target.ts");
		const sameBasename = fixture("nested", "target.ts");

		expect([...applyPatterns([target, sameBasename], ["!**", "+target.ts"], baseDir)]).toEqual([]);
		expect([...applyPatterns([target, sameBasename], ["!**", "+extensions/target.ts"], baseDir)]).toEqual([target]);
		expect([...applyPatterns([target, sameBasename], ["!**", "+./extensions/target.ts"], baseDir)]).toEqual([target]);
		expect([...applyPatterns([target, sameBasename], ["!**", `+${target}`], baseDir)]).toEqual([target]);
	});

	it("exact SKILL.md parent matches include relative, ./ and absolute parents but not a same-named sibling", () => {
		const skill = fixture("skills", "demo", "SKILL.md");
		const nestedSkill = fixture("nested", "demo", "SKILL.md");

		expect([...applyPatterns([skill, nestedSkill], ["!**", "+skills/demo"], baseDir)]).toEqual([skill]);
		expect([...applyPatterns([skill, nestedSkill], ["!**", "+./skills/demo"], baseDir)]).toEqual([skill]);
		expect([...applyPatterns([skill, nestedSkill], ["!**", `+${fixture("skills", "demo")}`], baseDir)]).toEqual([
			skill,
		]);
		expect([...applyPatterns([skill, nestedSkill], ["!**", `+${skill}`], baseDir)]).toEqual([skill]);
		expect([...applyPatterns([skill, nestedSkill], ["*", "-skills/demo"], baseDir)]).toEqual([nestedSkill]);
	});

	it("isEnabledByOverrides ignores plain/glob entries and applies ! then + then -", () => {
		const keep = fixture("extensions", "keep.ts");

		expect(isEnabledByOverrides(keep, [], baseDir)).toBe(true);
		expect(isEnabledByOverrides(keep, ["extensions/keep.ts", "**/*.ts"], baseDir)).toBe(true);
		expect(isEnabledByOverrides(keep, ["missing.ts", "**/*.json"], baseDir)).toBe(true);
		expect(isEnabledByOverrides(keep, ["!extensions/keep.ts"], baseDir)).toBe(false);
		expect(isEnabledByOverrides(keep, ["!**/*.ts"], baseDir)).toBe(false);
		expect(isEnabledByOverrides(keep, ["+extensions/keep.ts", "!extensions/keep.ts"], baseDir)).toBe(true);
		expect(isEnabledByOverrides(keep, ["+extensions/keep.ts", "-extensions/keep.ts"], baseDir)).toBe(false);
		expect(isEnabledByOverrides(keep, ["-extensions/keep.ts", "+extensions/keep.ts"], baseDir)).toBe(false);
	});

	it("applyAutoloadDisabledPatterns returns an empty map with no patterns and only touches matched resources", () => {
		const a = fixture("extensions", "a.ts");
		const b = fixture("extensions", "b.ts");

		expect(applyAutoloadDisabledPatterns([a, b], [], baseDir)).toEqual(new Map());
		expect(applyAutoloadDisabledPatterns([a, b], ["+extensions/a.ts"], baseDir)).toEqual(new Map([[a, true]]));
		expect(applyAutoloadDisabledPatterns([a, b], ["-extensions/a.ts"], baseDir)).toEqual(new Map([[a, false]]));
		expect(applyAutoloadDisabledPatterns([a, b], ["+extensions/a.ts", "-extensions/a.ts"], baseDir)).toEqual(
			new Map([[a, false]]),
		);
		expect(applyAutoloadDisabledPatterns([a, b], ["-extensions/a.ts", "+extensions/a.ts"], baseDir)).toEqual(
			new Map([[a, true]]),
		);
		expect(applyAutoloadDisabledPatterns([a, b], [`+${a}`], baseDir)).toEqual(new Map([[a, true]]));
	});

	it("applyAutoloadDisabledPatterns uses globs for plain/! entries and exact matching only for +/-", () => {
		const a = fixture("extensions", "a.ts");
		const b = fixture("extensions", "b.ts");

		expect([...applyAutoloadDisabledPatterns([a, b], ["extensions/*.ts"], baseDir)]).toEqual([
			[a, true],
			[b, true],
		]);
		expect([...applyAutoloadDisabledPatterns([a, b], ["extensions/*.ts", "-extensions/a.ts"], baseDir)]).toEqual([
			[a, false],
			[b, true],
		]);
		expect([...applyAutoloadDisabledPatterns([a, b], ["!extensions/*.ts"], baseDir)]).toEqual([
			[a, false],
			[b, false],
		]);
		expect(applyAutoloadDisabledPatterns([a, b], ["-extensions/*.ts"], baseDir).size).toBe(0);
		expect(applyAutoloadDisabledPatterns([a, b], ["+extensions/*.ts"], baseDir).size).toBe(0);
	});
});
