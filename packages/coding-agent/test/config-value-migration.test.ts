import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { migrateAuthToAuthJson, runMigrations } from "../src/migrations.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "metis-config-value-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	it("leaves uppercase auth.json API key values unchanged", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" },
					openai: { type: "api_key", key: "$OPENAI_API_KEY" },
					opencode: { type: "api_key", key: "public" },
					github: { type: "oauth", access: "ACCESS_TOKEN", refresh: "REFRESH_TOKEN", expires: 1 },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
		expect(migrated.opencode.key).toBe("public");
		expect(migrated.github.access).toBe("ACCESS_TOKEN");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("does not follow a dangling auth.json symlink or retire oauth.json", () => {
		const agentDir = createAgentDir();
		const oauthPath = path.join(agentDir, "oauth.json");
		const migratedPath = `${oauthPath}.migrated`;
		const outsidePath = path.join(agentDir, "outside-auth.json");
		fs.writeFileSync(
			oauthPath,
			JSON.stringify({ github: { access: "access", refresh: "refresh", expires: 1 } }),
			"utf-8",
		);
		fs.symlinkSync(outsidePath, path.join(agentDir, "auth.json"));

		let providers: string[] = [];
		withAgentDir(agentDir, () => {
			providers = migrateAuthToAuthJson();
		});

		expect(providers).toEqual([]);
		expect(fs.existsSync(outsidePath)).toBe(false);
		expect(fs.existsSync(oauthPath)).toBe(true);
		expect(fs.existsSync(migratedPath)).toBe(false);
	});

	it("cleans a published auth alias before skipping an already completed migration", () => {
		const agentDir = createAgentDir();
		const authPath = path.join(agentDir, "auth.json");
		const publishedAlias = path.join(agentDir, ".auth.json.00000000-0000-4000-8000-000000000000.publish.tmp");
		const content = JSON.stringify({ openai: { type: "api_key", key: "preserved" } });
		fs.writeFileSync(authPath, content);
		fs.linkSync(authPath, publishedAlias);
		expect(fs.statSync(authPath).nlink).toBe(2);

		let providers: string[] = [];
		withAgentDir(agentDir, () => {
			providers = migrateAuthToAuthJson();
		});

		expect(providers).toEqual([]);
		expect(fs.readFileSync(authPath, "utf8")).toBe(content);
		expect(fs.statSync(authPath).nlink).toBe(1);
		expect(fs.existsSync(publishedAlias)).toBe(false);
	});

	it("does not read legacy OAuth or settings through symlinks", ({ skip }) => {
		for (const name of ["oauth.json", "settings.json"] as const) {
			const agentDir = createAgentDir();
			const outsidePath = path.join(agentDir, `outside-${name}`);
			const legacyPath = path.join(agentDir, name);
			const content =
				name === "oauth.json"
					? JSON.stringify({ github: { access: "outside-secret" } })
					: JSON.stringify({ apiKeys: { anthropic: "outside-secret" }, theme: "dark" });
			fs.writeFileSync(outsidePath, content);
			try {
				fs.symlinkSync(outsidePath, legacyPath);
			} catch (error) {
				if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
					skip("Creating symlinks requires Windows Developer Mode");
					return;
				}
				throw error;
			}

			let providers: string[] = [];
			withAgentDir(agentDir, () => {
				providers = migrateAuthToAuthJson();
			});

			expect(providers).toEqual([]);
			expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
			expect(fs.readFileSync(outsidePath, "utf8")).toBe(content);
			expect(fs.lstatSync(legacyPath).isSymbolicLink()).toBe(true);
		}
	});

	it("does not read legacy OAuth or settings through hard links", () => {
		for (const name of ["oauth.json", "settings.json"] as const) {
			const agentDir = createAgentDir();
			const outsidePath = path.join(agentDir, `outside-${name}`);
			const legacyPath = path.join(agentDir, name);
			const content =
				name === "oauth.json"
					? JSON.stringify({ github: { access: "outside-secret" } })
					: JSON.stringify({ apiKeys: { anthropic: "outside-secret" }, theme: "dark" });
			fs.writeFileSync(outsidePath, content);
			fs.linkSync(outsidePath, legacyPath);

			let providers: string[] = [];
			withAgentDir(agentDir, () => {
				providers = migrateAuthToAuthJson();
			});

			expect(providers).toEqual([]);
			expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
			expect(fs.readFileSync(outsidePath, "utf8")).toBe(content);
			expect(fs.statSync(legacyPath).nlink).toBe(2);
		}
	});

	it.skipIf(process.platform === "win32")("fails closed without blocking on legacy OAuth or settings FIFOs", () => {
		const moduleUrl = new URL("../src/migrations.ts", import.meta.url).href;
		const source = `
			import { migrateAuthToAuthJson } from ${JSON.stringify(moduleUrl)};
			const providers = migrateAuthToAuthJson();
			process.exit(providers.length === 0 ? 0 : 2);
		`;
		for (const name of ["oauth.json", "settings.json"] as const) {
			const agentDir = createAgentDir();
			const legacyPath = path.join(agentDir, name);
			execFileSync("mkfifo", [legacyPath]);
			const child = spawnSync(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "--eval", source],
				{
					env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
					timeout: 10_000,
				},
			);

			expect(child.error).toBeUndefined();
			expect(child.status).toBe(0);
			expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
			expect(fs.lstatSync(legacyPath).isFIFO()).toBe(true);
		}
	});

	it.skipIf(process.platform === "win32")("keeps settings API keys when auth.json cannot be created", () => {
		const agentDir = createAgentDir();
		const settingsPath = path.join(agentDir, "settings.json");
		const original = `${JSON.stringify({ apiKeys: { anthropic: "secret" }, theme: "dark" }, null, 2)}\n`;
		fs.writeFileSync(settingsPath, original, { encoding: "utf-8", mode: 0o600 });
		fs.chmodSync(agentDir, 0o500);

		try {
			let providers: string[] = [];
			withAgentDir(agentDir, () => {
				providers = migrateAuthToAuthJson();
			});
			expect(providers).toEqual([]);
			expect(fs.existsSync(path.join(agentDir, "auth.json"))).toBe(false);
			expect(fs.readFileSync(settingsPath, "utf-8")).toBe(original);
		} finally {
			fs.chmodSync(agentDir, 0o700);
		}
	});

	it.skipIf(process.platform === "win32")("rewrites migrated legacy settings with a private mode", () => {
		const agentDir = createAgentDir();
		const settingsPath = path.join(agentDir, "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ apiKeys: { anthropic: "secret" }, theme: "dark" }), {
			mode: 0o666,
		});

		withAgentDir(agentDir, () => {
			expect(migrateAuthToAuthJson()).toEqual(["anthropic"]);
		});

		expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
	});

	it("keeps oauth.json when retiring the source fails after auth.json is durable", () => {
		const agentDir = createAgentDir();
		const oauthPath = path.join(agentDir, "oauth.json");
		const original = JSON.stringify({ github: { access: "access", refresh: "refresh", expires: 1 } });
		fs.writeFileSync(oauthPath, original, "utf-8");
		fs.mkdirSync(`${oauthPath}.migrated`);

		let providers: string[] = [];
		withAgentDir(agentDir, () => {
			providers = migrateAuthToAuthJson();
		});

		expect(providers).toEqual(["github"]);
		expect(fs.readFileSync(oauthPath, "utf-8")).toBe(original);
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"))).toEqual({
			github: { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
		});
	});

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("does not throw on %s models.json during migrations", (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		withAgentDir(agentDir, () => expect(() => runMigrations(agentDir)).not.toThrow());

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const registry = ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = registry.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("leaves uppercase models.json API key and header values unchanged", async () => {
		const agentDir = createAgentDir();
		const envKeys = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}

		try {
			fs.writeFileSync(
				path.join(agentDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"custom-provider": {
								baseUrl: "https://example.com/v1",
								apiKey: "CUSTOM_API_KEY",
								api: "openai-completions",
								headers: {
									"x-api-key": "HEADER_API_KEY",
									"x-literal": "literal",
								},
								models: [
									{
										id: "model-a",
										headers: { "x-model-key": "MODEL_API_KEY" },
									},
								],
								modelOverrides: {
									"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
				providers: Record<
					string,
					{
						apiKey?: string;
						headers?: Record<string, string>;
						models?: Array<{ headers?: Record<string, string> }>;
						modelOverrides?: Record<string, { headers?: Record<string, string> }>;
					}
				>;
			};
			const provider = migrated.providers["custom-provider"]!;
			expect(provider.apiKey).toBe("CUSTOM_API_KEY");
			expect(provider.headers?.["x-api-key"]).toBe("HEADER_API_KEY");
			expect(provider.headers?.["x-literal"]).toBe("literal");
			expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("MODEL_API_KEY");
			expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("OVERRIDE_API_KEY");
			expect(logSpy).not.toHaveBeenCalled();

			const registry = ModelRegistry.create(
				AuthStorage.create(path.join(agentDir, "auth.json")),
				path.join(agentDir, "models.json"),
			);
			const model = registry.find("custom-provider", "model-a");
			expect(model).toBeDefined();
			expect(await registry.getApiKeyForProvider("custom-provider")).toBe("CUSTOM_API_KEY");
			expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
				ok: true,
				apiKey: "CUSTOM_API_KEY",
				headers: {
					"x-api-key": "HEADER_API_KEY",
					"x-literal": "literal",
					"x-model-key": "MODEL_API_KEY",
				},
			});
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});
