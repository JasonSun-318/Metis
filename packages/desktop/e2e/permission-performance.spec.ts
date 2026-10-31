import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

test.describe.configure({ timeout: 180_000 });

test("packaged sandbox health allows a workspace write and denies a protected-root write", async () => {
	const app = await launchPermissionApp({
		preset: "auto",
		tools: (marker, dirs) => {
			const allowedFile = path.join(dirs.projectDir, "allowed.txt");
			const protectedFile = path.join(dirs.projectDir, ".git", "HEAD");
			if (marker.includes("case-perf-allow")) {
				return { name: "write", arguments: { path: allowedFile, content: "sandbox-ok" } };
			}
			if (marker.includes("case-perf-deny")) {
				return { name: "write", arguments: { path: protectedFile, content: "tamper" } };
			}
			return undefined;
		},
	});
	try {
		const health = await app.page.evaluate(async (session) => {
			const metis = (globalThis as unknown as {
				metis: { openSession(input: { sessionId: string }): Promise<{ sandboxHealth?: string }> };
			}).metis;
			return (await metis.openSession({ sessionId: session })).sandboxHealth;
		}, app.sessionId);
		expect(health, `sandbox must be healthy, got ${health}`).toBe("healthy");

		await app.submit("case-perf-allow");
		await app.waitDone("case-perf-allow");
		expect(await readFile(path.join(app.projectDir, "allowed.txt"), "utf8")).toBe("sandbox-ok");
		await expect(app.approval).toHaveCount(0);
		expect(app.provider.reviewCount).toBe(0);

		// The sandbox-health diagnosis is read-only: the same probe must not install
		// helpers or change settings, and reports through the dedicated method.
		const report = await app.page.evaluate(async () => {
			const metis = (globalThis as unknown as {
				metis: { getPermissionSandboxHealth(): Promise<{ status: string; code: string }> };
			}).metis;
			return metis.getPermissionSandboxHealth();
		});
		expect(report.status).toBe("healthy");
		expect(["ready", "unsupported", "dependencies-unavailable", "package-invalid", "probe-failed"]).toContain(
			report.code,
		);
		expect(health).toBe("healthy");

		await app.submit("case-perf-deny");
		await app.waitDone("case-perf-deny");
		expect(await readFile(path.join(app.projectDir, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main");
		await expect(app.approval).toHaveCount(0);
		expect(app.provider.reviewCount).toBe(0);
	} finally {
		await app.close();
	}
});
