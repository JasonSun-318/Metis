/**
 * JavaScript call semantics for inline scripts: which globals, modules, and fs
 * functions stay statically provable, and what each fs form records.
 */
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import type { ArgumentList, ScriptSemanticsContext, ScriptValue } from "./script-values.ts";
import { STATIC, staticText, UNKNOWN } from "./script-values.ts";

export const JAVASCRIPT_STRING_METHODS = new Set([
	"at",
	"charAt",
	"charCodeAt",
	"concat",
	"endsWith",
	"includes",
	"indexOf",
	"lastIndexOf",
	"padEnd",
	"padStart",
	"repeat",
	"replace",
	"replaceAll",
	"slice",
	"split",
	"startsWith",
	"substring",
	"toLowerCase",
	"toUpperCase",
	"trim",
	"trimEnd",
	"trimStart",
]);
const JAVASCRIPT_MODULES = new Map([
	["fs", "fs"],
	["node:fs", "fs"],
	["path", "path"],
	["node:path", "path"],
]);
const JS_FS_READ = new Set([
	"accessSync",
	"existsSync",
	"lstatSync",
	"readFileSync",
	"readdirSync",
	"readlinkSync",
	"realpathSync",
	"statSync",
]);
const JS_FS_WRITE = new Set([
	"appendFile",
	"appendFileSync",
	"chmod",
	"chmodSync",
	"chown",
	"chownSync",
	"copyFile",
	"copyFileSync",
	"linkSync",
	"mkdir",
	"mkdirSync",
	"rename",
	"renameSync",
	"rm",
	"rmSync",
	"symlinkSync",
	"truncate",
	"truncateSync",
	"unlink",
	"unlinkSync",
	"writeFile",
	"writeFileSync",
]);
const JS_FS_DESTRUCTIVE = new Set(["rm", "rmSync", "unlink", "unlinkSync"]);
export const JAVASCRIPT_REFUSED_IDENTIFIERS = new Set([
	"eval",
	"fetch",
	"globalThis",
	"import",
	"process",
	"Promise",
	"Reflect",
	"setInterval",
	"setTimeout",
	"WebAssembly",
	"XMLHttpRequest",
	"WebSocket",
]);
export const JAVASCRIPT_GLOBAL_OBJECTS = new Set([
	"Array",
	"Boolean",
	"console",
	"JSON",
	"Math",
	"Number",
	"Object",
	"String",
]);

function callRequire(ctx: ScriptSemanticsContext, args: ArgumentList): ScriptValue {
	const moduleName = staticText(args.positionals[0] ?? UNKNOWN);
	const normalized = checkJavaScriptModule(ctx, moduleName, true);
	return normalized ? { kind: "module", name: normalized } : UNKNOWN;
}

export function javascriptIdentifier(
	ctx: ScriptSemanticsContext,
	name: string,
	args: ArgumentList,
	vars: Map<string, ScriptValue>,
): ScriptValue {
	if (JAVASCRIPT_REFUSED_IDENTIFIERS.has(name)) {
		ctx.mark("user", `inline script calls unsupported global: ${name}`, false);
		return UNKNOWN;
	}
	switch (name) {
		case "console":
			return STATIC;
		case "parseInt":
		case "parseFloat":
		case "String":
		case "Number":
		case "Boolean":
			return STATIC;
		case "require":
			return callRequire(ctx, args);
		default:
			break;
	}
	const value = vars.get(name);
	if (value?.kind === "module") return ctx.callModule(value.name, args, vars);
	ctx.mark("user", `inline script calls an unknown function: ${name}`, false);
	return UNKNOWN;
}

