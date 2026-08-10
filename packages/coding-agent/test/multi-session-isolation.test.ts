import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage } from "@metis/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession, type ExtensionFactory } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const PROVIDER_ID = "shared-test-provider";
const MODEL_ID = "shared-test-model";

interface RuntimeFixture {
	label: string;
	root: string;
	runtime: AgentSessionRuntime;
	capturedApiKeys: Array<string | undefined>;
	capturedSystemPrompts: string[];
}

interface ExtensionLoadState {
	alpha?: number;
	beta?: number;
}

interface StreamGate {
	waitUntilStarted(): Promise<void>;
	blockUntilReleased(): Promise<void>;
	release(): void;
}

function createStreamGate(expectedStarts: number): StreamGate {
	let started = 0;
	let released = false;
	let resolveStarted!: () => void;
	let resolveRelease!: () => void;
	const startedPromise = new Promise<void>((resolve) => {
		resolveStarted = resolve;
	});
	const releasePromise = new Promise<void>((resolve) => {
		resolveRelease = resolve;
	});

	return {
		waitUntilStarted: () => startedPromise,
		async blockUntilReleased() {
			if (released) return;
			started++;
			if (started === expectedStarts) {
				resolveStarted();
			}
			await releasePromise;
		},
		release() {
			released = true;
			resolveRelease();
		},
	};
}

function extensionLoadState(): ExtensionLoadState {
	const global = globalThis as typeof globalThis & { __multiSessionExtensionLoads?: ExtensionLoadState };
	if (!global.__multiSessionExtensionLoads) {
		global.__multiSessionExtensionLoads = {};
	}
	return global.__multiSessionExtensionLoads;
}

function resetExtensionLoadState(): void {
	delete (globalThis as typeof globalThis & { __multiSessionExtensionLoads?: ExtensionLoadState })
		.__multiSessionExtensionLoads;
}

function assistantTexts(runtime: AgentSessionRuntime): string[] {
	return runtime.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(""),
		);
}

