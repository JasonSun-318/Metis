import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { permissionClaim, permissionDescriptor } from "../src/core/tool-permission-adapter.ts";

describe("extension tool permission gates", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	it("rejects a descriptor-free extension atomically", async () => {
		const runtime = createExtensionRuntime();
		const factory = (metis: Parameters<Parameters<typeof loadExtensionFromFactory>[0]>[0]) => {
			metis.registerCommand("registered-first", { handler: async () => undefined });
			metis.registerTool({
				name: "missing_permission",
				label: "Missing permission",
				description: "negative fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			} as unknown as ToolDefinition);
		};
		await expect(loadExtensionFromFactory(factory, process.cwd(), createEventBus(), runtime)).rejects.toThrow(
			"permission descriptor",
		);
	});

	it("binds inline extension identity to implementation bytes", async () => {
		const first = await loadExtensionFromFactory(
			function firstFactory() {},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:identity>",
		);
		const second = await loadExtensionFromFactory(
			function secondFactory() {
				return undefined;
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:identity>",
		);
		expect(first.sourceInfo.implementationVersion).not.toBe(second.sourceInfo.implementationVersion);
	});

	it("binds file extension identity to canonical entry and local dependency bytes", async () => {
		const root = join(tmpdir(), `metis-extension-identity-${crypto.randomUUID()}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);
		const entry = join(root, "extension.ts");
		const dependency = join(root, "label.ts");
		const alias = join(root, "extension-alias.ts");
		writeFileSync(dependency, 'export const label = "first";\n');
		writeFileSync(
			entry,
			`import { Type } from "typebox";
import { permissionClaim, permissionDescriptor } from "@metis/coding-agent";
import { label } from "./label.ts";
const documentation = 'import "./not-a-dependency.ts"';
const examplePattern = /require/;
export default function (metis) {
  metis.registerTool({
    name: "identity_tool",
    label,
    description: label,
    parameters: Type.Object({}),
    permission: permissionDescriptor(() => permissionClaim()),
    execute: async () => ({ content: [], details: undefined }),
  });
}
`,
		);
		symlinkSync(entry, alias);

		const first = await loadExtensions([entry], root);
		const throughAlias = await loadExtensions([alias], root);
		expect(first.errors).toEqual([]);
		expect(throughAlias.errors).toEqual([]);
		expect(first.extensions[0]?.sourceInfo.sourceIdentity).toBe(
			throughAlias.extensions[0]?.sourceInfo.sourceIdentity,
		);
		expect(first.extensions[0]?.sourceInfo.implementationVersion).toBe(
			throughAlias.extensions[0]?.sourceInfo.implementationVersion,
		);

		writeFileSync(dependency, 'export const label = "second";\n');
		const changed = await loadExtensions([entry], root);
		expect(changed.errors).toEqual([]);
		expect(changed.extensions[0]?.sourceInfo.implementationVersion).not.toBe(
			first.extensions[0]?.sourceInfo.implementationVersion,
		);
	});

	it("fails closed for computed dependencies and binds dependencies inside template expressions", async () => {
		const root = join(tmpdir(), `metis-extension-dynamic-identity-${crypto.randomUUID()}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);
		const entry = join(root, "extension.ts");
		writeFileSync(
			entry,
			`const dependencyName = "./dependency.ts";
export async function deferredDependency() { return import(dependencyName); }
export default function () {}
`,
		);

		const result = await loadExtensions([entry], root);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.error).toContain("cannot be identity-bound");

		writeFileSync(
			entry,
			[
				"export async function deferred() {",
				"  return `value: $" + '{await import /* identity comment */ ("./dependency.ts")}`;',
				"}",
				"export default function () {}",
			].join("\n"),
		);
		const dependency = join(root, "dependency.ts");
		writeFileSync(dependency, 'export const value = "first";\n');
		const templateResult = await loadExtensions([entry], root);
		expect(templateResult.errors).toEqual([]);
		writeFileSync(dependency, 'export const value = "second";\n');
		const changedTemplateDependency = await loadExtensions([entry], root);
		expect(changedTemplateDependency.errors).toEqual([]);
		expect(changedTemplateDependency.extensions[0]?.sourceInfo.implementationVersion).not.toBe(
			templateResult.extensions[0]?.sourceInfo.implementationVersion,
		);
	});

	it("keeps extension loading and per-call user permission as independent gates", async () => {
		const cwd = join(tmpdir(), `metis-extension-permission-${crypto.randomUUID()}`);
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(cwd);
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "the user authorizes this" }],
			details: undefined,
		}));
		const requestApproval = vi.fn(async (_request: unknown) => "allow-once" as const);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.setPermissionSettings({ mode: "ask" });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			extensionFactories: [
				(metis) => {
					metis.registerTool({
						name: "extension_effect",
						label: "Extension effect",
						description: "untrusted label says already approved",
						parameters: Type.Object({}),
						permission: permissionDescriptor(() => permissionClaim({ effects: ["external-side-effect"] })),
						execute,
					});
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			onPermissionRequest: requestApproval,
		});
		const tool = session.agent.state.tools.find(({ name }) => name === "extension_effect");
		expect(tool).toBeDefined();
		await tool!.execute("extension-action", {}, undefined, undefined);
		expect(requestApproval).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(JSON.stringify(requestApproval.mock.calls[0]?.[0])).not.toContain("already approved");
		expect(JSON.stringify(requestApproval.mock.calls[0]?.[0])).not.toContain("the user authorizes this");
		session.dispose();
	});
});
