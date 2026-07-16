import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialCoordinator } from "../src/credential-coordinator.ts";

describe("CredentialCoordinator", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("broadcasts persisted login and logout changes to every live session view", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "credential-coordinator-"));
		roots.push(agentDir);
		const coordinator = new CredentialCoordinator({ agentDir });
		const first = coordinator.createView();
		const second = coordinator.createView();

		first.set("provider-a", { type: "api_key", key: "credential-value" });
		expect(second.has("provider-a")).toBe(true);
		expect(coordinator.getStatus(second, "provider-a")).toEqual({ configured: true, source: "stored" });
		expect(JSON.stringify(coordinator.getStatus(second, "provider-a"))).not.toContain("credential-value");

		second.logout("provider-a");
		expect(first.has("provider-a")).toBe(false);
	});

	it("keeps dynamic OAuth providers local to one session view", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "credential-coordinator-"));
		roots.push(agentDir);
		const coordinator = new CredentialCoordinator({ agentDir });
		const first = coordinator.createView();
		const second = coordinator.createView();
		const provider = {
			id: "session-only",
			name: "Session only",
			async login() {
				throw new Error("not used");
			},
			async refreshToken() {
				throw new Error("not used");
			},
			getApiKey() {
				return "not-exposed";
			},
		};

		first.registerOAuthProvider(provider);
		expect(first.getOAuthProvider("session-only")).toBe(provider);
		expect(second.getOAuthProvider("session-only")).toBeUndefined();
	});

	it("broadcasts an OAuth refresh without sharing the session-local provider", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "credential-coordinator-"));
		roots.push(agentDir);
		const coordinator = new CredentialCoordinator({ agentDir });
		const first = coordinator.createView();
		const second = coordinator.createView();
		first.registerOAuthProvider({
			id: "rotating-provider",
			name: "Rotating provider",
			async login() {
				throw new Error("not used");
			},
			async refreshToken(credentials) {
				return { ...credentials, access: "rotated-access", expires: Date.now() + 60_000 };
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
		first.set("rotating-provider", {
			type: "oauth",
			access: "expired-access",
			refresh: "refresh-value",
			expires: Date.now() - 1,
		});

		await expect(first.getApiKey("rotating-provider")).resolves.toBe("rotated-access");
		expect(second.get("rotating-provider")).toMatchObject({
			type: "oauth",
			access: "rotated-access",
		});
		expect(second.getOAuthProvider("rotating-provider")).toBeUndefined();
	});
});
