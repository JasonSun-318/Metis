import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "metis-browser-smoke.js");
const errorLogPath = join(tmpdir(), "metis-browser-smoke-errors.log");

try {
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: outputPath,
		// @mistralai/mistralai imports its tracing peer unconditionally in ESM, but
		// treats a missing module as "tracing disabled" at runtime; see
		// packages/ai/test/mistral-optional-tracing.test.ts. The package is not a
		// dependency, so leave it unresolved instead of failing the build.
		external: ["@opentelemetry/api"],
	});
	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