describe("multi-session runtime isolation", () => {
	const roots: string[] = [];
	const runtimes: AgentSessionRuntime[] = [];

	afterEach(async () => {
		while (runtimes.length > 0) {
			await runtimes.pop()?.dispose();
		}
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetExtensionLoadState();
	});

	async function createRuntimeFixture(label: string, streamGate: StreamGate): Promise<RuntimeFixture> {
		const root = join(tmpdir(), `metis-multi-session-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), `${label}-project-marker\n`, "utf8");
		roots.push(root);

		const authStorage = AuthStorage.inMemory();
		authStorage.set(PROVIDER_ID, {
			type: "oauth",
			access: `${label}-access`,
			refresh: `${label}-refresh`,
			expires: Date.now() + 60_000,
		});

		const capturedApiKeys: Array<string | undefined> = [];
		const capturedSystemPrompts: string[] = [];
		const faux = createFauxCore({
			api: "openai-completions",
			provider: PROVIDER_ID,
			models: [{ id: MODEL_ID, name: `${label} model`, reasoning: false }],
		});
		const response = async () => {
			await streamGate.blockUntilReleased();
			return fauxAssistantMessage(`${label}-reply`);
		};
		faux.setResponses(Array.from({ length: 8 }, () => response));
		const extensionFactory: ExtensionFactory = (metis) => {
			metis.registerProvider(PROVIDER_ID, {
				name: `${label} provider`,
				baseUrl: `https://${label}.invalid/v1`,
				api: "openai-completions",
				streamSimple: (model, context, options) => {
					capturedApiKeys.push(options?.apiKey);
					capturedSystemPrompts.push(context.systemPrompt ?? "");
					return faux.streamSimple(model, context, options);
				},
				oauth: {
					name: `${label} OAuth`,
					login: async () => ({
						access: `${label}-access`,
						refresh: `${label}-refresh`,
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => `${label}:${credentials.access}`,
				},
				models: [
					{
						id: MODEL_ID,
						name: `${label} model`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					},
				],
			});
		};

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [extensionFactory],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const model = services.modelRegistry.find(PROVIDER_ID, MODEL_ID);
			if (!model) {
				throw new Error(`Missing ${label} test model`);
			}
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, sessionDir),
		});
		await runtime.session.bindExtensions({});
		runtimes.push(runtime);
		return { label, root, runtime, capturedApiKeys, capturedSystemPrompts };
	}

	async function disposeFixture(fixture: RuntimeFixture): Promise<void> {
		const index = runtimes.indexOf(fixture.runtime);
		if (index >= 0) {
			runtimes.splice(index, 1);
		}
		await fixture.runtime.dispose();
	}

	it("keeps concurrent streams, OAuth, queues, histories, reload, and disposal session-local", async () => {
		const streamGate = createStreamGate(2);
		const alpha = await createRuntimeFixture("alpha", streamGate);
		const beta = await createRuntimeFixture("beta", streamGate);

		expect(alpha.runtime.services.modelRegistry.getProviderDisplayName(PROVIDER_ID)).toBe("alpha provider");
		expect(beta.runtime.services.modelRegistry.getProviderDisplayName(PROVIDER_ID)).toBe("beta provider");
		expect(
			alpha.runtime.services.authStorage.getOAuthProviders().find((provider) => provider.id === PROVIDER_ID)?.name,
		).toBe("alpha OAuth");
		expect(
			beta.runtime.services.authStorage.getOAuthProviders().find((provider) => provider.id === PROVIDER_ID)?.name,
		).toBe("beta OAuth");

		const alphaEvents: string[] = [];
		const betaEvents: string[] = [];
		alpha.runtime.session.subscribe((event) => alphaEvents.push(event.type));
		beta.runtime.session.subscribe((event) => betaEvents.push(event.type));

		const alphaPrompt = alpha.runtime.session.prompt("alpha prompt");
		const betaPrompt = beta.runtime.session.prompt("beta prompt");
		await streamGate.waitUntilStarted();
		await Promise.all([
			alpha.runtime.session.followUp("alpha follow-up"),
			beta.runtime.session.followUp("beta follow-up"),
		]);
		expect(alpha.runtime.session.getFollowUpMessages()).toEqual(["alpha follow-up"]);
		expect(beta.runtime.session.getFollowUpMessages()).toEqual(["beta follow-up"]);
		expect(alpha.runtime.session.clearQueue()).toEqual({ steering: [], followUp: ["alpha follow-up"] });
		expect(beta.runtime.session.getFollowUpMessages()).toEqual(["beta follow-up"]);
		await alpha.runtime.session.followUp("alpha follow-up");
		streamGate.release();
		await Promise.all([alphaPrompt, betaPrompt]);

		expect(assistantTexts(alpha.runtime)).toEqual(["alpha-reply", "alpha-reply"]);
		expect(assistantTexts(beta.runtime)).toEqual(["beta-reply", "beta-reply"]);
		expect(alpha.capturedApiKeys).toEqual(["alpha:alpha-access", "alpha:alpha-access"]);
		expect(beta.capturedApiKeys).toEqual(["beta:beta-access", "beta:beta-access"]);
		expect(alpha.capturedSystemPrompts.every((prompt) => prompt.includes("alpha-project-marker"))).toBe(true);
		expect(alpha.capturedSystemPrompts.every((prompt) => !prompt.includes("beta-project-marker"))).toBe(true);
		expect(beta.capturedSystemPrompts.every((prompt) => prompt.includes("beta-project-marker"))).toBe(true);
		expect(beta.capturedSystemPrompts.every((prompt) => !prompt.includes("alpha-project-marker"))).toBe(true);
		expect(alphaEvents.filter((event) => event === "agent_end")).toHaveLength(1);
		expect(betaEvents.filter((event) => event === "agent_end")).toHaveLength(1);
		expect(alpha.runtime.cwd).toBe(join(alpha.root, "project"));
		expect(beta.runtime.cwd).toBe(join(beta.root, "project"));
		expect(alpha.runtime.session.sessionFile).toContain(join(alpha.root, "sessions"));
		expect(beta.runtime.session.sessionFile).toContain(join(beta.root, "sessions"));

		const alphaHistory = JSON.stringify(alpha.runtime.session.sessionManager.buildSessionContext().messages);
		const betaHistory = JSON.stringify(beta.runtime.session.sessionManager.buildSessionContext().messages);
		expect(alphaHistory).toContain("alpha prompt");
		expect(alphaHistory).toContain("alpha follow-up");
		expect(alphaHistory).not.toContain("beta prompt");
		expect(betaHistory).toContain("beta prompt");
		expect(betaHistory).toContain("beta follow-up");
		expect(betaHistory).not.toContain("alpha prompt");

		await alpha.runtime.session.reload();
		await beta.runtime.session.prompt("beta after alpha reload");
		expect(assistantTexts(beta.runtime).at(-1)).toBe("beta-reply");
		expect(beta.capturedApiKeys.at(-1)).toBe("beta:beta-access");

		await disposeFixture(beta);
		await alpha.runtime.session.prompt("alpha after beta dispose");
		expect(assistantTexts(alpha.runtime).at(-1)).toBe("alpha-reply");
		expect(alpha.capturedApiKeys.at(-1)).toBe("alpha:alpha-access");
	});

	it("keeps each resource loader's extension-module cache independent", async () => {
		function createLoader(label: "alpha" | "beta") {
			const root = join(
				tmpdir(),
				`metis-multi-session-extension-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			const extensionDir = join(agentDir, "extensions");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(extensionDir, { recursive: true });
			writeFileSync(
				join(extensionDir, "isolation.ts"),
				`const state = (globalThis.__multiSessionExtensionLoads ??= {});\nstate.${label} = (state.${label} ?? 0) + 1;\nexport default function (metis) { metis.registerCommand("${label}-only", { description: "${label}", handler: async () => {} }); }\n`,
				"utf8",
			);
			roots.push(root);
			return new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
		}

		const alphaLoader = createLoader("alpha");
		const betaLoader = createLoader("beta");
		await alphaLoader.reload();
		await betaLoader.reload();
		expect(extensionLoadState()).toEqual({ alpha: 1, beta: 1 });
		expect(Array.from(alphaLoader.getExtensions().extensions[0]?.commands.keys() ?? [])).toEqual(["alpha-only"]);
		expect(Array.from(betaLoader.getExtensions().extensions[0]?.commands.keys() ?? [])).toEqual(["beta-only"]);

		const alphaTrustExtensions = await alphaLoader.loadProjectTrustExtensions();

		expect(extensionLoadState()).toEqual({ alpha: 1, beta: 1 });
		expect(Array.from(alphaTrustExtensions.extensions[0]?.commands.keys() ?? [])).toEqual(["alpha-only"]);
		alphaLoader.dispose();
		await betaLoader.loadProjectTrustExtensions();
		expect(extensionLoadState()).toEqual({ alpha: 1, beta: 1 });
	});

	it("rejects services assembled from different auth-storage ownership boundaries", async () => {
		const root = join(tmpdir(), `metis-multi-session-ownership-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);

		const registryAuthStorage = AuthStorage.inMemory();
		const unrelatedAuthStorage = AuthStorage.inMemory();
		const modelRegistry = ModelRegistry.inMemory(registryAuthStorage);
		const options = {
			cwd,
			agentDir,
			authStorage: unrelatedAuthStorage,
			modelRegistry,
		};

		await expect(createAgentSessionServices(options)).rejects.toThrow(
			"authStorage must match modelRegistry.authStorage",
		);
		await expect(createAgentSession(options)).rejects.toThrow("authStorage must match modelRegistry.authStorage");

		const services = await createAgentSessionServices({ cwd, agentDir, modelRegistry });
		expect(services.authStorage).toBe(registryAuthStorage);
		services.resourceLoader.dispose?.();
	});

	it("disposes its resource loader when service creation fails", async () => {
		const root = join(tmpdir(), `metis-service-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		const dispose = vi.spyOn(DefaultResourceLoader.prototype, "dispose");

		await expect(
			createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderReloadOptions: {
					resolveProjectTrust: async () => {
						throw new Error("trust resolution failed");
					},
				},
			}),
		).rejects.toThrow("trust resolution failed");
		expect(dispose).toHaveBeenCalledOnce();
		dispose.mockRestore();
	});

	it("does not dispose an externally supplied service loader when session creation fails", async () => {
		const root = join(tmpdir(), `metis-external-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		roots.push(root);
		const services = await createAgentSessionServices({ cwd, agentDir });
		const dispose = vi.spyOn(services.resourceLoader, "dispose");
		const sessionManager = SessionManager.inMemory(cwd);
		vi.spyOn(sessionManager, "buildSessionContext").mockImplementation(() => {
			throw new Error("session creation failed");
		});

		await expect(createAgentSessionFromServices({ services, sessionManager })).rejects.toThrow(
			"session creation failed",
		);
		expect(dispose).not.toHaveBeenCalled();
		dispose.mockRestore();
		services.resourceLoader.dispose?.();
		sessionManager.close();
	});

	it("shares a credential file without sharing OAuth provider routing", async () => {
		const root = join(
			tmpdir(),
			`metis-multi-session-auth-backend-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(root, { recursive: true });
		roots.push(root);

		const authPath = join(root, "auth.json");
		const alphaAuthStorage = AuthStorage.create(authPath);
		const betaAuthStorage = AuthStorage.create(authPath);
		alphaAuthStorage.set(PROVIDER_ID, {
			type: "oauth",
			access: "shared-access",
			refresh: "shared-refresh",
			expires: Date.now() + 60_000,
		});
		betaAuthStorage.reload();

		const alphaRegistry = ModelRegistry.inMemory(alphaAuthStorage);
		const betaRegistry = ModelRegistry.inMemory(betaAuthStorage);
		const oauthConfig = (label: string) => ({
			oauth: {
				name: `${label} OAuth`,
				login: async () => ({ access: "", refresh: "", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials: { access: string; refresh: string; expires: number }) => credentials,
				getApiKey: (credentials: { access: string }) => `${label}:${credentials.access}`,
			},
		});

		alphaRegistry.registerProvider(PROVIDER_ID, oauthConfig("alpha"));
		betaRegistry.registerProvider(PROVIDER_ID, oauthConfig("beta"));

		expect(alphaAuthStorage.getOAuthProvider(PROVIDER_ID)?.name).toBe("alpha OAuth");
		expect(betaAuthStorage.getOAuthProvider(PROVIDER_ID)?.name).toBe("beta OAuth");
		expect(await alphaAuthStorage.getApiKey(PROVIDER_ID)).toBe("alpha:shared-access");
		expect(await betaAuthStorage.getApiKey(PROVIDER_ID)).toBe("beta:shared-access");

		alphaRegistry.refresh();
		expect(betaAuthStorage.getOAuthProvider(PROVIDER_ID)?.name).toBe("beta OAuth");
	});
});
