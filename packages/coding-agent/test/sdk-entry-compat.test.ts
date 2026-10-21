import { describe, expect, it } from "vitest";
import * as runtime from "../src/core/agent-session-runtime.ts";
import * as services from "../src/core/agent-session-services.ts";
import * as sdk from "../src/core/sdk.ts";
import * as host from "../src/host.ts";
import * as root from "../src/index.ts";

type ValueModule = Record<string, unknown>;

function values(module: object): ValueModule {
	return module as ValueModule;
}

const runtimeValues = values(runtime);
const servicesValues = values(services);
const sdkValues = values(sdk);
const hostValues = values(host);
const rootValues = values(root);

describe("SDK entry compatibility", () => {
	it("keeps createAgentSession as the same SDK and package-root binding", () => {
		expect(rootValues.createAgentSession).toBe(sdkValues.createAgentSession);
	});

	it("preserves every runtime value export through SDK and root with the original identity", () => {
		const names = Object.keys(runtimeValues);
		expect(names.length).toBeGreaterThan(0);

		for (const name of names) {
			expect(sdkValues, `sdk is missing runtime export ${name}`).toHaveProperty(name);
			expect(sdkValues[name], `sdk rebinds runtime export ${name}`).toBe(runtimeValues[name]);

			if (name === "SessionImportFileNotFoundError") {
				// This runtime-only error stays a deep SDK import; root and host must not grow it.
				expect(rootValues).not.toHaveProperty(name);
				continue;
			}
			expect(rootValues, `root is missing runtime export ${name}`).toHaveProperty(name);
			expect(rootValues[name], `root rebinds runtime export ${name}`).toBe(runtimeValues[name]);
		}
	});

	it("preserves every services factory binding across runtime, host, SDK and root", () => {
		const names = Object.keys(servicesValues);
		expect(names.length).toBeGreaterThan(0);

		for (const name of names) {
			for (const [entryName, entry] of Object.entries({
				runtime: runtimeValues,
				host: hostValues,
				sdk: sdkValues,
				root: rootValues,
			})) {
				expect(entry, `${entryName} is missing services export ${name}`).toHaveProperty(name);
				expect(entry[name], `${entryName} rebinds services export ${name}`).toBe(servicesValues[name]);
			}
		}
	});

	it("keeps createAgentSession out of host and SessionImportFileNotFoundError out of root and host", () => {
		expect(hostValues).not.toHaveProperty("createAgentSession");
		expect(hostValues).not.toHaveProperty("SessionImportFileNotFoundError");
		expect(rootValues).not.toHaveProperty("SessionImportFileNotFoundError");
		expect(sdkValues).toHaveProperty("SessionImportFileNotFoundError");
		expect(sdkValues.SessionImportFileNotFoundError).toBe(runtimeValues.SessionImportFileNotFoundError);
	});
});
