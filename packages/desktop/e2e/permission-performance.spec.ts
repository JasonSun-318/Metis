import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";
import { messageText } from "./packaged-app-harness.ts";

test.describe.configure({ timeout: 180_000 });

test("packaged settings completes the sandbox self-test", async () => {
	const app = await launchPermissionApp({ preset: "auto", tools: () => undefined });
	try {
		await app.openSettings("Permissions");
		const card = app.page.locator(".sandbox-environment-card");
		await card.getByRole("button", { name: "Run sandbox self-test", exact: true }).click();
		await expect(card.locator(".sandbox-environment-status")).toHaveText("Available", { timeout: 60_000 });
		await expect(card.locator(".sandbox-environment-issue")).toHaveCount(0);
		await card.screenshot({ path: test.info().outputPath("sandbox-selftest.png") });
	} finally {
		await app.close();
	}
});

test("packaged sandbox executes an actual shell command", async () => {
	const marker = "case-perf-shell-command";
	const app = await launchPermissionApp({
		preset: "auto",
		tools: (text) => text.includes(marker)
			? { name: "bash", arguments: { command: "echo sandbox-command-ok" } }
			: undefined,
	});
	try {
		await app.submit(marker);
		await expect.poll(async () =>
			(await app.approval.count()) > 0 || (await app.page.getByText(`done:${marker}`, { exact: true }).count()) > 0,
			{ timeout: 45_000 },
		).toBe(true);
		if (await app.approval.count()) await app.allowOnce();
		await app.waitDone(marker);
		const primary = app.provider.calls.filter((call) => call.kind === "primary").at(-1);
		const messages = JSON.parse(primary?.payload ?? "{}").messages as Array<{ role: string; content: unknown }>;
		const result = messages.filter((message) => message.role === "tool").at(-1);
		expect(messageText(result?.content)).toMatch(/(?:^|\r?\n)sandbox-command-ok(?:\r?\n|$)/u);
	} finally {
		await app.close();
	}
});

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
