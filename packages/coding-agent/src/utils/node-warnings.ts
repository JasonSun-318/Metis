/**
 * Node's `node:sqlite` module warns at import time that SQLite is experimental.
 * The coding-agent imports it for the legacy memory migration, so the CLI
 * suppresses only that startup warning and leaves every other warning alone.
 */
const SQLITE_EXPERIMENTAL_WARNING = "SQLite is an experimental feature and might change at any time";
const EXPERIMENTAL_WARNING_TYPE = "ExperimentalWarning";

type EmitWarning = typeof process.emitWarning;

let installedEmitWarning: EmitWarning | undefined;

function readWarningType(typeOrOptions: unknown): string | undefined {
	if (typeof typeOrOptions === "string") {
		return typeOrOptions;
	}
	if (typeOrOptions !== null && typeof typeOrOptions === "object") {
		const type = (typeOrOptions as { type?: unknown }).type;
		return typeof type === "string" ? type : undefined;
	}
	return undefined;
}

function isSqliteExperimentalWarning(args: readonly unknown[]): boolean {
	const [warning, typeOrOptions] = args;

	if (warning instanceof Error) {
		if (warning.message !== SQLITE_EXPERIMENTAL_WARNING) {
			return false;
		}
		// Node ignores the type/options argument for an Error warning.
		return warning.name === EXPERIMENTAL_WARNING_TYPE;
	}

	return warning === SQLITE_EXPERIMENTAL_WARNING && readWarningType(typeOrOptions) === EXPERIMENTAL_WARNING_TYPE;
}

/**
 * Install the SQLite warning filter on `process.emitWarning`.
 *
 * Idempotent: installing again while this wrapper is active is a no-op, so the
 * Bun entrypoint and the main CLI can both install it without stacking
 * wrappers. If `process.emitWarning` was replaced or restored, a fresh wrapper
 * is installed around the current implementation.
 */
export function installSqliteWarningFilter(): void {
	if (installedEmitWarning !== undefined && process.emitWarning === installedEmitWarning) {
		return;
	}

	const originalEmitWarning = process.emitWarning;
	const filteredEmitWarning: EmitWarning = function (this: unknown, ...args: unknown[]): void {
		if (isSqliteExperimentalWarning(args)) {
			return;
		}
		Reflect.apply(originalEmitWarning, this, args);
	};

	installedEmitWarning = filteredEmitWarning;
	process.emitWarning = filteredEmitWarning;
}
