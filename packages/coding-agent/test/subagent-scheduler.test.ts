import { describe, expect, it } from "vitest";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function tick(): Promise<void> {
	for (let index = 0; index < 6; index++) await Promise.resolve();
}

describe("SubagentScheduler", () => {
	it("enforces global and parent limits while admitting FIFO work", async () => {
		const scheduler = new SubagentScheduler(2, 1);
		const gates = [deferred(), deferred(), deferred()];
		const started: string[] = [];
		const enqueue = (key: string, parentSessionId: string, index: number) =>
			scheduler.enqueue({
				key,
				parentSessionId,
				start: async () => {
					started.push(key);
					await gates[index].promise;
				},
			});

		expect(enqueue("a", "parent-1", 0)).toBe("running");
		expect(enqueue("b", "parent-1", 1)).toBe("queued");
		expect(enqueue("c", "parent-2", 2)).toBe("running");
		await tick();
		expect(started).toEqual(["a", "c"]);
		expect(scheduler.runningCount).toBe(2);
		gates[0].resolve();
		await tick();
		expect(started).toEqual(["a", "c", "b"]);
		gates[1].resolve();
		gates[2].resolve();
		await tick();
	});

	it("cancels queued work and rejects duplicate keys", () => {
		const scheduler = new SubagentScheduler(1, 1);
		const gate = deferred();
		scheduler.enqueue({ key: "a", parentSessionId: "p", start: () => gate.promise });
		scheduler.enqueue({ key: "b", parentSessionId: "p", start: async () => undefined });
		expect(() => scheduler.enqueue({ key: "b", parentSessionId: "p", start: async () => undefined })).toThrow(
			"already exists",
		);
		expect(scheduler.cancel("b")).toBe(true);
		expect(scheduler.isQueued("b")).toBe(false);
		gate.resolve();
	});
});
