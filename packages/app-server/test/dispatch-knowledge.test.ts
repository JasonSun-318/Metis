import type { ClientRpcRequest } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { dispatchKnowledgeRequest, isKnowledgeRequest } from "../src/dispatch/knowledge.ts";
import type { KnowledgeService } from "../src/knowledge.ts";

function request(method: string, params: unknown): ClientRpcRequest {
	return { jsonrpc: "2.0", id: "req-1", method, params } as ClientRpcRequest;
}

function fakeKnowledge() {
	const service = {
		list: vi.fn(() => ({ libraries: [{ id: "lib-1", name: "notes", path: "/notes" }] })),
		register: vi.fn(async (path: string) => ({ id: "lib-2", name: "notes", path })),
		remove: vi.fn(() => ({ libraries: [] })),
		scan: vi.fn(async (libraryId: string) => ({ libraryId, notes: [] })),
		read: vi.fn(async (libraryId: string, path: string) => ({ libraryId, path })),
		resolve: vi.fn(async (libraryId: string, sourcePath: string, reference: string) => ({
			libraryId,
			sourcePath,
			reference,
		})),
	};
	return { service: service as unknown as KnowledgeService, mocks: service };
}

function contextFor(service: KnowledgeService) {
	const mutations: string[] = [];
	return {
		mutations,
		context: {
			knowledge: service,
			replayMutation: async <T>(replayRequest: ClientRpcRequest, run: () => Promise<T>): Promise<T> => {
				mutations.push(replayRequest.method);
				return await run();
			},
		},
	};
}

describe("knowledge dispatch domain", () => {
	it("recognizes only knowledge requests", () => {
		expect(isKnowledgeRequest(request("knowledge/list", {}))).toBe(true);
		expect(isKnowledgeRequest(request("session/knowledge/get", {}))).toBe(false);
		expect(isKnowledgeRequest(request("memory/get", {}))).toBe(false);
	});

	it("delegates read requests to the knowledge service", async () => {
		const { service, mocks } = fakeKnowledge();
		const { context } = contextFor(service);

		await expect(dispatchKnowledgeRequest(request("knowledge/list", {}), context)).resolves.toEqual({
			libraries: [{ id: "lib-1", name: "notes", path: "/notes" }],
		});
		await dispatchKnowledgeRequest(request("knowledge/scan", { libraryId: "lib-1" }), context);
		await dispatchKnowledgeRequest(request("knowledge/read", { libraryId: "lib-1", path: "note.md" }), context);
		await dispatchKnowledgeRequest(
			request("knowledge/resource/resolve", {
				libraryId: "lib-1",
				sourcePath: "note.md",
				reference: "target.md",
				kind: "link",
			}),
			context,
		);

		expect(mocks.list).toHaveBeenCalledOnce();
		expect(mocks.scan).toHaveBeenCalledWith("lib-1");
		expect(mocks.read).toHaveBeenCalledWith("lib-1", "note.md");
		expect(mocks.resolve).toHaveBeenCalledWith("lib-1", "note.md", "target.md", "link");
	});

	it("routes mutating requests through the shared replay helper", async () => {
		const { service, mocks } = fakeKnowledge();
		const { context, mutations } = contextFor(service);

		await dispatchKnowledgeRequest(request("knowledge/register", { path: "/notes" }), context);
		await dispatchKnowledgeRequest(request("knowledge/remove", { libraryId: "lib-1" }), context);

		expect(mocks.register).toHaveBeenCalledWith("/notes");
		expect(mocks.remove).toHaveBeenCalledWith("lib-1");
		expect(mutations).toEqual(["knowledge/register", "knowledge/remove"]);
	});

	it("rejects a knowledge method it does not handle", async () => {
		const { service } = fakeKnowledge();
		const { context } = contextFor(service);
		await expect(dispatchKnowledgeRequest(request("knowledge/unknown", {}), context)).rejects.toThrow(
			"Unhandled knowledge request: knowledge/unknown",
		);
	});
});
