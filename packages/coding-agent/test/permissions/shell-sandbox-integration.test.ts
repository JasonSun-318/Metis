import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceSandbox, type WorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";

// This suite exercises the real OS broker. Enable it explicitly on an OS with
// the sandbox runtime installed; ordinary CI uses the deterministic unit suites.
describe.runIf(process.env.METIS_TEST_OS_SANDBOX === "1")("shell sandbox network integration", () => {
	const roots: string[] = [];
	const servers: Server[] = [];
	const sandboxes: WorkspaceSandbox[] = [];
	const directory = () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "metis-shell-network-")));
		roots.push(root);
		return root;
	};
	const listen = async (server: Server) => {
		servers.push(server);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		return (server.address() as AddressInfo).port;
	};
	const sandbox = async (cwd: string, port: number) => {
		const instance = await createWorkspaceSandbox({
			cwd,
			workspaceRoots: [cwd],
			networkEndpoints: [{ hostname: "127.0.0.1", port }],
			writeProtectedRoots: [join(cwd, ".git")],
		});
		sandboxes.push(instance);
		return instance;
	};
	const execute = async (instance: WorkspaceSandbox, cwd: string, command: string) => {
		let output = "";
		const result = await instance.operations.exec(command, cwd, {
			timeout: 8,
			onData: (chunk) => {
				output += chunk.toString();
			},
		});
		return { ...result, output };
	};
	const curl = "curl -q --silent --show-error --fail --connect-timeout 3 --max-time 5";

	afterEach(async () => {
		for (const instance of sandboxes.splice(0)) await instance.dispose();
		for (const server of servers.splice(0)) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("allows the exact HTTP endpoint and prevents a different port from receiving a request", async () => {
		const cwd = directory();
		let allowedHits = 0;
		let deniedHits = 0;
		const allowedPort = await listen(
			createServer((_request, response) => {
				allowedHits += 1;
				response.end("allowed-http");
			}),
		);
		const deniedPort = await listen(
			createServer((_request, response) => {
				deniedHits += 1;
				response.end("must-not-arrive");
			}),
		);
		const instance = await sandbox(cwd, allowedPort);
		await expect(execute(instance, cwd, `${curl} http://127.0.0.1:${allowedPort}`)).resolves.toMatchObject({
			exitCode: 0,
			output: "allowed-http",
		});
		expect((await execute(instance, cwd, `${curl} http://127.0.0.1:${deniedPort}`)).exitCode).not.toBe(0);
		expect(allowedHits).toBe(1);
		expect(deniedHits).toBe(0);
	});

	it("does not widen an endpoint grant when curl follows a redirect", async () => {
		const cwd = directory();
		let deniedHits = 0;
		const deniedPort = await listen(
			createServer((_request, response) => {
				deniedHits += 1;
				response.end("must-not-arrive");
			}),
		);
		const redirectPort = await listen(
			createServer((_request, response) => {
				response.writeHead(302, { Location: `http://127.0.0.1:${deniedPort}/redirected` });
				response.end();
			}),
		);
		const instance = await sandbox(cwd, redirectPort);
		expect((await execute(instance, cwd, `${curl} --location http://127.0.0.1:${redirectPort}`)).exitCode).not.toBe(
			0,
		);
		expect(deniedHits).toBe(0);
	});

	it("verifies HTTPS certificates while permitting an explicitly trusted local CA", async () => {
		const cwd = directory();
		const certificate = join(cwd, "fixture-ca.pem");
		const key = join(cwd, "fixture-server-key.pem");
		// A disposable fixture CA, never a production credential or trust-store edit.
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-days",
				"1",
				"-keyout",
				key,
				"-out",
				certificate,
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=IP:127.0.0.1,DNS:localhost",
			],
			{ stdio: "ignore" },
		);
		let hits = 0;
		const port = await listen(
			createSecureServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (_request, response) => {
				hits += 1;
				response.end("verified-https");
			}),
		);
		const instance = await sandbox(cwd, port);
		expect((await execute(instance, cwd, `${curl} https://127.0.0.1:${port}`)).exitCode).not.toBe(0);
		expect(hits).toBe(0);
		await expect(
			execute(instance, cwd, `${curl} --cacert fixture-ca.pem https://127.0.0.1:${port}`),
		).resolves.toMatchObject({
			exitCode: 0,
			output: "verified-https",
		});
		expect(hits).toBe(1);
	});

	it("does not turn network permission into outside-file or repository-metadata access", async () => {
		const cwd = directory();
		const outside = directory();
		const outsideFile = join(outside, "outside.txt");
		writeFileSync(outsideFile, "original");
		mkdirSync(join(cwd, ".git"));
		writeFileSync(join(cwd, ".git", "sentinel"), "original");
		const port = await listen(createServer((_request, response) => response.end("network-data")));
		const instance = await sandbox(cwd, port);
		expect((await execute(instance, cwd, `${curl} http://127.0.0.1:${port} > '${outsideFile}'`)).exitCode).not.toBe(
			0,
		);
		expect((await execute(instance, cwd, `${curl} http://127.0.0.1:${port} > .git/sentinel`)).exitCode).not.toBe(0);
		expect(readFileSync(outsideFile, "utf8")).toBe("original");
		expect(readFileSync(join(cwd, ".git", "sentinel"), "utf8")).toBe("original");
	});

	it("creates and appends the exact granted file while refusing its sibling", async () => {
		const cwd = directory();
		const target = join(cwd, "once.txt");
		const instance = await createWorkspaceSandbox({
			cwd,
			workspaceRoots: [cwd],
			workspaceReadOnly: true,
			writeRoots: [target],
		});
		sandboxes.push(instance);
		const aliasTarget = process.platform === "darwin" ? target.replace(/^\/private\/var\//u, "/var/") : target;
		await expect(execute(instance, cwd, `printf x >> '${aliasTarget}'`)).resolves.toMatchObject({ exitCode: 0 });
		await expect(execute(instance, cwd, `printf x >> '${target}'`)).resolves.toMatchObject({ exitCode: 0 });
		expect(readFileSync(target, "utf8")).toBe("xx");
		expect((await execute(instance, cwd, "printf x > sibling.txt")).exitCode).not.toBe(0);
		const outside = join(directory(), "outside.txt");
		writeFileSync(outside, "private fixture");
		const outsideAlias = process.platform === "darwin" ? outside.replace(/^\/private\/var\//u, "/var/") : outside;
		expect((await execute(instance, cwd, `cat '${outsideAlias}'`)).exitCode).not.toBe(0);
	});
});
