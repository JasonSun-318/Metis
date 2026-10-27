import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientParams, type ClientRequestMethod, type ClientResult, PROTOCOL_VERSION } from "@metis/app-protocol";
import { KNOWLEDGE_LINKS_CUSTOM_TYPE, SessionManager } from "@metis/coding-agent/host";
import { expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import { KnowledgeService } from "../src/knowledge.ts";

it("forgets removed directories in active and cold conversations without deleting files or reviving old links", async () => {
	const root = await mkdtemp(join(tmpdir(), "metis-knowledge-removal-"));
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	const cwd = join(root, "workspace");
	const firstPath = join(root, "Product notes");
	const secondPath = join(root, "Technical notes");
	for (const path of [agentDir, cwd, firstPath, secondPath]) await mkdir(path);
	await mkdir(join(firstPath, "nested"));
	await writeFile(join(firstPath, "nested", "Note.md"), "# Original product note\nKeep this content.");
	await writeFile(join(firstPath, "original.bin"), Buffer.from([0, 1, 255]));
	await writeFile(join(secondPath, "Note.md"), "# Original technical note");
	const service = new KnowledgeService(agentDir);
	const firstLibrary = await service.register(firstPath);
	const secondLibrary = await service.register(secondPath);
	const sessions = [randomUUID(), randomUUID()];
	for (const id of sessions) {
		const manager = SessionManager.create(cwd, sessionsRoot, {
			id,
			mode: "chat",
			cwdOrigin: "user-selected",
			permissionPreset: "full",
		});
		manager.appendCustomEntry(KNOWLEDGE_LINKS_CUSTOM_TYPE, { libraries: [firstLibrary, secondLibrary] });
		manager.close();
	}
	let server: AppServer | undefined;
	try {
		server = await AppServer.create({ agentDir, sessionsRoot });
		const connect = async () => {
			const connection = server!.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: randomUUID(),
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			return {
				connection,
				async rpc<T extends ClientRequestMethod>(method: T, params: ClientParams<T>): Promise<ClientResult<T>> {
					const response = await connection.handle({ jsonrpc: "2.0", id: randomUUID(), method, params });
					expect(response).not.toHaveProperty("error");
					if (!response || "error" in response) throw new Error("RPC request failed");
					return response.result as ClientResult<T>;
				},
			};
		};
		let client = await connect();
		// The second conversation stays cold while the first runtime is already open.
		expect((await client.rpc("session/knowledge/get", { sessionId: sessions[0] })).libraries).toEqual([
			firstLibrary,
			secondLibrary,
		]);
		const removal = { requestId: randomUUID(), libraryId: firstLibrary.id };
		expect(await client.rpc("knowledge/remove", removal)).toEqual({ libraries: [secondLibrary] });
		expect(await client.rpc("knowledge/remove", removal)).toEqual({ libraries: [secondLibrary] });
		for (const sessionId of sessions) {
			expect((await client.rpc("session/knowledge/get", { sessionId })).libraries).toEqual([secondLibrary]);
		}
		const invalidLink = await client.connection.handle({
			jsonrpc: "2.0",
			id: randomUUID(),
			method: "session/knowledge/set",
			params: { sessionId: sessions[0], requestId: randomUUID(), libraryIds: [firstLibrary.id] },
		});
		expect(invalidLink).toHaveProperty("error");
		const addedAgain = await client.rpc("knowledge/register", { requestId: randomUUID(), path: firstPath });
		expect(addedAgain.id).not.toBe(firstLibrary.id);

		server.beginShutdown();
		await server.waitForShutdown();
		server = await AppServer.create({ agentDir, sessionsRoot });
		client = await connect();
		expect((await client.rpc("knowledge/list", {})).libraries).toEqual([secondLibrary, addedAgain]);
		for (const sessionId of sessions) {
			expect((await client.rpc("session/knowledge/get", { sessionId })).libraries).toEqual([secondLibrary]);
		}
		await client.rpc("session/knowledge/set", {
			sessionId: sessions[0],
			requestId: randomUUID(),
			libraryIds: [secondLibrary.id, addedAgain.id],
		});
		await client.rpc("knowledge/remove", { requestId: randomUUID(), libraryId: secondLibrary.id });
		expect((await client.rpc("session/knowledge/get", { sessionId: sessions[0] })).libraries).toEqual([addedAgain]);
		expect((await client.rpc("session/knowledge/get", { sessionId: sessions[1] })).libraries).toEqual([]);
		await client.rpc("knowledge/remove", { requestId: randomUUID(), libraryId: addedAgain.id });
		server.beginShutdown();
		await server.waitForShutdown();
		server = await AppServer.create({ agentDir, sessionsRoot });
		client = await connect();
		expect(await client.rpc("knowledge/list", {})).toEqual({ libraries: [] });
		for (const sessionId of sessions) {
			expect(await client.rpc("session/knowledge/get", { sessionId })).toEqual({ libraries: [] });
		}
		expect(await readFile(join(firstPath, "nested", "Note.md"), "utf8")).toBe(
			"# Original product note\nKeep this content.",
		);
		expect(await readFile(join(firstPath, "original.bin"))).toEqual(Buffer.from([0, 1, 255]));
		expect(await readFile(join(secondPath, "Note.md"), "utf8")).toBe("# Original technical note");
	} finally {
		server?.beginShutdown();
		await server?.waitForShutdown();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
