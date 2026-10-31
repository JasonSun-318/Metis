/**
 * Python call semantics for inline scripts: which builtins, modules, string
 * methods, and file-open forms stay statically provable.
 */
import type { ArgumentList, ScriptSemanticsContext, ScriptValue } from "./script-values.ts";
import { isUnknown, STATIC, staticText, UNKNOWN } from "./script-values.ts";

export const PYTHON_MODULES = new Set(["json", "math", "pathlib", "re", "string"]);
const PYTHON_PURE_BUILTINS = new Set([
	"abs",
	"all",
	"any",
	"bool",
	"dict",
	"divmod",
	"enumerate",
	"filter",
	"float",
	"format",
	"frozenset",
	"int",
	"len",
	"list",
	"map",
	"max",
	"min",
	"pow",
	"range",
	"repr",
	"reversed",
	"round",
	"set",
	"sorted",
	"str",
	"sum",
	"tuple",
	"zip",
]);
export const PYTHON_STRING_METHODS = new Set([
	"capitalize",
	"casefold",
	"center",
	"count",
	"encode",
	"endswith",
	"expandtabs",
	"find",
	"format",
	"index",
	"isalnum",
	"isalpha",
	"isdecimal",
	"isdigit",
	"islower",
	"isnumeric",
	"isspace",
	"istitle",
	"isupper",
	"join",
	"ljust",
	"lower",
	"lstrip",
	"partition",
	"removeprefix",
	"removesuffix",
	"replace",
	"rfind",
	"rindex",
	"rjust",
	"rpartition",
	"rsplit",
	"rstrip",
	"split",
	"splitlines",
	"startswith",
	"strip",
	"swapcase",
	"title",
	"upper",
	"zfill",
]);
const PYTHON_REFUSED_IDENTIFIERS = new Set([
	"__import__",
	"breakpoint",
	"compile",
	"delattr",
	"eval",
	"exec",
	"exit",
	"getattr",
	"globals",
	"hasattr",
	"help",
	"input",
	"locals",
	"open",
	"quit",
	"setattr",
	"vars",
]);

/**
 * `mode` carries the effect of a Python file open. It may arrive positionally
 * or as a keyword; a splat hides either, so it is never provable.
 */
export function pythonOpenEffect(
	ctx: ScriptSemanticsContext,
	pathValue: ScriptValue | undefined,
	modeValue: ScriptValue | undefined,
	args: ArgumentList,
): ScriptValue {
	if (args.splat) {
		ctx.mark("user", "inline script opens a file with splatted arguments", false);
		return UNKNOWN;
	}
	const path = staticText(pathValue ?? UNKNOWN);
	const mode = staticText(modeValue ?? { kind: "static", value: "r" });
	return pythonFileEffect(ctx, path, mode);
}

function pythonFileEffect(
	ctx: ScriptSemanticsContext,
	path: string | undefined,
	mode: string | undefined,
): ScriptValue {
	if (path === undefined) {
		ctx.mark("user", "inline script opens a dynamic path", false);
		return UNKNOWN;
	}
	if (mode === undefined) {
		ctx.mark("user", "inline script uses a dynamic file mode", false);
		return UNKNOWN;
	}
	if (/^[rubt]*$/u.test(mode)) {
		ctx.recordRead(path, false);
		return { kind: "file", path, mode: "read" };
	}
	if (/[wax]/u.test(mode) || mode.includes("+")) {
		ctx.recordWrite(path);
		return { kind: "file", path, mode: "write" };
	}
	ctx.mark("user", `inline script uses an unsupported file mode: ${mode}`, false);
	return UNKNOWN;
}

export function pythonIdentifier(
	ctx: ScriptSemanticsContext,
	name: string,
	args: ArgumentList,
	vars: Map<string, ScriptValue>,
): ScriptValue {
	if (name === "print") return STATIC;
	if (name === "open")
		return pythonOpenEffect(
			ctx,
			args.positionals[0] ?? args.keywords.get("file"),
			args.positionals[1] ?? args.keywords.get("mode"),
			args,
		);
	if (name === "Path") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		return path === undefined ? UNKNOWN : { kind: "path", value: path };
	}
	if (name === "str") {
		const text = staticText(args.positionals[0] ?? STATIC);
		return text === undefined ? STATIC : { kind: "static", value: text };
	}
	if (name === "int" || name === "float") {
		const text = staticText(args.positionals[0] ?? STATIC);
		if (text === undefined) return STATIC;
		const numeric = Number(text);
		return Number.isNaN(numeric) ? UNKNOWN : { kind: "static", value: String(numeric) };
	}
	if (PYTHON_PURE_BUILTINS.has(name)) {
		if (name === "range") {
			for (const arg of args.positionals) {
				if (isUnknown(arg)) return UNKNOWN;
			}
			return STATIC;
		}
		return STATIC;
	}
	if (PYTHON_REFUSED_IDENTIFIERS.has(name)) {
		ctx.mark("user", `inline script calls unsupported builtin: ${name}`, false);
		return UNKNOWN;
	}
	const value = vars.get(name);
	if (value?.kind === "module") return ctx.callModule(value.name, args, vars);
	ctx.mark("user", `inline script calls an unknown function: ${name}`, false);
	return UNKNOWN;
}

export function pythonModuleCall(
	ctx: ScriptSemanticsContext,
	moduleName: string,
	member: string,
	args: ArgumentList,
	vars: Map<string, ScriptValue>,
): ScriptValue {
	void vars;
	if (moduleName === "json") {
		if (member === "dumps" || member === "loads" || member === "dump") {
			if (member === "dump") {
				const file = args.positionals[1];
				if (file?.kind === "file") ctx.recordWrite(file.path);
			}
			return STATIC;
		}
		if (member === "load") {
			const file = args.positionals[0];
			if (file?.kind === "file") ctx.recordRead(file.path, false);
			return STATIC;
		}
	}
	if (moduleName === "pathlib" && member === "Path") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		return path === undefined ? UNKNOWN : { kind: "path", value: path };
	}
	if (moduleName === "math" || moduleName === "re" || moduleName === "string") return STATIC;
	ctx.mark("user", `inline script calls an unsupported module function: ${moduleName}.${member}`, false);
	return UNKNOWN;
}
