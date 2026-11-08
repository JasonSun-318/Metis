import { describe, expect, it } from "vitest";
import {
	buildNoMatchingPackageMessage,
	findSuggestedConfiguredSource,
	getSourceMatchKeyForInput,
	getSourceMatchKeyForSettings,
	normalizePackageSourceForSettings,
	packageSourcesMatch,
	parseNpmSpec,
	parseSource,
	type SourcePathHelpers,
} from "../src/core/package-manager/source-syntax.ts";

const helpers: SourcePathHelpers = {
	resolvePath: (input) => `/resolved${input.startsWith("/") ? "" : "/"}${input}`,
	resolvePathFromBase: (input, baseDir) => `${baseDir}/${input.replace(/^\.\//, "")}`,
	getBaseDirForScope: (scope) => (scope === "user" ? "/home/user" : "/project"),
};

describe("package source syntax", () => {
	it("parses npm specs with scopes and versions", () => {
		expect(parseNpmSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
		expect(parseNpmSpec("pkg")).toEqual({ name: "pkg", version: undefined });
		expect(parseNpmSpec("pkg@^2")).toEqual({ name: "pkg", version: "^2" });
	});

	it("classifies npm, local and git sources", () => {
		expect(parseSource("npm:pkg@1.0.0")).toMatchObject({ type: "npm", name: "pkg", version: "1.0.0", pinned: true });
		expect(parseSource("./local")).toEqual({ type: "local", path: "./local" });
		expect(parseSource("/abs/local")).toEqual({ type: "local", path: "/abs/local" });
		expect(parseSource("git:github.com/a/b")).toMatchObject({ type: "git" });
	});

	it("builds stable match keys per source kind", () => {
		expect(getSourceMatchKeyForInput("npm:pkg@1.0.0", helpers)).toBe("npm:pkg");
		expect(getSourceMatchKeyForInput("./local", helpers)).toBe("local:/resolved/./local");
		expect(getSourceMatchKeyForSettings("npm:pkg@2", "user", helpers)).toBe("npm:pkg");
		expect(getSourceMatchKeyForSettings("./local", "project", helpers)).toBe("local:/project/local");
		expect(getSourceMatchKeyForSettings("./local", "user", helpers)).toBe("local:/home/user/local");
	});

	it("normalizes local sources relative to the scope base dir", () => {
		expect(normalizePackageSourceForSettings("npm:pkg", "project", helpers)).toBe("npm:pkg");
		expect(normalizePackageSourceForSettings("./local", "project", helpers)).toBe("../resolved/local");
	});

	it("matches configured sources through their normalized keys", () => {
		expect(packageSourcesMatch("npm:pkg@1.0.0", "npm:pkg@2.0.0", "user", helpers)).toBe(true);
		expect(packageSourcesMatch("npm:pkg", "npm:other", "user", helpers)).toBe(false);
	});

	it("suggests a configured source for unmatched input", () => {
		const configured = ["npm:worker", "git:github.com/acme/tools"];
		expect(findSuggestedConfiguredSource("worker", configured)).toBe("npm:worker");
		expect(buildNoMatchingPackageMessage("worker", configured)).toBe(
			"No matching package found for worker. Did you mean npm:worker?",
		);
		expect(buildNoMatchingPackageMessage("unknown", [])).toBe("No matching package found for unknown");
	});
});
