import { describe, expect, it } from "vitest";
import {
	digestExecutionGrantProfile,
	EXECUTION_GRANT_TTL_MS,
	ExecutionGrantStore,
	executionGrantProfile,
} from "../../src/core/permissions/index.ts";
import { changedValue, consumeInput, issueInput } from "./runtime-fixtures.ts";

function store(options: { now?: () => number; ids?: string[] } = {}): ExecutionGrantStore {
	const ids = [...(options.ids ?? ["grant-1", "grant-2", "grant-3"])];
	return new ExecutionGrantStore({
		now: options.now ?? (() => Date.parse("2026-09-01T00:00:00.000Z")),
		createId: () => ids.shift() ?? "grant-fallback",
	});
}

describe("ExecutionGrantStore", () => {
	it("consumes a grant exactly once only when every bound field still matches", () => {
		const grants = store();
		const grant = grants.issue(issueInput());
		expect(grants.consumeExact(grant.grantId, consumeInput())).toEqual(grant);
		expect(() => grants.consumeExact(grant.grantId, consumeInput())).toThrow("already consumed");
	});

	it.each(["toolIdentity", "argsDigest", "cwd", "workspaceRoots"])(
		"rejects a changed %s and revokes the grant",
		(field) => {
			const grants = store();
			const grant = grants.issue(issueInput());
			const current = consumeInput();
			const action = { ...current.action, [field]: changedValue(field) };
			expect(() => grants.consumeExact(grant.grantId, { ...current, action })).toThrow(field);
			expect(grants.has(grant.grantId)).toBe(false);
		},
	);

	it.each(["settingsEpoch", "executionTarget"])("rejects a changed %s and revokes the grant", (field) => {
		const grants = store();
		const grant = grants.issue(issueInput());
		expect(() => grants.consumeExact(grant.grantId, { ...consumeInput(), [field]: changedValue(field) })).toThrow(
			field,
		);
		expect(grants.has(grant.grantId)).toBe(false);
	});

	it("binds read, write, protected, and network profile fields immutably", () => {
		const input = issueInput({
			grant: {
				...issueInput().grant,
				protectedRoots: [issueInput().action.workspaceRoots[0]!],
			},
		});
		const grant = store().issue(input);
		const profile = executionGrantProfile(grant);

		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.writeRoots)).toBe(true);
		expect(Object.isFrozen(profile.networkEndpoints)).toBe(true);
		expect(digestExecutionGrantProfile(profile)).toMatch(/^[a-f0-9]{64}$/);
		expect(() => (grant.writeRoots as string[]).push("/forged")).toThrow();
	});

	it("deletes a mismatched profile before returning an error", () => {
		const grants = store();
		const grant = grants.issue(issueInput());
		const current = consumeInput();
		const action = { ...current.action, writePaths: ["/tmp/forged"] };

		expect(() => grants.consumeExact(grant.grantId, { ...current, action })).toThrow("write paths");
		expect(grants.has(grant.grantId)).toBe(false);
	});

	it("expires grants before consumption", () => {
		let now = Date.parse("2026-09-01T00:00:00.000Z");
		const grants = store({ now: () => now });
		const grant = grants.issue(issueInput());
		now += EXECUTION_GRANT_TTL_MS;

		expect(() => grants.consumeExact(grant.grantId, consumeInput())).toThrow("expired");
		expect(grants.has(grant.grantId)).toBe(false);
	});

	it("fails closed and consumes the grant when the runtime clock becomes invalid", () => {
		let now = Date.parse("2026-09-01T00:00:00.000Z");
		const grants = store({ now: () => now });
		const grant = grants.issue(issueInput());
		now = Number.NaN;

		expect(() => grants.consumeExact(grant.grantId, consumeInput())).toThrow("clock");
		expect(grants.has(grant.grantId)).toBe(false);
	});

	it("enforces monotonic settings epochs", () => {
		const grants = store();
		grants.issue(issueInput({ settingsEpoch: 2 }));
		expect(() => grants.issue(issueInput({ settingsEpoch: 1 }))).toThrow("older");
		expect(grants.issue(issueInput({ settingsEpoch: 2 })).settingsEpoch).toBe(2);
	});

	it("revokes one grant or every pending grant without replay authority", () => {
		const grants = store();
		const first = grants.issue(issueInput());
		const second = grants.issue(issueInput());
		expect(grants.revoke(first.grantId)).toBe(true);
		expect(grants.revoke(first.grantId)).toBe(false);
		expect(grants.revokeAll()).toBe(1);
		expect(grants.has(second.grantId)).toBe(false);
		expect(() => grants.consumeExact(second.grantId, consumeInput())).toThrow("already consumed");
	});

	it("rejects grant widening, duplicate identifiers, and invalid epochs", () => {
		const grants = store({ ids: ["same", "same"] });
		grants.issue(issueInput());
		expect(() => grants.issue(issueInput())).toThrow("identifier");
		expect(() => store().issue(issueInput({ settingsEpoch: -1 }))).toThrow("epoch");
		expect(() =>
			store().issue(
				issueInput({ grant: { ...issueInput().grant, writeRoots: [...issueInput().grant.writeRoots, "/tmp"] } }),
			),
		).toThrow("write roots");
		expect(() => store({ ids: [" grant-1"] }).issue(issueInput())).toThrow("identifier");
	});
});
