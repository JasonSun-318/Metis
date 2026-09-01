import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { permissionClaim, permissionDescriptor } from "../src/core/tool-permission-adapter.ts";

describe("SDK tool permissions", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) if (existsSync(root)) rmSync(root, { recursive: true, force: true });
	});

	async function resources(customTools: ToolDefinition[]) {
		const cwd = join(tmpdir(), `metis-sdk-permission-${crypto.randomUUID()}`);
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		roots.push(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.setPermissionPreset("full");
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		return { cwd, agentDir, settingsManager, sessionManager, resourceLoader, customTools };
	}

	it("rejects descriptor-free SDK tools before they enter the registry", async () => {
		const missing = {
			name: "missing",
			label: "Missing",
			description: "missing descriptor",
			parameters: Type.Object({}),
			execute: vi.fn(),
		} as unknown as ToolDefinition;
		const input = await resources([missing]);
		await expect(
			createAgentSession({
				...input,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			}),
		).rejects.toThrow("permission descriptor");
	});

	it("routes one described SDK invocation through authorization exactly once", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }));
		const tool: ToolDefinition = {
			name: "sdk_exact",
			label: "SDK exact",
			description: "described SDK tool",
			parameters: Type.Object({}),
			permission: permissionDescriptor(() => permissionClaim()),
			execute,
		};
		const input = await resources([tool]);
		const { session } = await createAgentSession({
			...input,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		const runtime = (
			session as unknown as {
				_permissionRuntime: { authorizeAndExecute: (...args: never[]) => unknown };
			}
		)._permissionRuntime;
		const authorize = vi.spyOn(runtime, "authorizeAndExecute" as never);
		const registered = session.agent.state.tools.find(({ name }) => name === tool.name);
		expect(registered).toBeDefined();
		await registered!.execute("sdk-action", {}, undefined, undefined);
		expect(authorize).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		session.dispose();
	});
});
