import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/resource-loader.ts";
import type { SourceInfo } from "../src/core/source-info.ts";
import {
	buildScopeGroups,
	findSourceInfoForPath,
	formatDiagnostics,
	formatScopeGroups,
	getDisplaySourceInfo,
	getScopeGroup,
} from "../src/modes/interactive/interactive-resource-display.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function sourceInfo(source: string, scope: SourceInfo["scope"], baseDir?: string): SourceInfo {
	return {
		path: "/virtual/source",
		source,
		scope,
		origin: "top-level",
		...(baseDir === undefined ? {} : { baseDir }),
	};
}

describe("interactive resource display", () => {
	it("labels local, cli and package sources by scope", () => {
		expect(getDisplaySourceInfo(undefined)).toEqual({ label: "project", color: "muted" });
		expect(getDisplaySourceInfo(sourceInfo("local", "user"))).toEqual({ label: "user", color: "muted" });
		expect(getDisplaySourceInfo(sourceInfo("local", "temporary"))).toEqual({
			label: "path",
			scopeLabel: "temp",
			color: "muted",
		});
		expect(getDisplaySourceInfo(sourceInfo("cli", "temporary"))).toEqual({
			label: "path",
			scopeLabel: "temp",
			color: "muted",
		});
		expect(getDisplaySourceInfo(sourceInfo("npm:example", "user"))).toEqual({
			label: "npm:example",
			scopeLabel: "user",
			color: "accent",
		});
	});

	it("groups resources into project, user and path scopes", () => {
		expect(getScopeGroup(undefined)).toBe("project");
		expect(getScopeGroup(sourceInfo("local", "user"))).toBe("user");
		expect(getScopeGroup(sourceInfo("cli", "project"))).toBe("path");
		expect(getScopeGroup(sourceInfo("local", "temporary"))).toBe("path");

		const groups = buildScopeGroups([
			{ path: "/project/skill" },
			{ path: "/home/me/skill", sourceInfo: sourceInfo("local", "user") },
			{ path: "/tmp/skill", sourceInfo: sourceInfo("local", "temporary") },
			{ path: "/pkg/a", sourceInfo: sourceInfo("npm:pkg", "project", "/pkg") },
		]);
		expect(groups.map((group) => group.scope)).toEqual(["project", "user", "path"]);
		expect(groups[0]?.paths.map((item) => item.path)).toEqual(["/project/skill"]);
		expect(groups[0]?.packages.get("npm:pkg")?.[0]?.path).toBe("/pkg/a");
	});

	it("formats scope groups with sorted paths and package sections", () => {
		initTheme("dark");
		const groups = buildScopeGroups([
			{ path: "/project/b" },
			{ path: "/project/a" },
			{ path: "/pkg/z", sourceInfo: sourceInfo("npm:pkg", "project", "/pkg") },
		]);
		const text = formatScopeGroups(groups, {
			formatPath: (item) => item.path,
			formatPackagePath: (item, source) => `${source}:${item.path}`,
		});
		expect(text.indexOf("/project/a")).toBeLessThan(text.indexOf("/project/b"));
		expect(text).toContain("npm:pkg");
		expect(text).toContain("npm:pkg:/pkg/z");
	});

	it("finds the nearest source info for a nested path", () => {
		const map = new Map<string, SourceInfo>([
			["/root", sourceInfo("local", "user")],
			["/root/pkg", sourceInfo("npm:pkg", "project")],
		]);
		expect(findSourceInfoForPath("/root/pkg/file.ts", map)).toBe(map.get("/root/pkg"));
		expect(findSourceInfoForPath("/root/other/file.ts", map)).toBe(map.get("/root"));
		expect(findSourceInfoForPath("/elsewhere/file.ts", map)).toBeUndefined();
	});

	it("formats collision diagnostics with winner and skipped loser", () => {
		initTheme("dark");
		const sourceInfos = new Map<string, SourceInfo>();
		const diagnostics = [
			{
				type: "collision" as const,
				message: "collision",
				collision: { name: "skill", winnerPath: "/a/skill", loserPath: "/b/skill" },
			},
			{ type: "warning" as const, message: "plain warning", path: "/c/skill.ts" },
		];
		const text = formatDiagnostics(diagnostics as unknown as ResourceDiagnostic[], sourceInfos, {
			getShortPath: (path) => path,
			formatDisplayPath: (path) => path,
		});
		expect(text).toContain('"skill" collision');
		expect(text).toContain("/a/skill");
		expect(text).toContain("/b/skill (skipped)");
		expect(text).toContain("plain warning");
	});
});
