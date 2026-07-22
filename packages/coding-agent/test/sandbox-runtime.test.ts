import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig, WindowsSandboxUserStatus } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxGrant } from "../src/core/permission-policy.ts";
import {
	buildSandboxRuntimeConfig,
	quoteSandboxArg,
	type SandboxManagerAdapter,
	SandboxRuntimeCoordinator,
	type SandboxSpawn,
	sandboxArgvCommand,
	sensitiveEnvironmentNames,
} from "../src/core/sandbox-runtime.ts";
import { canonicalizeActionPath } from "../src/utils/paths.ts";

function grant(overrides: Partial<SandboxGrant> = {}): SandboxGrant {
	return {
		actionId: "action-1",
		sandbox: "read-only",
		denyReadPaths: [],
		capabilityReadPaths: [],
		capabilityWritePaths: [],
		readPaths: [],
		writePaths: [],
		networkTargets: [],
		fullOnce: false,
		...overrides,
	};
}

function completeWindowsStatus(overrides: Partial<WindowsSandboxUserStatus> = {}): WindowsSandboxUserStatus {
	return {
		provisioned: true,
		groupExists: true,
		inBuiltinUsers: true,
		inSandboxGroup: true,
		hiddenFromLogon: true,
		credPresent: true,
		markerVersion: 1,
		realUserSid: "S-1-5-21-test-user",
		...overrides,
	};
}

