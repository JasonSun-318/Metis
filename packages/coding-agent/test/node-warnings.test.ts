import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installSqliteWarningFilter } from "../src/utils/node-warnings.ts";

const sqliteWarning = "SQLite is an experimental feature and might change at any time";
const experimentalWarning = "ExperimentalWarning";

type EmitWarning = typeof process.emitWarning;
type ForwardedCall = { args: unknown[]; receiver: unknown };

let originalEmitWarning: EmitWarning;

beforeEach(() => {
	originalEmitWarning = process.emitWarning;
});

afterEach(() => {
	process.emitWarning = originalEmitWarning;
});

function installForwardingSpy(): ForwardedCall[] {
	const calls: ForwardedCall[] = [];
	process.emitWarning = function (this: unknown, ...args: unknown[]): void {
		calls.push({ args, receiver: this });
	} as EmitWarning;
	installSqliteWarningFilter();
	return calls;
}

function callWith(receiver: object, args: unknown[]): void {
	Reflect.apply(process.emitWarning, receiver, args);
}

describe("SQLite warning filter", () => {
	it("forwards every Node emitWarning overload with exact arguments and receiver", () => {
		const calls = installForwardingSpy();
		const receiver = { name: "custom receiver" };
		const ctor = class CustomWarning extends Error {};
		const error = new Error("boom");
		const options = { type: "CustomWarning", code: "W1", detail: "detail", ctor };
		const cases: unknown[][] = [
			["plain warning"],
			["plain warning", "CustomWarning"],
			["plain warning", "CustomWarning", "W1"],
			["plain warning", "CustomWarning", "W1", ctor],
			["plain warning", ctor],
			["plain warning", options],
			[error],
			[error, "CustomWarning"],
			[error, "CustomWarning", "W1"],
			[error, options],
		];

		for (const args of cases) {
			callWith(receiver, args);
		}

		expect(calls).toHaveLength(cases.length);
		for (let index = 0; index < cases.length; index++) {
			const call = calls[index];
			const args = cases[index];
			expect(call?.receiver).toBe(receiver);
			expect(call?.args).toHaveLength(args?.length ?? 0);
			for (let argIndex = 0; argIndex < (args?.length ?? 0); argIndex++) {
				expect(call?.args[argIndex]).toBe(args?.[argIndex]);
			}
		}
	});

	it("suppresses the known SQLite experimental warning in string overloads", () => {
		const calls = installForwardingSpy();
		const receiver = {};
		const ctor = class SqliteWarning extends Error {};
		const argsList: unknown[][] = [
			[sqliteWarning, experimentalWarning],
			[sqliteWarning, experimentalWarning, "SQLITE001"],
			[sqliteWarning, experimentalWarning, "SQLITE001", ctor],
			[sqliteWarning, { type: experimentalWarning }],
			[sqliteWarning, { type: experimentalWarning, code: "SQLITE001", detail: "detail", ctor }],
		];

		for (const args of argsList) {
			callWith(receiver, args);
		}

		expect(calls).toEqual([]);
	});

	it("suppresses Error warning forms only when they are marked experimental", () => {
		const calls = installForwardingSpy();
		const receiver = {};
		const namedError = Object.assign(new Error(sqliteWarning), { name: experimentalWarning });
		const typedError = Object.assign(new Error(sqliteWarning), { name: experimentalWarning });
		const optionsError = Object.assign(new Error(sqliteWarning), { name: experimentalWarning });

		callWith(receiver, [namedError]);
		callWith(receiver, [typedError, experimentalWarning]);
		callWith(receiver, [optionsError, { type: experimentalWarning }]);

		expect(calls).toEqual([]);
	});

	it("forwards unrelated, mistyped, and merely similar warnings", () => {
		const calls = installForwardingSpy();
		const receiver = {};
		const cases: unknown[][] = [
			[sqliteWarning],
			[sqliteWarning, "Warning"],
			[sqliteWarning, `${experimentalWarning}ish`],
			[sqliteWarning, { type: "Warning", code: "SQLITE001" }],
			[`${sqliteWarning} (details)`, experimentalWarning],
			[`Prefix: ${sqliteWarning}`, experimentalWarning],
			["SQLite is a database", experimentalWarning],
			["another experimental feature", experimentalWarning],
			["legacy option is deprecated", "DeprecationWarning"],
			["security issue", "SecurityWarning"],
			[new Error(sqliteWarning)],
			[Object.assign(new Error("another experimental feature"), { name: experimentalWarning })],
			[new Error(sqliteWarning), "Warning"],
			[new Error(sqliteWarning), experimentalWarning],
			[new Error(sqliteWarning), { type: experimentalWarning }],
			[new Error(sqliteWarning), { type: "Warning" }],
		];

		for (const args of cases) {
			callWith(receiver, args);
		}

		expect(calls).toHaveLength(cases.length);
		for (let index = 0; index < cases.length; index++) {
			const call = calls[index];
			const args = cases[index];
			expect(call?.receiver).toBe(receiver);
			expect(call?.args).toHaveLength(args?.length ?? 0);
			for (let argIndex = 0; argIndex < (args?.length ?? 0); argIndex++) {
				expect(call?.args[argIndex]).toBe(args?.[argIndex]);
			}
		}
	});

	it("does not stack wrappers when installed repeatedly", () => {
		const calls = installForwardingSpy();
		const firstInstall = process.emitWarning;

		installSqliteWarningFilter();
		installSqliteWarningFilter();
		installSqliteWarningFilter();

		expect(process.emitWarning).toBe(firstInstall);
		callWith({}, ["visible warning", "CustomWarning"]);
		callWith({}, [sqliteWarning, experimentalWarning]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(["visible warning", "CustomWarning"]);
	});

	it("installs a fresh wrapper after process.emitWarning is restored", () => {
		installForwardingSpy();
		const firstInstall = process.emitWarning;
		process.emitWarning = originalEmitWarning;

		const calls = installForwardingSpy();

		expect(process.emitWarning).not.toBe(firstInstall);
		callWith({}, ["visible warning", "CustomWarning"]);
		expect(calls).toHaveLength(1);
	});
});
