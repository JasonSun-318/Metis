import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const boundaryScript = fileURLToPath(new URL("../check-architecture-boundaries.mjs", import.meta.url));
const importScript = fileURLToPath(new URL("../check-ts-relative-imports.mjs", import.meta.url));

function check(t, script, file, source) {
	const root = mkdtempSync(join(tmpdir(), "metis-architecture-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const pkg of ["ai", "agent", "tui", "app-protocol", "coding-agent", "app-server", "desktop"]) {
		mkdirSync(join(root, "packages", pkg, "src"), { recursive: true });
		mkdirSync(join(root, "packages", pkg, "test"));
		if (pkg === "desktop") mkdirSync(join(root, "packages", pkg, "e2e"));
		writeFileSync(
			join(root, "packages", pkg, "package.json"),
			JSON.stringify({
				name: `@metis/${pkg === "agent" ? "agent-core" : pkg}`,
				exports:
					pkg === "ai"
						? { ".": "./dist/index.js", "./compat": "./dist/compat.js", "./providers/*": "./dist/providers/*.js" }
						: pkg === "coding-agent"
							? { ".": "./dist/index.js", "./host": "./dist/host.js" }
							: { ".": "./dist/index.js" },
			}),
		);
	}
	const target = join(root, file);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, source);
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

const forbiddenImports = [
	["packages/agent/src/example.ts", 'import type { Model } from "@metis/ai/src/types";'],
	["packages/agent/src/example.mts", 'import { server } from "@metis/app-server";'],
	["packages/agent/src/example.cts", 'export { server } from "@metis/app-server";'],
	["packages/desktop/src/renderer/example.tsx", 'const server = require("@metis/app-server");'],
	["packages/desktop/src/renderer/example.cts", 'import server = require("@metis/app-server");'],
	["packages/desktop/src/renderer/example.tsx", 'export { connect } from "../main/connection.ts";'],
	["packages/desktop/src/renderer/example.tsx", 'import { main } from "../main";'],
	["packages/desktop/src/renderer/example.tsx", 'import { api } from "../preload";'],
	["packages/desktop/src/main/example.ts", 'import { App } from "../renderer";'],
	["packages/desktop/src/renderer/example.ts", 'await import("node:fs");'],
	["packages/desktop/src/shared/example.ts", 'import { BrowserWindow } from "electron";'],
	["packages/desktop/src/shared/example.ts", 'export { state } from "../renderer/store.ts";'],
	["packages/app-protocol/src/example.ts", 'import type { Stats } from "node:fs";'],
	["packages/app-server/src/example.ts", 'import { internal } from "@metis/coding-agent/host/internal";'],
	["packages/ai/src/example.ts", 'import { agent } from "../../agent/src/index.ts";'],
	["packages/desktop/test/example.tsx", 'type Server = import("@metis/app-server").Server;'],
	["packages/desktop/e2e/example.spec.ts", 'import { server } from "@metis/app-server";'],
	["packages/desktop/e2e/fixtures/example.ts", 'import { helper } from "../../../coding-agent/test/helper.ts";'],
	["packages/desktop/e2e/example.spec.ts", 'await import("@metis/coding-agent/host");'],
	["packages/desktop/e2e/example.spec.ts", 'type Agent = import("@metis/agent-core").Agent;'],
	["packages/desktop/e2e/example.spec.ts", 'import "@metis/app-server"; // boundary-allow:'],
	["packages/desktop/src/renderer/example.tsx", 'import "@metis/app-server"; const note = "boundary-allow";'],
	["packages/desktop/src/renderer/example.tsx", 'import "@metis/app-server"; // boundary-allow'],
];

for (const [file, source] of forbiddenImports) {
	test(`architecture rejects ${file}: ${source}`, (t) => {
		const result = check(t, boundaryScript, file, source);
		assert.equal(result.status, 1, result.stderr || "Expected an architecture violation");
		assert.match(result.stderr, /Architecture boundary violations:/);
		assert.ok(result.stderr.includes(`${file}:1:`), result.stderr);
	});
}

const allowedImports = [
	["packages/agent/src/example.ts", 'import { getModel } from "@metis/ai/compat";'],
	["packages/agent/src/example.ts", 'import { fauxProvider } from "@metis/ai/providers/faux";'],
	["packages/ai/src/example.ts", 'import { local } from "../..hidden/local.ts";'],
	["packages/app-server/src/example.ts", 'import { createRuntime } from "@metis/coding-agent/host";'],
	["packages/desktop/src/renderer/example.tsx", 'import type { ClientResult } from "@metis/app-protocol";'],
	["packages/desktop/src/main/example.ts", 'import { readFile } from "node:fs/promises";'],
	["packages/desktop/src/shared/example.ts", 'import { api } from "./";'],
	["packages/app-protocol/src/example.ts", 'import { Type } from "typebox";'],
	["packages/desktop/e2e/example.spec.ts", 'import type { ClientResult } from "@metis/app-protocol";'],
	["packages/desktop/e2e/example.spec.ts", 'import { readFile } from "node:fs/promises";'],
	["packages/desktop/e2e/fixtures/example.ts", 'import { helper } from "../../src/main/helper.ts";'],
	[
		"packages/desktop/e2e/fixtures/example.ts",
		'import { helper } from "../../../coding-agent/test/helper.ts"; // boundary-allow: reuse the MCP test server fixture',
	],
	[
		"packages/desktop/test/example.ts",
		'import "@metis/app-server"; // boundary-allow: exercise the transport adapter',
	],
];

for (const [file, source] of allowedImports) {
	test(`architecture permits ${file}: ${source}`, (t) => {
		const result = check(t, boundaryScript, file, source);
		assert.equal(result.status, 0, result.stderr);
	});
}

test("an e2e boundary allowance applies only to its own statement", (t) => {
	const file = "packages/desktop/e2e/example.spec.ts";
	const result = check(
		t,
		boundaryScript,
		file,
		'import "@metis/app-server"; // boundary-allow: exercise the browser tool fixture\nimport "@metis/ai";',
	);
	assert.equal(result.status, 1, result.stderr);
	assert.ok(result.stderr.includes(`${file}:2:`), result.stderr);
	assert.ok(!result.stderr.includes(`${file}:1:`), result.stderr);
});

for (const extension of ["ts", "tsx", "mts", "cts"]) {
	for (const source of [
		'import { value } from "./value.js";',
		'export { value } from "./value.js";',
		'await import("./value.js");',
		'type Value = import("./value.js").Value;',
		'const value = require("./value.js");',
	]) {
		test(`native imports reject .js references in .${extension}: ${source}`, (t) => {
			const result = check(t, importScript, `packages/ai/src/example.${extension}`, source);
			assert.equal(result.status, 1, result.stderr || "Expected a native import violation");
			assert.match(result.stderr, /Relative \.js imports are not allowed/);
		});
	}
}

test("native imports preserve explicit TypeScript and real JavaScript modules", (t) => {
	const result = check(
		t,
		importScript,
		"packages/ai/src/example.tsx",
		'import { value } from "./value.ts"; import { helper } from "./helper.mjs";',
	);
	assert.equal(result.status, 0, result.stderr);
});