describe("SandboxRuntimeCoordinator", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arcmind-srt-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function fakeManager(
		events: string[],
		failures: Partial<Record<"reset" | "initialize" | "wrap" | "cleanup", Error>> = {},
	) {
		let resetCount = 0;
		let ask: ((target: { host: string; port?: number }) => Promise<boolean>) | undefined;
		let config: SandboxRuntimeConfig | undefined;
		const manager: SandboxManagerAdapter = {
			isSupportedPlatform: () => true,
			checkDependencies: () => ({ errors: [], warnings: [] }),
			reset: async () => {
				events.push("reset");
				resetCount++;
				if (failures.reset && resetCount === 1) throw failures.reset;
			},
			initialize: async (next, callback) => {
				events.push("initialize");
				config = next;
				ask = callback;
				if (failures.initialize) throw failures.initialize;
			},
			wrapWithSandboxArgv: async () => {
				events.push("wrap");
				if (failures.wrap) throw failures.wrap;
				return { argv: ["sandbox", "command"], env: { SANITIZED: "yes" } };
			},
			cleanupAfterCommand: async () => {
				events.push("cleanup");
				if (failures.cleanup) throw failures.cleanup;
			},
		};
		return { manager, getAsk: () => ask, getConfig: () => config };
	}

	function coordinator(
		events: string[],
		manager: SandboxManagerAdapter,
		spawnImpl: SandboxSpawn = async () => {
			events.push("spawn");
			return { exitCode: 0 };
		},
	) {
		return new SandboxRuntimeCoordinator({
			agentDir: root,
			manager,
			spawn: spawnImpl,
			acquireLock: async () => {
				events.push("lock");
				return async () => {
					events.push("release");
				};
			},
		});
	}

	function commandInput(overrides: Record<string, unknown> = {}) {
		return {
			command: "pwd",
			shell: "/bin/bash",
			cwd: root,
			grant: grant({ readPaths: [root] }),
			onData: () => {},
			...overrides,
		};
	}

	it("serializes the complete SRT lifecycle and uses the returned environment exactly", async () => {
		const events: string[] = [];
		const fake = fakeManager(events);
		let spawnInput: unknown;
		const runtime = coordinator(events, fake.manager, async (input) => {
			events.push("spawn");
			spawnInput = input;
			return { exitCode: 7 };
		});
		expect(await runtime.execute(commandInput())).toEqual({ exitCode: 7 });
		expect(events).toEqual(["lock", "reset", "initialize", "wrap", "spawn", "cleanup", "reset", "release"]);
		expect(spawnInput).toMatchObject({
			argv: ["sandbox", "command"],
			env: { SANITIZED: "yes" },
		});
		expect((spawnInput as { env: NodeJS.ProcessEnv }).env).not.toHaveProperty("PATH");
	});

	it("always resets and releases after initialize, wrap, spawn, or cleanup failure", async () => {
		for (const failure of ["initialize", "wrap", "spawn", "cleanup"] as const) {
			const events: string[] = [];
			const fake = fakeManager(events, failure === "spawn" ? {} : { [failure]: new Error(`${failure} failed`) });
			const runtime = coordinator(events, fake.manager, async () => {
				events.push("spawn");
				if (failure === "spawn") throw new Error("spawn failed");
				return { exitCode: 1 };
			});
			await expect(runtime.execute(commandInput()), failure).rejects.toThrow(`${failure} failed`);
			expect(events.at(-2), failure).toBe("reset");
			expect(events.at(-1), failure).toBe("release");
			expect(events, failure).toContain("cleanup");
		}
	});

	it("attempts final cleanup even when the stale reset fails", async () => {
		const events: string[] = [];
		const fake = fakeManager(events, { reset: new Error("stale reset failed") });
		await expect(coordinator(events, fake.manager).execute(commandInput())).rejects.toThrow("stale reset failed");
		expect(events).toEqual(["lock", "reset", "cleanup", "reset", "release"]);
	});

	it("serializes concurrent calls in FIFO order and rebuilds wider profiles", async () => {
		const events: string[] = [];
		const configs: SandboxRuntimeConfig[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let call = 0;
		const manager = fakeManager(events).manager;
		const initialize = manager.initialize.bind(manager);
		manager.initialize = async (config, ask) => {
			configs.push(config);
			await initialize(config, ask);
		};
		const runtime = coordinator(events, manager, async () => {
			call++;
			events.push(`spawn-${call}`);
			if (call === 1) await firstGate;
			return { exitCode: 0 };
		});
		const first = runtime.execute(commandInput());
		const second = runtime.execute(
			commandInput({ grant: grant({ sandbox: "exact", readPaths: [root], writePaths: [join(root, "outside")] }) }),
		);
		await vi.waitFor(() => expect(events).toContain("spawn-1"));
		expect(events).not.toContain("spawn-2");
		releaseFirst();
		await Promise.all([first, second]);
		expect(events.indexOf("release")).toBeLessThan(events.indexOf("spawn-2"));
		const outside = canonicalizeActionPath(join(root, "outside"), root);
		expect(configs[0]!.filesystem.allowWrite).not.toContain(outside);
		expect(configs[1]!.filesystem.allowWrite).toContain(outside);
	});

	it("permits only exact normalized network host and port pairs, including redirects", async () => {
		const events: string[] = [];
		const fake = fakeManager(events);
		const runtime = coordinator(events, fake.manager, async () => {
			const ask = fake.getAsk()!;
			expect(await ask({ host: "EXAMPLE.COM.", port: 443 })).toBe(true);
			expect(await ask({ host: "example.com", port: 80 })).toBe(false);
			expect(await ask({ host: "redirect.example", port: 443 })).toBe(false);
			expect(await ask({ host: "example.com" })).toBe(false);
			return { exitCode: 0 };
		});
		await runtime.execute(
			commandInput({ grant: grant({ readPaths: [root], networkTargets: [{ host: "example.com", port: 443 }] }) }),
		);
	});

	it("builds deny-by-default credential and write profiles", () => {
		const config = buildSandboxRuntimeConfig(grant({ writePaths: [root] }), root);
		expect(config.network).toMatchObject({
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: false,
			allowLocalBinding: false,
		});
		expect(config.filesystem.allowRead).not.toContain(canonicalizeActionPath(root, root));
		expect(config.filesystem.allowWrite).toContain(canonicalizeActionPath(root, root));
		expect(config.filesystem.denyRead.length).toBeGreaterThan(0);
		expect(config.filesystem.denyWrite.length).toBeGreaterThan(0);
		expect(config.filesystem.denyRead).toContain(canonicalizeActionPath(join(homedir(), ".git-credentials"), root));
		expect(config.filesystem.denyRead).toContain(canonicalizeActionPath(join(root, ".env.local"), root));
		expect(config.credentials?.envVars?.map((item) => item.name)).toContain("ANTHROPIC_API_KEY");
		expect(config.credentials?.allowPlaintextInject).toBe(false);
		expect(config.enableWeakerNestedSandbox).toBe(false);
		expect(config.enableWeakerNetworkIsolation).toBe(false);
		expect(config.allowAppleEvents).toBe(false);
	});

	it("denies sibling workspace reads while re-allowing assigned child roots", () => {
		const assigned = join(root, "frontend");
		const config = buildSandboxRuntimeConfig(
			grant({
				denyReadPaths: [root],
				capabilityReadPaths: [assigned],
				capabilityWritePaths: [assigned],
			}),
			assigned,
		);

		expect(config.filesystem.denyRead).toContain(canonicalizeActionPath(root, assigned));
		expect(config.filesystem.allowRead).toContain(canonicalizeActionPath(assigned, assigned));
		expect(config.filesystem.allowWrite).toContain(canonicalizeActionPath(assigned, assigned));
		expect(config.credentials?.files?.map((item) => item.path)).toContain(
			canonicalizeActionPath(join(assigned, ".env"), assigned),
		);
	});

	it("strips fixed credentials and credential-like environment suffixes", () => {
		expect(
			sensitiveEnvironmentNames({
				PATH: "/bin",
				ACME_API_KEY: "secret",
				SERVICE_ACCESS_TOKEN: "secret",
				DB_PASSWORD: "secret",
			}),
		).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ACME_API_KEY", "SERVICE_ACCESS_TOKEN", "DB_PASSWORD"]));
		expect(sensitiveEnvironmentNames({ PATH: "/bin" })).not.toContain("PATH");
	});

	it("refuses sensitive writes and SRT execution for Full-once grants", () => {
		expect(() => buildSandboxRuntimeConfig(grant({ writePaths: [join(root, ".env")] }), root)).toThrow(
			"Sensitive writes require",
		);
		expect(() => buildSandboxRuntimeConfig(grant({ sandbox: "none", fullOnce: true }), root)).toThrow("bypass SRT");
	});

	it("quotes literal helper argv without interpolating shell operators", () => {
		expect(quoteSandboxArg("a'b")).toBe("'a'\"'\"'b'");
		expect(sandboxArgvCommand("/path with space/rg", ["--", "a b", "x; rm -rf /", "中文", "-leading"])).toBe(
			"'/path with space/rg' '--' 'a b' 'x; rm -rf /' '中文' '-leading'",
		);
	});

	it("fails closed on unsupported platforms or missing dependencies", async () => {
		const manager = fakeManager([]).manager;
		manager.isSupportedPlatform = () => false;
		await expect(coordinator([], manager).execute(commandInput())).rejects.toThrow("does not support");
		manager.isSupportedPlatform = () => true;
		manager.checkDependencies = () => ({ errors: ["bubblewrap missing"], warnings: [] });
		await expect(coordinator([], manager).execute(commandInput())).rejects.toThrow("bubblewrap missing");
	});

	it("requires explicit Windows setup approval and rejects cancellation or partial installs", async () => {
		const incomplete = completeWindowsStatus({ credPresent: false });
		const manager = fakeManager([]).manager;
		const denied = new SandboxRuntimeCoordinator({
			agentDir: root,
			manager,
			platform: "win32",
			windows: {
				getStatus: () => incomplete,
				install: () => ({ user: incomplete, wfp: { state: "absent", filters: 0 } }),
			},
			requestWindowsSetup: async () => false,
		});
		await expect(denied.execute(commandInput())).rejects.toThrow("requires user approval");

		const cancelled = new SandboxRuntimeCoordinator({
			agentDir: root,
			manager,
			platform: "win32",
			windows: {
				getStatus: () => incomplete,
				install: () => ({ cancelled: true, user: incomplete, wfp: { state: "absent", filters: 0 } }),
			},
			requestWindowsSetup: async () => true,
		});
		await expect(cancelled.execute(commandInput())).rejects.toThrow("cancelled");
	});
});
