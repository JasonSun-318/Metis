import { describe, expect, it, vi } from "vitest";
import {
	findMcpDefinition,
	isValidMcpEnvironmentName,
	parseMcpEnvironmentName,
} from "../src/core/mcp/configuration-helpers.ts";

describe("MCP configuration helpers", () => {
	it("keeps the CLI and TUI environment-name rules distinct", () => {
		for (const value of ["TOKEN", " TOKEN ", "MCP TOKEN", "   "]) {
			expect(isValidMcpEnvironmentName(value)).toBe(true);
		}
		for (const value of ["", "TOKEN=value", "TO\0KEN"]) {
			expect(isValidMcpEnvironmentName(value)).toBe(false);
		}

		expect(parseMcpEnvironmentName("  TOKEN  ", "--env")).toBe("  TOKEN  ");
		for (const value of ["", "   ", "TOKEN=value", "TO\0KEN"]) {
			expect(() => parseMcpEnvironmentName(value, "--bearer-token-env-var")).toThrow(
				"--bearer-token-env-var requires an environment variable name",
			);
		}
	});

	it("looks up project definitions first and only reads global definitions when needed", () => {
		const project = { docs: { url: "https://project.example.test/mcp" } };
		const global = {
			docs: { url: "https://global.example.test/mcp" },
			other: { command: "global-server" },
		};
		const getGlobalServers = vi.fn(() => global);

		expect(findMcpDefinition("docs", project, getGlobalServers, "user")).toEqual({
			scope: "project",
			server: project.docs,
		});
		expect(getGlobalServers).not.toHaveBeenCalled();

		expect(findMcpDefinition("other", project, getGlobalServers, "user")).toEqual({
			scope: "user",
			server: global.other,
		});
		expect(getGlobalServers).toHaveBeenCalledTimes(1);

		expect(findMcpDefinition("missing", project, getGlobalServers, "global")).toBeUndefined();
		expect(getGlobalServers).toHaveBeenCalledTimes(2);
	});
});
