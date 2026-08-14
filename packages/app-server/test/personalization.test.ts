import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import { PersonalizationService } from "../src/personalization.ts";

describe("PersonalizationService", () => {
	let tempRoot: string;
	let agentDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "metis-personalization-"));
		agentDir = join(tempRoot, "agent");
	});

	afterEach(() => {
		if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
	});

	it("returns empty instructions when AGENTS.md is absent", () => {
		const service = new PersonalizationService(agentDir);
		expect(service.view()).toEqual({ instructions: "" });
	});

	it("atomically replaces and reads the complete global AGENTS.md", () => {
		const service = new PersonalizationService(agentDir);
		expect(service.update({ instructions: "First line\n第二行" })).toEqual({
			instructions: "First line\n第二行",
		});
		const path = join(agentDir, "AGENTS.md");
		expect(readFileSync(path, "utf8")).toBe("First line\n第二行");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(service.view()).toEqual({ instructions: "First line\n第二行" });
	});

	it("refuses to follow a symlink at AGENTS.md", () => {
		const outside = join(tempRoot, "outside.txt");
		writeFileSync(outside, "secret");
		new PersonalizationService(agentDir).update({ instructions: "initial" });
		rmSync(join(agentDir, "AGENTS.md"));
		symlinkSync(outside, join(agentDir, "AGENTS.md"));
		const service = new PersonalizationService(agentDir);
		expect(() => service.view()).toThrow();
		expect(() => service.update({ instructions: "replacement" })).toThrow();
		expect(readFileSync(outside, "utf8")).toBe("secret");
	});

	it("dispatches get and update without reloading sessions", async () => {
		const server = await AppServer.create({ agentDir });
		try {
			const connection = server.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "get",
					method: "personalization/get",
					params: {},
				}),
			).toMatchObject({ result: { instructions: "" } });
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "update",
					method: "personalization/update",
					params: { instructions: "Keep explanations concise." },
				}),
			).toMatchObject({ result: { instructions: "Keep explanations concise." } });
			expect(readFileSync(join(agentDir, "AGENTS.md"), "utf8")).toBe("Keep explanations concise.");
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
		}
	});
});
