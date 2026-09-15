import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyRuntimeRequest, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it } from "vitest";
import {
	completeSessionMutation,
	type DurableSessionMutation,
	prepareSessionMutation,
} from "../src/durable-mutation.ts";

const directories: string[] = [];
const input: DurableSessionMutation = {
	method: "session/close",
	kind: "session_close",
	requestId: "00000000-0000-4000-8000-000000000001",
	params: { sessionId: "session-a" },
};

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createManager(): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "metis-durable-mutation-"));
	directories.push(directory);
	return SessionManager.create(directory, directory);
}

describe("durable session mutation result identifiers", () => {
	it("writes the Metis result identifier", () => {
		const manager = createManager();
		try {
			expect(completeSessionMutation(manager, input, { closed: true })).toEqual({ closed: true });
			expect(manager.getDurableJournalSnapshot()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "custom",
						customType: "metis.app-server.mutation-result.v1",
					}),
				]),
			);
		} finally {
			manager.close();
		}
	});

	it("ignores a retired ArcMind result", () => {
		const manager = createManager();
		try {
			const request = identifyRuntimeRequest(input.method, input.requestId, input.params);
			manager.appendRuntimeControl({
				type: "runtime_operation",
				operationId: request.operationId,
				requestId: request.requestId,
				requestHash: request.requestHash,
				kind: input.kind,
				state: "accepted",
			});
			manager.appendCustomEntry("arcmind.app-server.mutation-result.v1", {
				requestId: request.requestId,
				requestHash: request.requestHash,
				result: { closed: true },
			});

			expect(prepareSessionMutation(manager, input)).toEqual({ state: "accepted" });
		} finally {
			manager.close();
		}
	});
});
