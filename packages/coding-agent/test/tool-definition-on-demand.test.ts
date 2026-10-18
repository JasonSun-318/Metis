import { resolve } from "node:path";
import type { TUI } from "@metis/tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	return {
		calls,
		track<TArgs extends unknown[], TResult>(name: string, actual: (...args: TArgs) => TResult) {
			return (...args: TArgs): TResult => {
				calls.push({ name, args });
				return actual(...args);
			};
		},
	};
});

vi.mock("../src/core/tools/read.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/read.ts")>();
	return { ...actual, createReadToolDefinition: mocks.track("read", actual.createReadToolDefinition) };
});

vi.mock("../src/core/tools/bash.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/bash.ts")>();
	return { ...actual, createBashToolDefinition: mocks.track("bash", actual.createBashToolDefinition) };
});

vi.mock("../src/core/tools/edit.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/edit.ts")>();
	return { ...actual, createEditToolDefinition: mocks.track("edit", actual.createEditToolDefinition) };
});

vi.mock("../src/core/tools/write.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/write.ts")>();
	return { ...actual, createWriteToolDefinition: mocks.track("write", actual.createWriteToolDefinition) };
});

vi.mock("../src/core/tools/grep.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/grep.ts")>();
	return { ...actual, createGrepToolDefinition: mocks.track("grep", actual.createGrepToolDefinition) };
});

vi.mock("../src/core/tools/find.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/find.ts")>();
	return { ...actual, createFindToolDefinition: mocks.track("find", actual.createFindToolDefinition) };
});

vi.mock("../src/core/tools/ls.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/ls.ts")>();
	return { ...actual, createLsToolDefinition: mocks.track("ls", actual.createLsToolDefinition) };
});

vi.mock("../src/core/tools/web-fetch.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/web-fetch.ts")>();
	return { ...actual, createWebFetchToolDefinition: mocks.track("web_fetch", actual.createWebFetchToolDefinition) };
});

vi.mock("../src/core/tools/web-search.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/web-search.ts")>();
	return {
		...actual,
		createWebSearchToolDefinition: mocks.track("web_search", actual.createWebSearchToolDefinition),
	};
});

vi.mock("../src/core/tools/describe-image.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/describe-image.ts")>();
	return {
		...actual,
		createDescribeImageToolDefinition: mocks.track("describe_image", actual.createDescribeImageToolDefinition),
	};
});

vi.mock("../src/core/set-tasks.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/set-tasks.ts")>();
	return {
		...actual,
		createSetTasksToolDefinition: mocks.track("set_tasks", actual.createSetTasksToolDefinition),
	};
});

vi.mock("../src/core/goal/tools.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/goal/tools.ts")>();
	return {
		...actual,
		createGetGoalToolDefinition: mocks.track("get_goal", actual.createGetGoalToolDefinition),
		createCreateGoalToolDefinition: mocks.track("create_goal", actual.createCreateGoalToolDefinition),
		createUpdateGoalToolDefinition: mocks.track("update_goal", actual.createUpdateGoalToolDefinition),
	};
});

import { createAllToolDefinitions, lookupToolDefinition, type ToolName } from "../src/core/tools/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const builtInToolNames = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"web_fetch",
	"web_search",
	"set_tasks",
	"get_goal",
	"create_goal",
	"update_goal",
	"describe_image",
] as const;

