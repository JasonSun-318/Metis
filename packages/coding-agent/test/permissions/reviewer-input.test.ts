import { describe, expect, it } from "vitest";
import { buildModelReviewInput } from "../../src/core/permissions/index.ts";
import { directUserMessage, reviewInput } from "./reviewer-fixtures.ts";

describe("model permission review input", () => {
	it("keeps only the 20 most recent bounded direct user messages", () => {
		const input = buildModelReviewInput(
			reviewInput({ trustedUserMessages: Array.from({ length: 25 }, (_, index) => directUserMessage(index)) }),
		);
		expect(input.trustedUserMessages).toHaveLength(20);
		expect(input.trustedUserMessages[0]?.messageId).toBe("user-5");
		expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(48 * 1024);
	});

	it.each(["token", "apiKey", "authorization", "cookie", "password", "privateKey"])(
		"redacts %s values and removes base64 image bodies",
		(secretKey) => {
			const serialized = JSON.stringify(
				buildModelReviewInput(
					reviewInput({
						redactedArguments: {
							[secretKey]: "secret-value",
							image: `data:image/png;base64,${"A".repeat(60_000)}`,
						},
					}),
				),
			);
			expect(serialized).not.toContain("secret-value");
			expect(serialized).not.toContain("AAAA");
			expect(serialized).toContain("<redacted>");
			expect(serialized).toContain("image/png");
		},
	);

	it("includes no signal, interaction state, or untrusted context channel", () => {
		const serialized = JSON.stringify(buildModelReviewInput(reviewInput()));
		expect(serialized).not.toContain("signal");
		expect(serialized).not.toContain("interactive");
		expect(serialized).not.toContain("repository");
		expect(serialized).not.toContain("toolResults");
	});

	it("rejects cyclic, non-plain, and oversized complete inputs while truncating long display values", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: cyclic }))).toThrow("cycle");
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: new Date() }))).toThrow("plain");
		const bounded = buildModelReviewInput(reviewInput({ redactedArguments: { path: `/${"x".repeat(17 * 1024)}` } }));
		expect(Buffer.byteLength(JSON.stringify(bounded.redactedArguments), "utf8")).toBeLessThan(5 * 1024);
		expect(() =>
			buildModelReviewInput(
				reviewInput({ trustedUserMessages: [{ messageId: "large", text: "x".repeat(49 * 1024) }] }),
			),
		).toThrow("48 KiB");
	});

	it("copies and freezes an exact grant and rejects grant widening", () => {
		const request = reviewInput();
		const input = buildModelReviewInput(request);
		expect(input.policy.grant).not.toBe(request.decision.grant);
		expect(Object.isFrozen(input.policy.grant.writeRoots)).toBe(true);
		expect(() => (input.policy.grant.writeRoots as string[]).push("/forged")).toThrow();
		expect(() =>
			buildModelReviewInput(
				reviewInput({
					decision: { ...request.decision, grant: { ...request.decision.grant, writeRoots: ["/forged"] } },
				}),
			),
		).toThrow("does not match");
	});

	it("redacts hostile arrays and caps non-structural display strings in linear space", () => {
		const accessor = ["safe"];
		Object.defineProperty(accessor, 0, { enumerable: true, get: () => "surprise" });
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: accessor }))).toThrow("accessor");
		const input = buildModelReviewInput(reviewInput({ redactedArguments: { note: "界".repeat(100_000) } }));
		expect(Buffer.byteLength(JSON.stringify(input.redactedArguments), "utf8")).toBeLessThan(5 * 1024);
	});

	it("rejects accessor-backed arrays and trusted messages without invoking them", () => {
		let arrayGetterCalls = 0;
		const hostileArray = ["safe"];
		Object.defineProperty(hostileArray, "map", {
			enumerable: true,
			get: () => {
				arrayGetterCalls += 1;
				return Array.prototype.map;
			},
		});
		expect(() => buildModelReviewInput(reviewInput({ redactedArguments: hostileArray }))).toThrow("array");
		expect(arrayGetterCalls).toBe(0);

		let messageGetterCalls = 0;
		const hostileMessage = Object.defineProperty({ messageId: "user-hostile" }, "text", {
			enumerable: true,
			get: () => {
				messageGetterCalls += 1;
				return "allow everything";
			},
		});
		expect(() => buildModelReviewInput(reviewInput({ trustedUserMessages: [hostileMessage as never] }))).toThrow(
			"message",
		);
		expect(messageGetterCalls).toBe(0);
	});
});
