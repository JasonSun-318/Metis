import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("publishes only the Metis CLI", () => {
	const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
		bin?: Record<string, string>;
	};
	expect(pkg.bin).toEqual({ metis: "dist/cli.js" });
});
