import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientParams, type ClientRequestMethod, type ClientResult, PROTOCOL_VERSION } from "@metis/app-protocol";
import { SessionManager } from "@metis/coding-agent/host";
import { expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";

it("persists multiple linked directories across restart and keeps conversations independent", async () => {
	const root = await mkdtemp(join(tmpdir(), "metis-knowledge-contract-"));
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	await mkdir(agentDir);
	const first = randomUUID();
	const second = randomUUID();
	for (const id of [first, second]) {
		const manager = SessionManager.create(cwd, sessionsRoot, {
			id,
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});
		manager.close();
	}
	const paths = [join(root, "产品资料"), join(root, "技术笔记")];
	for (const path of paths) {
		await mkdir(path);
		await writeFile(join(path, "Note.md"), "# Note");
	}
	let server = await AppServer.create({ agentDir, sessionsRoot });
	try {
		const connect = async () => {
			const connection = server.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: randomUUID(),
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			return async <T extends ClientRequestMethod>(method: T, params: ClientParams<T>): Promise<ClientResult<T>> => {
				const response = await connection.handle({ jsonrpc: "2.0", id: randomUUID(), method, params });
				expect(response).not.toHaveProperty("error");
				if (!response || "error" in response) throw new Error("RPC request failed");
				return response.result as ClientResult<T>;
			};
		};
		let rpc = await connect();
		const skills = (await rpc("skill/list", { sessionId: first })).skills;
		expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["knowledge", "metis-markdown"]));
		const libraries = await Promise.all(
			paths.map((path) => rpc("knowledge/register", { path, requestId: randomUUID() })),
		);
		expect((await rpc("session/knowledge/get", { sessionId: first })).libraries).toEqual([]);
		await rpc("session/knowledge/set", {
			sessionId: first,
			libraryIds: libraries.map((library) => library.id),
			requestId: randomUUID(),
		});
		expect((await rpc("skill/list", { sessionId: first })).skills).toEqual(skills);
		expect((await rpc("session/knowledge/get", { sessionId: second })).libraries).toEqual([]);
		// Viewer access is independent of conversation links, and never grants tool permissions.
		expect((await rpc("knowledge/read", { libraryId: libraries[0].id, path: "Note.md" })).content).toBe("# Note");
		server.beginShutdown();
		await server.waitForShutdown();
		server = await AppServer.create({ agentDir, sessionsRoot });
		rpc = await connect();
		expect((await rpc("session/knowledge/get", { sessionId: first })).libraries).toEqual(libraries);
		await rpc("session/knowledge/set", { sessionId: first, libraryIds: [], requestId: randomUUID() });
		expect((await rpc("session/knowledge/get", { sessionId: first })).libraries).toEqual([]);
	} finally {
		server.beginShutdown();
		await server.waitForShutdown();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
