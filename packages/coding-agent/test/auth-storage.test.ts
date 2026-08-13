import { spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@metis/ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AuthStorage,
	InMemoryAuthStorageBackend,
	legacyMcpCredentialKey,
	mcpCredentialKey,
} from "../src/core/auth-storage.ts";
import { clearConfigValueCache, resolveConfigValueUncached } from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `metis-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	test("round-trips a namespaced MCP static credential without exposing its value in status", () => {
		const storage = AuthStorage.inMemory();
		const key = mcpCredentialKey({ scope: "user", name: "docs" });
		storage.set(key, {
			type: "mcp_secret",
			bearerToken: "stored-secret",
			env: { DOCS_TOKEN: "stdio-secret" },
		});

		expect(storage.get(key)).toEqual({
			type: "mcp_secret",
			bearerToken: "stored-secret",
			env: { DOCS_TOKEN: "stdio-secret" },
		});
		expect(JSON.stringify(storage.getAuthStatus(key))).not.toContain("stored-secret");
		expect(JSON.stringify(storage.getAuthStatus(key))).not.toContain("stdio-secret");
	});

	test("isolates user and canonical project MCP credentials", () => {
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir);
		const user = mcpCredentialKey({ scope: "user", name: "github" });
		const project = mcpCredentialKey({ scope: "project", name: "github", cwd: projectDir });
		const aliased = mcpCredentialKey({ scope: "project", name: "github", cwd: join(projectDir, ".") });

		expect(user).toBe("mcp:v2:user:github");
		expect(project).toBe(aliased);
		expect(project).toMatch(/^mcp:v2:project:[a-f0-9]{64}:github$/u);
		expect(project).not.toBe(user);
	});

	test("applies multiple credential changes with one persistence notification", () => {
		const persisted = vi.fn();
		const backend = new InMemoryAuthStorageBackend();
		const storage = AuthStorage.fromStorage(backend, persisted);
		const legacyKey = legacyMcpCredentialKey("github");
		const userKey = mcpCredentialKey({ scope: "user", name: "github" });
		const docsKey = mcpCredentialKey({ scope: "user", name: "docs" });
		const legacy = { type: "mcp_secret", bearerToken: "legacy" } as const;
		const docs = { type: "mcp_secret", env: { DOCS_TOKEN: "docs" } } as const;
		storage.set(legacyKey, legacy);
		persisted.mockClear();

		storage.applyChanges([
			{ provider: legacyKey, credential: undefined },
			{ provider: userKey, credential: legacy },
			{ provider: docsKey, credential: docs },
		]);

		expect(persisted).toHaveBeenCalledTimes(1);
		expect(storage.get(legacyKey)).toBeUndefined();
		expect(storage.get(userKey)).toEqual(legacy);
		expect(storage.get(docsKey)).toEqual(docs);
		const secondView = AuthStorage.fromStorage(backend);
		expect(secondView.get(legacyKey)).toBeUndefined();
		expect(secondView.get(userKey)).toEqual(legacy);
		expect(secondView.get(docsKey)).toEqual(docs);
	});

	test("supports auth storage beneath an existing symlinked agent directory", ({ skip }) => {
		const targetDirectory = join(tempDir, "agent-target");
		const linkedDirectory = join(tempDir, "agent-link");
		mkdirSync(targetDirectory);
		try {
			symlinkSync(targetDirectory, linkedDirectory, "dir");
		} catch (error) {
			if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
				skip("Creating directory symlinks requires Windows Developer Mode");
				return;
			}
			throw error;
		}
		const linkedAuthPath = join(linkedDirectory, "auth.json");
		const storage = AuthStorage.create(linkedAuthPath);

		expect(storage.drainErrors()).toEqual([]);
		storage.set("openai", { type: "api_key", key: "test-key" });
		expect(JSON.parse(readFileSync(join(targetDirectory, "auth.json"), "utf8"))).toEqual({
			openai: { type: "api_key", key: "test-key" },
		});
	});

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "$TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey env bag takes precedence over process.env", async () => {
			const originalEnv = process.env.TEST_AUTH_SCOPED_API_KEY_12345;
			process.env.TEST_AUTH_SCOPED_API_KEY_12345 = "process-env-value";

			try {
				writeAuthJson({
					anthropic: {
						type: "api_key",
						key: "$TEST_AUTH_SCOPED_API_KEY_12345",
						env: { TEST_AUTH_SCOPED_API_KEY_12345: "credential-env-value" },
					},
				});

				authStorage = AuthStorage.create(authJsonPath);

				expect(await authStorage.getApiKey("anthropic")).toBe("credential-env-value");
				expect(authStorage.getProviderEnv("anthropic")).toEqual({
					TEST_AUTH_SCOPED_API_KEY_12345: "credential-env-value",
				});
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_SCOPED_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_SCOPED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_BRACED_API_KEY_12345;
			process.env.TEST_AUTH_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "$" + "{TEST_AUTH_BRACED_API_KEY_12345}";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: bracedKey },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_AUTH_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_AUTH_INTERPOLATED_PART_B_12345;
			process.env.TEST_AUTH_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_AUTH_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = [
				"$",
				"{TEST_AUTH_INTERPOLATED_PART_A_12345}_$",
				"{TEST_AUTH_INTERPOLATED_PART_B_12345}",
			].join("");

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: interpolatedKey },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_AUTH_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_AUTH_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_AUTH_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_AUTH_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "$$TEST_AUTH_API_KEY_12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("$TEST_AUTH_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "$!literal-$TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain API key is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("TEST_AUTH_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("literal public API key is not corrupted by the Windows PUBLIC env var", async () => {
			const originalPublic = process.env.PUBLIC;
			process.env.PUBLIC = "C:\\Users\\Public";

			try {
				writeAuthJson({
					opencode: { type: "api_key", key: "public" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("opencode");

				expect(apiKey).toBe("public");
			} finally {
				if (originalPublic === undefined) {
					delete process.env.PUBLIC;
				} else {
					process.env.PUBLIC = originalPublic;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		test("command config uses stdin when configured shell requires it", () => {
			if (process.platform === "win32") return;
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: "/bin/bash",
				args: ["-s"],
				commandTransport: "stdin",
			});

			try {
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});
				const nameExpansion = "$" + "{name}";

				expect(resolveConfigValueUncached(`!name='World'; echo "Hello, ${nameExpansion}!"`)).toBe("Hello, World!");
			} finally {
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				// Use a command that writes to a file to count invocations
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				// Command should have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				// Create multiple AuthStorage instances
				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				// Command should still have only run once
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				// Clear cache and call again
				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				// Command should have run twice
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				// Call multiple times - all should return undefined
				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				// Command should have only run once despite failures
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: `$${envVarName}` },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("snapshots legacy OAuth providers without following later global mutations", () => {
			const providerId = `legacy-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Legacy OAuth Provider",
				async login() {
					return { access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
				},
				async refreshToken(credentials) {
					return credentials;
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});

			try {
				authStorage = AuthStorage.create(authJsonPath);
				expect(authStorage.getOAuthProvider(providerId)?.name).toBe("Legacy OAuth Provider");

				unregisterOAuthProvider(providerId);
				expect(authStorage.getOAuthProvider(providerId)?.name).toBe("Legacy OAuth Provider");
				authStorage.resetOAuthProviders();
				expect(authStorage.getOAuthProvider(providerId)?.name).toBe("Legacy OAuth Provider");
			} finally {
				unregisterOAuthProvider(providerId);
			}
		});

		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});
			authStorage = AuthStorage.create(authJsonPath);
			authStorage.registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("creates auth.json with private permissions", () => {
			authStorage = AuthStorage.create(authJsonPath);

			expect(readFileSync(authJsonPath, "utf-8")).toBe("{}");
			if (process.platform !== "win32") {
				expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
			}
		});

		test("recovers a published auth file after a crash leaves its temporary hard link", () => {
			const publishedAlias = join(tempDir, ".auth.json.00000000-0000-4000-8000-000000000000.publish.tmp");
			writeAuthJson({ openai: { type: "api_key", key: "preserved" } });
			linkSync(authJsonPath, publishedAlias);
			expect(statSync(authJsonPath).nlink).toBe(2);

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.get("openai")).toEqual({ type: "api_key", key: "preserved" });
			expect(authStorage.drainErrors()).toEqual([]);
			expect(statSync(authJsonPath).nlink).toBe(1);
			expect(existsSync(publishedAlias)).toBe(false);
		});

		test("does not remove a hard link outside the publish helper namespace", () => {
			const unrelatedAlias = join(tempDir, ".auth.json.backup.publish.tmp");
			writeAuthJson({ openai: { type: "api_key", key: "untrusted-alias" } });
			linkSync(authJsonPath, unrelatedAlias);

			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.get("openai")).toBeUndefined();
			expect(authStorage.drainErrors()).not.toHaveLength(0);
			expect(statSync(authJsonPath).nlink).toBe(2);
			expect(existsSync(unrelatedAlias)).toBe(true);
		});

		test.skipIf(process.platform === "win32")("refuses to initialize through a dangling symlink", () => {
			const outsidePath = join(tempDir, "outside-auth.json");
			symlinkSync(outsidePath, authJsonPath);

			authStorage = AuthStorage.create(authJsonPath);

			expect(existsSync(outsidePath)).toBe(false);
			expect(lstatSync(authJsonPath).isSymbolicLink()).toBe(true);
		});

		test("rejects credentials read through an auth symlink", ({ skip }) => {
			const outsidePath = join(tempDir, "outside-auth.json");
			writeFileSync(outsidePath, JSON.stringify({ anthropic: { type: "api_key", key: "injected" } }), "utf-8");
			try {
				symlinkSync(outsidePath, authJsonPath);
			} catch (error) {
				if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
					skip("Creating symlinks requires Windows Developer Mode");
					return;
				}
				throw error;
			}
			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.get("anthropic")).toBeUndefined();
			expect(authStorage.drainErrors()).not.toHaveLength(0);
			expect(() => authStorage.set("openai", { type: "api_key", key: "secret" })).toThrow(
				"Cannot update auth storage because it could not be loaded",
			);
			expect(lstatSync(authJsonPath).isSymbolicLink()).toBe(true);
		});

		test("rejects credentials read through a hard-linked auth file", () => {
			const outsidePath = join(tempDir, "outside-auth.json");
			writeFileSync(outsidePath, JSON.stringify({ anthropic: { type: "api_key", key: "injected" } }), "utf-8");
			linkSync(outsidePath, authJsonPath);
			authStorage = AuthStorage.create(authJsonPath);

			expect(authStorage.get("anthropic")).toBeUndefined();
			expect(authStorage.drainErrors()).not.toHaveLength(0);
		});

		test.skipIf(process.platform === "win32")("rejects a final auth FIFO without blocking", ({ skip }) => {
			const mkfifo = spawnSync("mkfifo", [authJsonPath], { encoding: "utf8" });
			if (mkfifo.error && "code" in mkfifo.error && mkfifo.error.code === "ENOENT") {
				skip("mkfifo is unavailable");
				return;
			}
			expect(mkfifo.status, mkfifo.stderr).toBe(0);

			const moduleUrl = new URL("../src/core/auth-storage.ts", import.meta.url).href;
			const child = spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"--eval",
					`const { AuthStorage } = await import(${JSON.stringify(moduleUrl)}); const storage = AuthStorage.create(process.argv[1]); if (storage.get("anthropic") !== undefined || storage.drainErrors().length === 0) process.exit(2);`,
					authJsonPath,
				],
				{ encoding: "utf8", timeout: 10_000 },
			);

			expect(child.error).toBeUndefined();
			expect(child.status, child.stderr).toBe(0);
		});

		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("throws and does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			expect(() => authStorage.set("openai", { type: "api_key", key: "openai-key" })).toThrow(
				"Cannot update auth storage because it could not be loaded",
			);

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
			expect(authStorage.has("openai")).toBe(false);
		});

		test("throws when a stale auth lock prevents persistence", () => {
			writeAuthJson({});
			writeFileSync(`${authJsonPath}.lock`, "", "utf-8");

			authStorage = AuthStorage.create(authJsonPath);
			expect(() => authStorage.set("github-copilot", { type: "api_key", key: "copilot-key" })).toThrow(
				"Cannot update auth storage because it could not be loaded",
			);

			expect(readFileSync(authJsonPath, "utf-8")).toBe("{}");
			expect(authStorage.has("github-copilot")).toBe(false);
		});

		test("recovers from an earlier load error before persisting", () => {
			writeAuthJson({});
			const lockPath = `${authJsonPath}.lock`;
			writeFileSync(lockPath, "", "utf-8");

			authStorage = AuthStorage.create(authJsonPath);
			rmSync(lockPath);
			authStorage.set("github-copilot", { type: "api_key", key: "copilot-key" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated["github-copilot"].key).toBe("copilot-key");
			expect(authStorage.has("github-copilot")).toBe(true);
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
