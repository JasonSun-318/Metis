import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Browser, type Page } from "@playwright/test";
import {
	connectToApp,
	desktopRoot,
	launchPackagedDesktop,
	packagedExecutable,
	quitPackagedApp,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "../packaged-app-harness.ts";
import {
	PermissionProvider,
	type PermissionReviewerSeed,
	type PermissionToolCall,
	type ReviewDecision,
	type ReviewMode,
} from "./permission-provider.ts";

/**
 * Shared native-app fixture for the permission E2E suites.
 *
 * It reuses the packaged Electron harness (temporary HOME/agent/user-data) and
 * the fake provider contract. The fake provider proves protocol and UI wiring
 * only; it is not real-model qualification.
 */

export interface PermissionRuleView {
	readonly id: string;
	readonly decision: "allow" | "deny";
	readonly toolName: string;
	readonly command?: string;
}

export interface PermissionRulesView {
	readonly projectPath: string;
	readonly rules: readonly PermissionRuleView[];
}

/** Shared effective-rule view returned by permission/auto/get. */
export interface PermissionRuleSettingsView {
	readonly id: string;
	readonly kind: "command" | "tool" | "script" | "shell" | "compatibility";
	readonly origin: "default" | "user";
	readonly name: string;
	readonly enabled: boolean;
	readonly modes: readonly ("ask" | "auto")[];
	readonly scope: "workspace" | "directories" | "memory" | "session" | "declared" | "all";
	readonly directories: readonly string[];
	readonly command?: string;
	readonly toolName?: string;
	readonly allowNetwork: boolean;
	readonly networkTargets?: readonly { readonly hostname: string; readonly port: number }[];
	readonly support: "supported" | "legacy-unsupported";
	readonly supportReason?: string;
}

export interface PermissionAppDirs {
	readonly tempRoot: string;
	readonly agentDir: string;
	readonly homeDir: string;
	readonly projectDir: string;
	readonly outsideDir: string;
	readonly userDataDir: string;
}

interface DesktopMetisApi {
	createSession(input: {
		readonly requestId: string;
		readonly mode: "chat" | "code";
		readonly cwd: string;
		readonly permissionPreset?: "ask" | "auto" | "full";
	}): Promise<{ readonly session: { readonly sessionId: string } }>;
	setPermissionPreset(input: {
		readonly requestId: string;
		readonly sessionId: string;
		readonly permissionPreset: "ask" | "auto" | "full";
	}): Promise<unknown>;
	openSession(input: { readonly sessionId: string }): Promise<{ readonly sandboxHealth?: string }>;
	getPermissionAutoSettings(): Promise<{
		readonly rules: readonly { readonly command: string; readonly allowNetwork: boolean }[];
		readonly reviewerEnabled: boolean;
		readonly permissionRules?: readonly PermissionRuleSettingsView[];
		readonly permissionRuleDefaults?: readonly PermissionRuleSettingsView[];
	}>;
	updatePermissionAutoSettings(input: {
		readonly requestId: string;
		readonly rules?: readonly { readonly command: string; readonly allowNetwork: boolean }[];
		readonly permissionRules?: readonly Omit<PermissionRuleSettingsView, "support" | "supportReason">[];
		readonly reviewerEnabled?: boolean;
	}): Promise<{
		readonly rules: readonly { readonly command: string; readonly allowNetwork: boolean }[];
		readonly reviewerEnabled: boolean;
		readonly permissionRules?: readonly PermissionRuleSettingsView[];
		readonly permissionRuleDefaults?: readonly PermissionRuleSettingsView[];
	}>;
	listPermissionRules(input: {
		readonly sessionId: string;
		readonly scope?: "project" | "session";
	}): Promise<PermissionRulesView>;
	deletePermissionRule(input: {
		readonly requestId: string;
		readonly sessionId: string;
		readonly ruleId: string;
		readonly scope?: "project" | "session";
	}): Promise<PermissionRulesView>;
	clearPermissionRules(input: {
		readonly requestId: string;
		readonly sessionId: string;
		readonly scope?: "project" | "session";
	}): Promise<PermissionRulesView>;
	getPermissionSandboxHealth(): Promise<{ readonly status: string; readonly code: string }>;
	getModelSettings(): Promise<ModelSettingsLike>;
	updateModelSettings(input: {
		readonly requestId: string;
		readonly mutation: {
			readonly type: "set_permission_reviewer";
			readonly config: unknown;
			readonly credential?: unknown;
		};
	}): Promise<ModelSettingsLike>;
	testModelConnection(input: {
		readonly requestId: string;
		readonly kind: "permission-review";
	}): Promise<{ readonly ok: boolean; readonly latencyMs: number; readonly message: string }>;
	interruptTurn(input: { readonly requestId: string; readonly sessionId: string }): Promise<unknown>;
}

export interface ModelSettingsLike {
	readonly defaultModel: { readonly provider: string; readonly modelId: string } | null;
	readonly providers?: readonly { readonly provider: string; readonly modelId?: string }[];
	readonly permissionReviewer: {
		readonly config:
			| {
					readonly provider: string;
					readonly modelId: string;
					readonly thinkingLevel: string;
					readonly timeoutMs: number;
					readonly maxOutputTokens: number;
			  }
			| {
					readonly source: "dedicated";
					readonly name: string;
					readonly api: string;
					readonly baseUrl: string;
					readonly modelId: string;
					readonly thinkingLevel: string;
					readonly timeoutMs: number;
					readonly maxOutputTokens: number;
					readonly reasoningMode: "off" | "manual";
					readonly thinkingLevelMap?: Record<string, string | null>;
			  }
			| null;
		readonly status: "unconfigured" | "configured" | "invalid";
		readonly authConfigured?: boolean;
	};
}

export interface LaunchPermissionAppOptions {
	readonly mode?: "chat" | "code";
	readonly preset?: "ask" | "auto" | "full";
	/** Maps a prompt marker to the tool call the fake primary model issues. */
	readonly tools: (marker: string, dirs: PermissionAppDirs) => PermissionToolCall | undefined;
	readonly decide?: (payload: string) => ReviewDecision;
	readonly reviewMode?: ReviewMode;
	readonly reviewDelayMs?: number;
	readonly reviewer?: PermissionReviewerSeed;
	readonly locale?: "en" | "zh-CN";
	readonly extraSettings?: Record<string, unknown>;
	readonly env?: Record<string, string>;
	/** Extra files/process fixture setup inside the isolated temp workspace. */
	readonly seed?: (dirs: PermissionAppDirs) => Promise<void>;
}

export interface LaunchedPermissionApp {
	readonly page: Page;
	readonly provider: PermissionProvider;
	readonly projectDir: string;
	readonly outsideDir: string;
	readonly homeDir: string;
	readonly agentDir: string;
	readonly dirs: PermissionAppDirs;
	/** Local fake-provider endpoint; independent reviewer connections point here. */
	readonly providerBaseUrl: string;
	readonly sessionId: string;
	readonly diagnostics: string[];
	readonly approval: import("@playwright/test").Locator;
	close(): Promise<void>;
	submit(marker: string): Promise<void>;
	waitDone(marker: string): Promise<void>;
	setPreset(current: "Ask" | "Auto" | "Full", next: "Ask" | "Auto" | "Full"): Promise<void>;
	setReviewerEnabled(enabled: boolean): Promise<void>;
	relaunch(): Promise<void>;
	createSession(preset?: "ask" | "auto" | "full"): Promise<string>;
	openSession(sessionId: string): Promise<void>;
	openSettings(pageName?: string): Promise<void>;
	closeSettings(): Promise<void>;
	chooseApprovalOption(label: string): Promise<void>;
	allowOnce(): Promise<void>;
	reject(): Promise<void>;
	interrupt(): Promise<void>;
}

async function seedProject(projectDir: string, outsideDir: string, homeDir: string): Promise<void> {
	await Promise.all([
		writeFile(path.join(projectDir, "README.md"), "readme"),
		writeFile(path.join(outsideDir, "outside.txt"), "outside"),
		mkdir(path.join(projectDir, ".git"), { recursive: true }),
		mkdir(path.join(homeDir, ".ssh"), { recursive: true }),
	]);
	await writeFile(path.join(projectDir, ".git", "HEAD"), "ref: refs/heads/main");
	await writeFile(path.join(homeDir, ".ssh", "id_rsa"), "BEGIN PRIVATE KEY fixture");
}

export async function launchPermissionApp(options: LaunchPermissionAppOptions): Promise<LaunchedPermissionApp> {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
	const tempRoot = realpathSync(await mkdtemp(path.join(tmpdir(), "metis-permission-system-")));
	const dirs: PermissionAppDirs = {
		tempRoot,
		agentDir: path.join(tempRoot, "agent"),
		homeDir: path.join(tempRoot, "home"),
		projectDir: path.join(tempRoot, "project"),
		outsideDir: path.join(tempRoot, "outside"),
		userDataDir: path.join(tempRoot, "electron"),
	};
	await Promise.all([
		mkdir(dirs.agentDir),
		mkdir(dirs.homeDir),
		mkdir(dirs.projectDir),
		mkdir(dirs.outsideDir),
		mkdir(dirs.userDataDir),
	]);
	await seedProject(dirs.projectDir, dirs.outsideDir, dirs.homeDir);
	await options.seed?.(dirs);
	const importEsm = Function("specifier", "return import(specifier)") as (
		specifier: string,
	) => Promise<{ ProjectTrustStore: new (dir: string) => { set(cwd: string, trusted: boolean): void } }>;
	const trust = await importEsm(
		pathToFileURL(path.join(desktopRoot, "../coding-agent/dist/core/trust-manager.js")).href,
	);
	new trust.ProjectTrustStore(dirs.agentDir).set(dirs.projectDir, true);

	const provider = new PermissionProvider({
		tools: (marker) => options.tools(marker, dirs),
		decide: options.decide,
	});
	if (options.reviewMode) provider.reviewMode = options.reviewMode;
	if (options.reviewDelayMs) provider.reviewDelayMs = options.reviewDelayMs;
	const providerPort = await provider.listen();
	await provider.writeAgentConfig(dirs.agentDir, providerPort, {
		reviewer: options.reviewer,
		extraSettings: options.extraSettings,
	});

	const diagnostics: string[] = [];
	let app: ReturnType<typeof launchPackagedDesktop> | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;
	let sessionId = "";
	let localeApplied = options.locale === undefined;
	let pendingCompletion: { marker: string; count: number } | undefined;

	const open = async () => {
		const debuggingPort = await reservePort();
		app = launchPackagedDesktop({
			executable,
			debuggingPort,
			userDataDir: dirs.userDataDir,
			projectDir: dirs.projectDir,
			agentDir: dirs.agentDir,
			homeDir: dirs.homeDir,
			diagnostics,
			env: options.env,
		});
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(20_000);
		await waitForServerReady(page);
		// Preload can become ready before Electron's initial document navigation
		// finishes. Wait for the renderer before changing locale or reloading it.
		await page.locator(".account-menu-trigger").waitFor({ state: "visible" });
		if (!localeApplied && options.locale) {
			await page.evaluate((locale) => localStorage.setItem("metis.locale.v1", locale), options.locale);
			await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
			await waitForServerReady(page);
			localeApplied = true;
		}
		if (!sessionId) {
			sessionId = await page.evaluate(
				async ({ cwd, permissionPreset, mode }) => {
					const metis = (globalThis as unknown as { metis: DesktopMetisApi }).metis;
					const result = await metis.createSession({
						requestId: crypto.randomUUID(),
						mode,
						cwd,
						...(permissionPreset ? { permissionPreset } : {}),
					});
					localStorage.setItem(`metis.activeSessionId.${mode}`, result.session.sessionId);
					return result.session.sessionId;
				},
				{ cwd: dirs.projectDir, permissionPreset: options.preset, mode: options.mode ?? "chat" },
			);
			await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
			if (options.mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
			await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });
		} else {
			if (options.mode === "code") await page.getByRole("button", { name: "Code", exact: true }).click();
			await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });
		}
	};
	try {
		await open();
	} catch (error) {
		await browser?.close().catch(() => undefined);
		if (app) await stopProcess(app);
		await provider.close();
		await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		throw error;
	}

	const setActiveSession = async (id: string) => {
		await page!.evaluate(({ session, mode }) => localStorage.setItem(`metis.activeSessionId.${mode}`, session), { session: id, mode: options.mode ?? "chat" });
		await page!.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
		if (options.mode === "code") await page!.getByRole("button", { name: "Code", exact: true }).click();
		await page!.locator(`[data-active-session-id="${id}"]`).waitFor({ state: "visible" });
	};

	const launched: LaunchedPermissionApp = {
		get page() {
			return page!;
		},
		provider,
		projectDir: dirs.projectDir,
		outsideDir: dirs.outsideDir,
		homeDir: dirs.homeDir,
		agentDir: dirs.agentDir,
		dirs,
		providerBaseUrl: `http://127.0.0.1:${providerPort}/v1`,
		get sessionId() {
			return sessionId;
		},
		diagnostics,
		get approval() {
			return page!.locator(".permission-approval-panel");
		},
		async close() {
			if (app && browser) await quitPackagedApp({ app, browser });
			else if (app) await stopProcess(app);
			await provider.close();
			await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		},
		async submit(marker: string) {
			pendingCompletion = { marker, count: (await page!.getByText(`done:${marker}`, { exact: true }).count()) + 1 };
			const input = page!.locator("#composer-input");
			await expect(input).toHaveAttribute("contenteditable", "true");
			await input.click();
			await input.fill(marker);
			await page!.getByRole("button", { name: options.locale === "zh-CN" ? "发送消息" : "Send message", exact: true }).click();
		},
		async waitDone(marker: string) {
			const completion = page!.getByText(`done:${marker}`, { exact: true });
			if (pendingCompletion?.marker === marker) {
				await expect(completion).toHaveCount(pendingCompletion.count, { timeout: 45_000 });
			}
			await expect(completion.last()).toBeVisible({ timeout: 45_000 });
		},
		async setPreset(_current, next) {
			await page!.evaluate(
				async ({ session, permissionPreset }) => {
					const metis = (globalThis as unknown as { metis: DesktopMetisApi }).metis;
					await metis.setPermissionPreset({ sessionId: session, requestId: crypto.randomUUID(), permissionPreset });
				},
				{ session: sessionId, permissionPreset: next.toLowerCase() as "ask" | "auto" | "full" },
			);
			await expect(
				page!.getByRole("button", { name: `Select permissions, current ${next}`, exact: true }),
			).toBeVisible();
		},
		async setReviewerEnabled(enabled: boolean) {
			await page!.evaluate(
				async (value) => {
					const metis = (globalThis as unknown as { metis: DesktopMetisApi }).metis;
					await metis.updatePermissionAutoSettings({ requestId: crypto.randomUUID(), reviewerEnabled: value });
				},
				enabled,
			);
		},
		async relaunch() {
			if (app && browser) await quitPackagedApp({ app, browser });
			else if (app) await stopProcess(app);
			browser = undefined;
			app = undefined;
			await open();
		},
		async createSession(preset) {
			const id = await page!.evaluate(
				async ({ cwd, permissionPreset, mode }) => {
					const metis = (globalThis as unknown as { metis: DesktopMetisApi }).metis;
					const result = await metis.createSession({
						requestId: crypto.randomUUID(),
						mode,
						cwd,
						...(permissionPreset ? { permissionPreset } : {}),
					});
					localStorage.setItem(`metis.activeSessionId.${mode}`, result.session.sessionId);
					return result.session.sessionId;
				},
				{ cwd: dirs.projectDir, permissionPreset: preset, mode: options.mode ?? "chat" },
			);
			await setActiveSession(id);
			return id;
		},
		async openSession(id: string) {
			await setActiveSession(id);
		},
		async openSettings(pageName) {
			await page!.locator(".account-menu-trigger").click();
			await page!.getByRole("menuitem", { name: "Settings", exact: true }).click();
			await expect(page!.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
			if (pageName) {
				await page!.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: pageName, exact: true }).click();
				await expect(page!.getByRole("heading", { name: pageName, exact: true })).toBeVisible();
			}
		},
		async closeSettings() {
			await page!.getByRole("button", { name: "Back to app", exact: true }).click();
			await expect(page!.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
		},
		async chooseApprovalOption(label: string) {
			await page!.getByRole("button", { name: "More approval options", exact: true }).click();
			const menu = page!.getByRole("listbox", { name: "More approval options", exact: true });
			await expect(menu).toBeVisible();
			await menu.getByRole("option", { name: label, exact: true }).click();
		},
		async allowOnce() {
			await launched.approval.getByRole("button", { name: "Allow once", exact: true }).click();
		},
		async reject() {
			await launched.approval.getByRole("button", { name: /Reject/u }).click();
		},
		async interrupt() {
			await page!.getByRole("button", { name: "Stop task", exact: true }).first().click();
		},
	};
	return launched;
}
