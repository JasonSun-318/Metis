import { describe, expect, it } from "vitest";
import { createSandboxRuntimeConfig, exactNetworkGrantAllows } from "../src/core/workspace-sandbox-broker.ts";
import { pathsIntersect } from "../src/utils/paths.ts";

describe("workspace sandbox broker policy", () => {
	it("allows only an exact canonical host and port", () => {
		const endpoints = [{ hostname: "api.example.com", port: 443 }];
		expect(exactNetworkGrantAllows(endpoints, { host: "API.EXAMPLE.COM.", port: 443 })).toBe(true);
		for (const target of [
			{ host: "api.example.com", port: 80 },
			{ host: "sub.api.example.com", port: 443 },
			{ host: "evil-example.com", port: 443 },
			{ host: "*.example.com", port: 443 },
			{ host: "user@api.example.com", port: 443 },
			{ host: "127.0.0.1", port: 443 },
			{ host: "localhost", port: 443 },
		]) {
			expect(exactNetworkGrantAllows(endpoints, target), JSON.stringify(target)).toBe(false);
		}
	});

	it("builds deny-first filesystem policy and delegates every network decision to the exact endpoint gate", () => {
		const protectedPaths = ["/work/.git", "/work/.metis", "/work/.codex", "/work/.agents"];
		const config = createSandboxRuntimeConfig({
			workspaceRoots: ["/work"],
			readOnlyRoots: ["/read"],
			writeRoots: ["/work/out"],
			protectedRoots: ["/secret"],
			writeProtectedRoots: protectedPaths,
			temporaryDir: "/private/tmp/sandbox",
			runtimeReads: ["/bin"],
		});

		expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining(["/work", "/work/out"]));
		expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(protectedPaths));
		for (const allowed of config.filesystem.allowWrite) {
			for (const denied of config.filesystem.denyWrite.filter((path) => !protectedPaths.includes(path))) {
				expect(pathsIntersect(allowed, denied), `${allowed} conflicts with ${denied}`).toBe(false);
			}
		}
		expect(config.network).toMatchObject({ allowedDomains: [], deniedDomains: [], strictAllowlist: false });
	});

	it("relies on the isolated Windows account for system reads and grants only user-owned runtime paths", () => {
		const config = createSandboxRuntimeConfig(
			{
				workspaceRoots: ["C:\\Users\\jason\\project"],
				readOnlyRoots: [],
				writeRoots: [],
				protectedRoots: [],
				writeProtectedRoots: [],
				temporaryDir: "C:\\Users\\jason\\AppData\\Local\\Temp\\metis-sandbox",
				runtimeReads: ["C:\\Windows", "C:\\Program Files", "C:\\Users\\jason\\AppData\\Local\\Metis\\native-tools"],
			},
			"win32",
			"C:\\Users\\jason",
		);

		expect(config.filesystem.denyRead).toEqual([]);
		expect(config.filesystem.allowRead).toContain("C:\\Users\\jason\\AppData\\Local\\Metis\\native-tools");
		expect(config.filesystem.allowRead).not.toContain("C:\\Windows");
		expect(config.filesystem.allowRead).not.toContain("C:\\Program Files");
	});
});
