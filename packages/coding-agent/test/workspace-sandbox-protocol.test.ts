import { expect, it } from "vitest";
import { parseSandboxRequest, parseSandboxResponse } from "../src/core/workspace-sandbox-protocol.ts";

it("accepts only the bounded discriminated sandbox protocol", () => {
		expect(
		parseSandboxRequest(
			JSON.stringify({
				type: "init",
				cwd: "/work",
				workspaceRoots: ["/work"],
				readOnlyRoots: ["/attachments"],
				writeRoots: ["/workdir"],
				protectedRoots: ["/agent/memory"],
				shellPath: "/bin/zsh",
				workspaceReadOnly: true,
			}),
		),
	).toEqual({
		type: "init",
		cwd: "/work",
		workspaceRoots: ["/work"],
		readOnlyRoots: ["/attachments"],
		writeRoots: ["/workdir"],
		protectedRoots: ["/agent/memory"],
		shellPath: "/bin/zsh",
		workspaceReadOnly: true,
	});
	expect(
		parseSandboxRequest(
			JSON.stringify({ type: "exec", id: "1", command: "pwd", cwd: "/work", timeoutMs: 10, env: { PATH: "/bin" } }),
		),
	).toMatchObject({ type: "exec", id: "1", timeoutMs: 10 });
	expect(parseSandboxResponse(JSON.stringify({ type: "result", id: "1", exitCode: 0 }))).toEqual({
		type: "result",
		id: "1",
		exitCode: 0,
	});
	expect(parseSandboxResponse(JSON.stringify({ type: "closed" }))).toEqual({ type: "closed" });
	expect(parseSandboxResponse(JSON.stringify({ type: "data", id: "1", data: "b2s=" }))).toEqual({
		type: "data",
		id: "1",
		data: "b2s=",
	});

	for (const line of [
		"{",
		JSON.stringify({
			type: "init",
			cwd: "/work",
			workspaceRoots: [],
			readOnlyRoots: [],
			writeRoots: [],
			protectedRoots: [],
		}),
		JSON.stringify({ type: "init", cwd: "/work", workspaceRoots: ["/work"], writeRoots: [], protectedRoots: [] }),
		JSON.stringify({
			type: "init",
			cwd: "/work",
			workspaceRoots: ["/work"],
			readOnlyRoots: [],
			writeRoots: [],
			protectedRoots: [],
			shellPath: "",
		}),
		JSON.stringify({
			type: "init",
			cwd: "/work",
			workspaceRoots: ["/work"],
			readOnlyRoots: [],
			writeRoots: [],
			protectedRoots: [],
			workspaceReadOnly: "yes",
		}),
		JSON.stringify({ type: "exec", id: "1", command: "x".repeat(262_145), cwd: "/work", env: {} }),
		JSON.stringify({ type: "exec", id: "1", command: "pwd", cwd: "/work", env: {}, extra: true }),
		JSON.stringify({ type: "exec", id: "1", command: "pwd", cwd: "/work", env: {}, timeoutMs: -1 }),
		JSON.stringify({ type: "exec", id: "1", command: "pwd", cwd: "/work", env: {}, timeoutMs: 1.5 }),
		JSON.stringify({ type: "exec", id: "1", command: "pwd", cwd: "/work", env: { "BAD=KEY": "x" } }),
		JSON.stringify({ type: "cancel", id: "" }),
		JSON.stringify({ type: "future" }),
		"x".repeat(1024 * 1024 + 1),
	]) {
		expect(() => parseSandboxRequest(line), line.slice(0, 80)).toThrow();
	}

	for (const line of [
		JSON.stringify({ type: "data", id: "1", data: 42 }),
		JSON.stringify({ type: "data", id: "1", data: "not base64" }),
		JSON.stringify({ type: "result", id: "1", exitCode: 1.5 }),
		JSON.stringify({ type: "error", code: "UNKNOWN", message: "no" }),
		JSON.stringify({ type: "ready", extra: true }),
	]) {
		expect(() => parseSandboxResponse(line), line).toThrow();
	}
});
