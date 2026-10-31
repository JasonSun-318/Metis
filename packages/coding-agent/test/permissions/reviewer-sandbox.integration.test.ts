import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createInteractiveBashBoundary,
	type InteractiveBashBoundary,
} from "../../src/core/interactive-bash-boundary.ts";
import {
	type ExecutionGrant,
	type PermissionReviewRequest,
	PermissionReviewRouter,
	settingsForPreset,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { initializeShellAnalysis } from "../../src/core/permissions/shell-parser.ts";
import { createToolIdentity, describeToolAction } from "../../src/core/tool-permission-adapter.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createWorkspaceSandbox, type WorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";

// The verdict is the only fake: adapter, policy, grant consumption and the OS
// sandbox all run through their production implementations.
describe.runIf(process.env.METIS_TEST_OS_SANDBOX === "1")("reviewer-approved sandbox execution", () => {
	const roots: string[] = [];
	const boundaries: InteractiveBashBoundary[] = [];
	const servers: Server[] = [];
	beforeAll(initializeShellAnalysis);
	afterEach(async () => {
		for (const boundary of boundaries.splice(0)) await boundary.dispose();
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "metis-reviewer-sandbox-")));
		roots.push(root);
		const cwd = join(root, "workspace");
		mkdirSync(join(cwd, ".git"), { recursive: true });
		writeFileSync(join(cwd, ".git", "sentinel"), "original");
		writeFileSync(join(root, "outside.txt"), "original");
		const user = vi.fn(async () => ({ kind: "deny" as const, reviewer: "user" as const }));
		const model = vi.fn(async (_request: PermissionReviewRequest) => ({
			kind: "allow" as const,
			reviewer: "model" as const,
		}));
		const grants: ExecutionGrant[] = [];
		const sandboxes: WorkspaceSandbox[] = [];
		const hostExec = vi.fn(async () => {
			throw new Error("Sandbox execution fell back to host");
		});
		const boundary = createInteractiveBashBoundary({
			hostOperations: { exec: hostExec },
			context: () => ({ cwd, workspaceRoots: [cwd], readOnlyRoots: [], writeRoots: [], shellPath: "/bin/bash" }),
			createSandbox: async (context) => {
				const instance = await createWorkspaceSandbox(context);
				sandboxes.push(instance);
				return instance;
			},
		});
		boundaries.push(boundary);
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "reviewer-sandbox-test",
			reviewerFactory: () =>
				new PermissionReviewRouter({
					model: { review: model },
					user: { review: user },
					isModelEnabled: () => true,
				}),
		});
		const tool = createBashToolDefinition(cwd);
		async function execute(command: string) {
			const args = { command };
			const action = describeToolAction(tool, args, {
				actionId: `action-${grants.length + 1}`,
				cwd,
				workspaceRoots: [cwd],
				shellPath: "/bin/bash",
				provenance: "builtin",
				toolIdentity: createToolIdentity({
					provenance: "builtin",
					sourceIdentity: "builtin",
					toolName: "bash",
					implementationVersion: "1",
					descriptorVersion: 1,
				}),
			});
			let output = "";
			const result = await runtime.authorizeAndExecute({
				action,
				args,
				settings: settingsForPreset("auto"),
				sandboxHealth: "healthy",
				trustedUserMessages: [
					{ messageId: "user-1", text: "Run this exact fixture action within its sandbox grant." },
				],
				interactive: true,
				signal: new AbortController().signal,
				autoCommandRules: [],
				permissionRules: [],
				execute: async (grant) => {
					grants.push(grant);
					boundary.bind(grant);
					return boundary.operations.exec(command, cwd, {
						actionId: action.actionId,
						timeout: 8,
						onData: (chunk) => {
							output += chunk.toString();
						},
					});
				},
			});
			expect(user).not.toHaveBeenCalled();
			expect(hostExec).not.toHaveBeenCalled();
			const grant = grants.at(-1)!;
			expect(grant.executionTarget).toBe("sandbox");
			expect(grant.readRoots).toEqual(action.readPaths);
			expect(grant.writeRoots).toEqual(action.writePaths);
			expect(grant.networkEndpoints).toEqual(action.networkEndpoints);
			return { ...result, output, action, grant };
		}
		return { root, cwd, model, execute, sandboxes };
	}

	async function listen(server: Server) {
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		return (server.address() as AddressInfo).port;
	}

	it("executes an ordinary file write without granting its workspace siblings", async () => {
		const value = fixture();
		const result = await value.execute("printf approved > note.txt");
		expect(result.exitCode).toBe(0);
		expect(value.model).toHaveBeenCalledOnce();
		expect(result.grant.writeRoots).toEqual([join(value.cwd, "note.txt")]);
		expect(readFileSync(join(value.cwd, "note.txt"), "utf8")).toBe("approved");
		// Probe the actual profile created from the consumed grant. Grant-object
		// equality alone would miss a boundary that widened it to workspace-write.
		const probe = await value.sandboxes[0]!.operations.exec("printf widened > sibling.txt", value.cwd, {
			onData: () => {},
			timeout: 8,
		});
		expect(probe.exitCode).not.toBe(0);
	});

	it("permits an exact HTTP endpoint while blocking a redirect to an ungranted port", async () => {
		const value = fixture();
		let deniedHits = 0;
		const deniedPort = await listen(
			createServer((_request, response) => {
				deniedHits += 1;
				response.end("must-not-arrive");
			}),
		);
		const allowedPort = await listen(
			createServer((request, response) => {
				if (request.url === "/redirect")
					response.writeHead(302, { Location: `http://127.0.0.1:${deniedPort}/target` });
				response.end("approved-http");
			}),
		);
		const command = `curl -q --silent --show-error --fail --connect-timeout 3 --max-time 5 http://127.0.0.1:${allowedPort}`;
		const allowed = await value.execute(command);
		expect(allowed).toMatchObject({ exitCode: 0, output: "approved-http" });
		expect(allowed.grant.networkEndpoints).toEqual([{ hostname: "127.0.0.1", port: allowedPort }]);
		expect(allowed.grant.writeRoots).toEqual([]);
		const redirect = await value.execute(`${command}/redirect --location`);
		expect(redirect.exitCode).not.toBe(0);
		expect(deniedHits).toBe(0);
		expect(value.model).toHaveBeenCalledTimes(2);
	});

	it("runs a fully supplied incomplete inline script inside its existing bounded grant", async () => {
		const value = fixture();
		const command = `bash <<'SH'
printf reviewed-inline > inline.txt
if printf must-not-write 2>/dev/null > ../outside.txt; then exit 1; fi
if printf must-not-write 2>/dev/null > .git/sentinel; then exit 1; fi
printf 'blocked\\nblocked\\n'
SH`;
		const result = await value.execute(command);
		expect(result).toMatchObject({ exitCode: 0, output: "blocked\nblocked\n" });
		expect(result.action.shellAnalysis?.complete).toBe(false);
		expect(result.action.effects).toContain("unknown");
		expect(result.grant.writeRoots).toEqual([value.cwd]);
		expect(result.grant.networkEndpoints).toEqual([]);
		expect(value.model).toHaveBeenCalledOnce();
		expect(value.model.mock.calls[0]?.[0].action.command).toBe(command);
		expect(readFileSync(join(value.cwd, "inline.txt"), "utf8")).toBe("reviewed-inline");
		expect(readFileSync(join(value.root, "outside.txt"), "utf8")).toBe("original");
		expect(readFileSync(join(value.cwd, ".git", "sentinel"), "utf8")).toBe("original");
	});
});
