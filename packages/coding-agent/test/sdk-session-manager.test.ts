import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@metis/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type PermissionRequest } from "../src/core/sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `metis-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const canonicalCwd = realpathSync(cwd);
		const safePath = `--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("creates the default SDK session in the requested agent mode without changing the prompt", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({ cwd, agentDir, model, agentMode: "chat" });

		expect(session.mode).toBe("chat");
		expect(session.systemPrompt).toContain("You are Metis, a general-purpose AI agent");
		expect(session.systemPrompt).toContain(
			"do not assume it is a software project unless the user or its contents indicate that",
		);
		expect(session.systemPrompt).not.toContain("You are operating in chat mode.");
		expect(session.systemPrompt).not.toContain("You are operating in code mode.");
		session.dispose();
	});

	it("creates Chat without cwd in an owned managed workspace with Auto permissions", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({ agentDir, model, agentMode: "chat" });

		expect(session.mode).toBe("chat");
		expect(session.sessionManager.getCwdOrigin()).toBe("managed");
		expect(session.sessionManager.getCwd()).toBe(
			realpathSync(join(agentDir, "workspaces", session.sessionManager.getSessionId())),
		);
		expect(session.sessionManager.getPermissionSettings()).toEqual({ mode: "auto" });
		session.dispose();
	});

	it("creates Code without cwd in the host cwd with Auto permissions", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({ agentDir, model, agentMode: "code" });

		expect(session.mode).toBe("code");
		expect(session.sessionManager.getCwd()).toBe(realpathSync(process.cwd()));
		expect(session.sessionManager.getCwdOrigin()).toBe("user-selected");
		expect(session.sessionManager.getPermissionSettings()).toEqual({ mode: "auto" });
		session.dispose();
	});

	it("preserves SDK Auto and ignores reviewerEnabled", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			agentMode: "chat",
			permissionMode: "auto",
			reviewerEnabled: false,
		});

		expect(session.sessionManager.getPermissionSettings()).toEqual({ mode: "auto" });
		expect(session.sessionManager.getHeader()).not.toHaveProperty("reviewerEnabled");
		session.dispose();
	});

	it("exposes complete one-action details through the SDK approval callback", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let request: PermissionRequest | undefined;
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			permissionMode: "ask",
			onPermissionRequest: async (next) => {
				request = next;
				return "allow-once";
			},
		});

		await session.requestPermissionApproval({
			action: {
				actionId: "push-1",
				toolName: "bash",
				provenance: "builtin",
				risks: ["shell", "network", "external-side-effect"],
				paths: [],
				networkTargets: [],
				command: "git push origin main",
			},
			args: { command: "git push origin main" },
			reason: "This action affects the host",
		});
		expect(request).toMatchObject({
			kind: "action",
			title: "Approve bash?",
		});
		expect(request?.details).toContain("Command: git push origin main");
		expect(request?.details).toContain("Metis does not sandbox this action");
		session.dispose();
	});

	it("rejects an agentMode that conflicts with an explicit session manager", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory(cwd, { mode: "chat" });

		await expect(createAgentSession({ cwd, agentDir, model, sessionManager, agentMode: "code" })).rejects.toThrow(
			"agentMode cannot override the supplied sessionManager mode",
		);
		sessionManager.close();
	});

	it("rejects cwd or permission settings that conflict with an explicit session manager", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const sessionManager = SessionManager.inMemory(cwd, {
			mode: "chat",
			permissionMode: "ask",
		});
		const otherCwd = join(tempDir, "other-project");
		mkdirSync(otherCwd);

		await expect(createAgentSession({ cwd: otherCwd, agentDir, model, sessionManager })).rejects.toThrow(
			"cwd cannot override the supplied sessionManager cwd",
		);
		await expect(createAgentSession({ agentDir, model, sessionManager, permissionMode: "full" })).rejects.toThrow(
			"permissionMode cannot override the supplied sessionManager permissions",
		);
		const compatible = await createAgentSession({ agentDir, model, sessionManager, reviewerEnabled: true });
		expect(compatible.session.sessionManager).toBe(sessionManager);
		expect(sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		compatible.session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		expect(realpathSync(session.sessionManager.getCwd())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});

	it("releases an internally-created session lease when initialization fails", async () => {
		const resourceLoader: ResourceLoader = {
			getExtensions: () => {
				throw new Error("injected extension discovery failure");
			},
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		await expect(createAgentSession({ cwd, agentDir, resourceLoader })).rejects.toThrow(
			"injected extension discovery failure",
		);

		const canonicalCwd = realpathSync(cwd);
		const [created] = await SessionManager.list(canonicalCwd, getDefaultSessionDir(canonicalCwd, agentDir));
		expect(created).toBeDefined();
		const reopened = SessionManager.open(created!.path);
		reopened.close();
	});
});
