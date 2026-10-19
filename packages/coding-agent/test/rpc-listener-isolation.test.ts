import { afterEach, describe, expect, test, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type PendingRequest = {
	resolve: (response: unknown) => void;
	reject: (error: Error) => void;
};

type RpcClientHarness = {
	handleLine: (line: string) => void;
	pendingRequests: Map<string, PendingRequest>;
};

function getHarness(client: RpcClient): RpcClientHarness {
	return client as unknown as RpcClientHarness;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RpcClient listener isolation", () => {
	test("ignores malformed JSON without dispatching or diagnosing", () => {
		const client = new RpcClient();
		const listener = vi.fn();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		client.onEvent(listener);

		getHarness(client).handleLine("{not json");

		expect(listener).not.toHaveBeenCalled();
		expect(client.getStderr()).toBe("");
		expect(stderr).not.toHaveBeenCalled();
	});

	test("continues dispatching after one listener throws and diagnoses the failure", () => {
		const client = new RpcClient();
		const calls: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		client.onEvent(() => calls.push("first"));
		client.onEvent(() => {
			calls.push("second");
			throw new Error("listener boom");
		});
		client.onEvent(() => calls.push("third"));

		getHarness(client).handleLine(JSON.stringify({ type: "agent_start" }));

		expect(calls).toEqual(["first", "second", "third"]);
		expect(client.getStderr()).toContain("Event listener failed: listener boom");
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Event listener failed: listener boom"));
	});

	test("keeps event order across malformed lines and a failing listener", () => {
		const client = new RpcClient();
		const calls: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		client.onEvent((event) => {
			calls.push(event.type);
			if (event.type === "agent_start") throw new Error("first failed");
		});
		client.onEvent((event) => calls.push(`later:${event.type}`));
		const harness = getHarness(client);

		harness.handleLine("not json");
		harness.handleLine(JSON.stringify({ type: "agent_start" }));
		harness.handleLine("still not json");
		harness.handleLine(JSON.stringify({ type: "agent_end" }));

		expect(calls).toEqual(["agent_start", "later:agent_start", "agent_end", "later:agent_end"]);
		expect(stderr).toHaveBeenCalledTimes(1);
	});

	test("sanitizes terminal instructions in listener diagnostics", () => {
		const client = new RpcClient();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		client.onEvent(() => {
			throw new Error("before\u001b[2Jafter\u0007");
		});
		getHarness(client).handleLine('{"type":"agent_start"}');
		expect(client.getStderr()).toContain("beforeafter");
		expect(client.getStderr()).not.toMatch(/[\u001b\u0007]/u);
		expect(stderr).toHaveBeenCalledWith(client.getStderr());
	});

	test.each(["format", "write"])("continues after a diagnostic %s failure", (failure) => {
		const client = new RpcClient();
		const later = vi.fn();
		vi.spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error("stderr unavailable");
		});
		client.onEvent(() => {
			throw failure === "format" ? Object.create(null) : new Error("listener failed");
		});
		client.onEvent(later);
		expect(() => getHarness(client).handleLine('{"type":"agent_start"}')).not.toThrow();
		expect(later).toHaveBeenCalledOnce();
	});

	test("resolves matching responses without dispatching them to event listeners", () => {
		const client = new RpcClient();
		const listener = vi.fn();
		client.onEvent(listener);
		const harness = getHarness(client);
		const response = { type: "response", id: "req_1", success: true, data: { ok: true } };
		let resolved: unknown;
		harness.pendingRequests.set("req_1", {
			resolve: (value) => {
				resolved = value;
			},
			reject: (error) => {
				throw error;
			},
		});

		harness.handleLine(JSON.stringify(response));

		expect(resolved).toEqual(response);
		expect(harness.pendingRequests.has("req_1")).toBe(false);
		expect(listener).not.toHaveBeenCalled();
	});

	test.each(["null", "42", "true", '"text"', "[]", "{}", '{"type":42}'])(
		"ignores invalid event envelope %s",
		(line) => {
			const client = new RpcClient();
			const listener = vi.fn();
			client.onEvent(listener);

			getHarness(client).handleLine(line);

			expect(listener).not.toHaveBeenCalled();
		},
	);
});
