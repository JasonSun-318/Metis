import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream failures", () => {
	it("drains queued events before rejecting the iterator and result", async () => {
		const stream = new EventStream<number, string>(() => false, String);
		const failure = new Error("stream failed");
		stream.push(1);
		stream.push(2);
		stream.fail(failure);

		const events: number[] = [];
		let iteratorFailure: unknown;
		try {
			for await (const event of stream) events.push(event);
		} catch (error) {
			iteratorFailure = error;
		}

		expect(events).toEqual([1, 2]);
		expect(iteratorFailure).toBe(failure);
		await expect(stream.result()).rejects.toBe(failure);
	});

	it("immediately rejects a waiting iterator without an unhandled result rejection", async () => {
		const stream = new EventStream<number, string>(() => false, String);
		const failure = new Error("stream failed");
		const pending = stream[Symbol.asyncIterator]().next();

		stream.fail(failure);

		await expect(pending).rejects.toBe(failure);
	});

	it.each(["isComplete", "extractResult"] as const)(
		"turns a throwing %s callback into stream failure",
		async (phase) => {
			const failure = new Error(`${phase} failed`);
			const stream = new EventStream<number, string>(
				() => {
					if (phase === "isComplete") throw failure;
					return true;
				},
				() => {
					throw failure;
				},
			);

			stream.push(1);

			let iteratorFailure: unknown;
			try {
				for await (const _event of stream) {
					// The failing terminal event is never delivered.
				}
			} catch (error) {
				iteratorFailure = error;
			}
			expect(iteratorFailure).toBe(failure);
			await expect(stream.result()).rejects.toBe(failure);
		},
	);
});