export function javascriptModuleCall(
	ctx: ScriptSemanticsContext,
	moduleName: string,
	member: string,
	args: ArgumentList,
	vars: Map<string, ScriptValue>,
): ScriptValue {
	void vars;
	if (moduleName === "console") {
		if (["log", "info", "warn", "error", "debug", "table", "dir", "trace", "assert"].includes(member)) return STATIC;
		ctx.mark("user", `inline script calls an unsupported console function: ${member}`, false);
		return UNKNOWN;
	}
	if (moduleName === "JSON") {
		if (member === "stringify" || member === "parse") return STATIC;
		ctx.mark("user", `inline script calls an unsupported JSON function: ${member}`, false);
		return UNKNOWN;
	}
	if (moduleName === "Math" || moduleName === "Number" || moduleName === "String" || moduleName === "Boolean") {
		return STATIC;
	}
	if (moduleName === "Object" || moduleName === "Array") {
		if (["keys", "values", "entries", "freeze", "is", "isArray", "from", "of", "assign"].includes(member)) {
			return STATIC;
		}
		ctx.mark("user", `inline script calls an unsupported ${moduleName} function: ${member}`, false);
		return UNKNOWN;
	}
	if (moduleName === "path") return callPathModule(ctx, member, args);
	if (moduleName !== "fs") {
		ctx.mark("user", `inline script calls an unsupported module function: ${moduleName}.${member}`, false);
		return UNKNOWN;
	}
	if (member === "readFileSync") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		if (path === undefined) {
			ctx.mark("user", "inline script reads a dynamic path", false);
			return UNKNOWN;
		}
		ctx.recordRead(path, false);
		const encoding = staticText(args.positionals[1] ?? UNKNOWN);
		return encoding === undefined ? { kind: "bytes" } : { kind: "string" };
	}
	if (member === "readdirSync") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		if (path === undefined) {
			ctx.mark("user", "inline script lists a dynamic path", false);
			return UNKNOWN;
		}
		ctx.recordRead(path, true);
		return STATIC;
	}
	if (JS_FS_READ.has(member)) {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		if (path === undefined) {
			ctx.mark("user", "inline script inspects a dynamic path", false);
			return UNKNOWN;
		}
		ctx.recordRead(path, member === "statSync" || member === "lstatSync");
		return STATIC;
	}
	if (JS_FS_WRITE.has(member)) {
		if (member === "renameSync" || member === "copyFileSync" || member === "linkSync" || member === "symlinkSync") {
			const source = staticText(args.positionals[0] ?? UNKNOWN);
			const target = staticText(args.positionals[1] ?? UNKNOWN);
			if (target === undefined) {
				ctx.mark("user", `${member} uses a dynamic write target`, false);
			} else {
				if (source !== undefined && member === "copyFileSync") ctx.recordRead(source, false);
				ctx.recordWrite(target, member === "renameSync");
			}
			return STATIC;
		}
		const target = staticText(args.positionals[0] ?? UNKNOWN);
		if (target === undefined) {
			ctx.mark("user", `${member} uses a dynamic write target`, false);
		} else {
			ctx.recordWrite(target, JS_FS_DESTRUCTIVE.has(member));
		}
		return STATIC;
	}
	if (member === "createReadStream") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		if (path === undefined) ctx.mark("user", "inline script streams a dynamic path", false);
		else ctx.recordRead(path, false);
		return STATIC;
	}
	if (member === "createWriteStream") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		if (path === undefined) ctx.mark("user", "inline script streams to a dynamic path", false);
		else ctx.recordWrite(path);
		return STATIC;
	}
	if (member === "openSync") {
		const path = staticText(args.positionals[0] ?? UNKNOWN);
		const flags = staticText(args.positionals[1] ?? UNKNOWN) ?? "r";
		if (path === undefined) {
			ctx.mark("user", "inline script opens a dynamic path", false);
			return UNKNOWN;
		}
		if (/[wa+]/u.test(flags)) ctx.recordWrite(path);
		else ctx.recordRead(path, false);
		return STATIC;
	}
	ctx.mark("user", `inline script calls an unsupported fs function: ${member}`, false);
	return UNKNOWN;
}
function callPathModule(ctx: ScriptSemanticsContext, member: string, args: ArgumentList): ScriptValue {
	if (args.splat) {
		ctx.mark("user", "inline script calls a path function with splatted arguments", false);
		return UNKNOWN;
	}
	const values = args.positionals.map(staticText);
	if (values.some((value) => value === undefined)) return UNKNOWN;
	const parts = values as string[];
	switch (member) {
		case "join":
			return { kind: "static", value: join(...parts) };
		case "resolve":
			return { kind: "static", value: resolve(ctx.currentDirectory, ...parts) };
		case "normalize":
			return { kind: "static", value: normalize(parts[0] ?? "") };
		case "dirname":
			return { kind: "static", value: dirname(parts[0] ?? "") };
		case "basename":
			return { kind: "static", value: basename(parts[0] ?? "") };
		case "extname":
			return { kind: "static", value: extname(parts[0] ?? "") };
		case "isAbsolute":
			return { kind: "static", value: String(parts[0]?.startsWith("/") ?? false) };
		case "format":
		case "parse":
		case "relative":
		case "toNamespacedPath":
			return STATIC;
		default:
			ctx.mark("user", `inline script calls an unsupported path function: ${member}`, false);
			return UNKNOWN;
	}
}

export function checkJavaScriptModule(
	ctx: ScriptSemanticsContext,
	moduleName: string | undefined,
	markFailure: boolean,
): string | undefined {
	const normalized = moduleName ? JAVASCRIPT_MODULES.get(moduleName) : undefined;
	if (!normalized && markFailure) {
		ctx.mark("user", `inline script loads an unsupported module: ${moduleName ?? "unknown"}`, false);
	}
	return normalized;
}