const cwd = process.cwd();
const otherCwd = resolve(cwd, "another-project");

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("on-demand tool definition construction", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		mocks.calls.length = 0;
	});

	test("builds only the requested built-in definition", () => {
		const definition = lookupToolDefinition("read", cwd);

		expect(definition?.name).toBe("read");
		expect(mocks.calls.map(({ name }) => name)).toEqual(["read"]);
		expect(mocks.calls[0]?.args[0]).toBe(cwd);
	});

	test("maps every built-in name to exactly its own factory", () => {
		for (const name of builtInToolNames) {
			mocks.calls.length = 0;

			const definition = lookupToolDefinition(name, cwd);

			expect(definition?.name).toBe(name);
			expect(mocks.calls.map((call) => call.name)).toEqual([name]);
		}
	});

	test("selected definitions are fresh, cwd-specific, and receive their options", () => {
		const readOptions = { autoResizeImages: false };

		const first = lookupToolDefinition("read", cwd, { read: readOptions });
		const second = lookupToolDefinition("read", cwd, { read: readOptions });
		const other = lookupToolDefinition("read", otherCwd);

		expect(first).not.toBe(second);
		expect(first).not.toBe(other);
		expect(mocks.calls.map(({ args }) => args[0])).toEqual([cwd, cwd, otherCwd]);
		expect(mocks.calls[0]?.args[1]).toBe(readOptions);
	});

	test("ToolExecutionComponent builds only the built-in definition it displays", () => {
		new ToolExecutionComponent("read", "tool-on-demand", { path: "README.md" }, {}, undefined, createFakeTui(), cwd);

		expect(mocks.calls.map(({ name }) => name)).toEqual(["read"]);
	});

	test("a full-table construction does not seed the on-demand lookup", () => {
		const all = createAllToolDefinitions(cwd);
		mocks.calls.length = 0;

		const selected = lookupToolDefinition("read", cwd);

		expect(selected).not.toBe(all.read);
		expect(mocks.calls.map(({ name }) => name)).toEqual(["read"]);
	});

	test("createAllToolDefinitions still builds the complete fresh table", () => {
		const readOptions = { autoResizeImages: false };
		const all = createAllToolDefinitions(cwd, { read: readOptions });

		expect(Object.keys(all)).toEqual(builtInToolNames);
		expect(Object.getPrototypeOf(all)).toBe(Object.prototype);
		for (const name of builtInToolNames) {
			expect(all[name].name).toBe(name);
		}
		expect(mocks.calls.map(({ name }) => name)).toEqual(builtInToolNames);
		expect(mocks.calls[0]?.args).toEqual([cwd, readOptions]);
	});

	test("keeps plain-record lookup behavior for unknown and prototype names", () => {
		const names = [
			"constructor",
			"toString",
			"__proto__",
			"hasOwnProperty",
			"valueOf",
			"isPrototypeOf",
			"propertyIsEnumerable",
			"toLocaleString",
			"__defineGetter__",
			"unknown_tool",
			"",
		];

		for (const name of names) {
			const expected = createAllToolDefinitions(cwd)[name as ToolName];
			mocks.calls.length = 0;

			expect(lookupToolDefinition(name, cwd)).toBe(expected);
			expect(mocks.calls).toEqual([]);
		}

		expect(lookupToolDefinition("constructor", cwd)).toBe(Object);
		expect(lookupToolDefinition("toString", cwd)).toBe(Object.prototype.toString);
		expect(lookupToolDefinition("__proto__", cwd)).toBe(Object.prototype);
		expect(lookupToolDefinition("unknown_tool", cwd)).toBeUndefined();
	});

	test("keeps raw-name lookup even when the display name sanitizes to a built-in", () => {
		const rawName = "\u001b[31mread\u001b[0m";
		const component = new ToolExecutionComponent(
			rawName,
			"tool-raw-name",
			{ path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			cwd,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain('"path": "README.md"');
		expect(rendered).not.toContain("read README.md");
		expect(mocks.calls).toEqual([]);
	});

	test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
		"keeps inherited %s lookup behavior in ToolExecutionComponent",
		(name) => {
			const component = new ToolExecutionComponent(
				name,
				`tool-prototype-${name}`,
				{ foo: "bar" },
				{},
				undefined,
				createFakeTui(),
				cwd,
			);

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain(name);
			expect(rendered).not.toContain('"foo": "bar"');
			expect(mocks.calls).toEqual([]);
		},
	);
});
