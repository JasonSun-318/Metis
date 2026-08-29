import { describe, expect, it } from "vitest";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	validateBrowserImportInput,
	validateBrowserImportResult,
	validateBrowserImportSourceList,
	validateBrowserProfileList,
	validateCreateBrowserInput,
	validateListBrowserHistoryInput,
} from "../src/shared/desktop-api.ts";

describe("desktop browser profile contracts", () => {
	it("accepts safe profile and import payloads", () => {
		expect(
			validateCreateBrowserInput({
				browserId: "10000000-0000-4000-8000-000000000001",
				profileId: DEFAULT_BROWSER_PROFILE_ID,
			}),
		).toEqual({
			browserId: "10000000-0000-4000-8000-000000000001",
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});
		expect(validateListBrowserHistoryInput({ profileId: DEFAULT_BROWSER_PROFILE_ID })).toEqual({
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		});
		expect(
			validateBrowserImportInput({
				sourceId: "chrome",
				sourceProfileId: "Profile 1",
				dataTypes: { cookies: true, history: true },
			}),
		).toEqual({
			sourceId: "chrome",
			sourceProfileId: "Profile 1",
			dataTypes: { cookies: true, history: true },
		});
		expect(
			validateBrowserImportResult({
				profile: {
					profileId: "10000000-0000-4000-8000-000000000002",
					name: "Personal",
					sourceId: "chrome",
					sourceProfileId: "Default",
				},
				cookies: { imported: 12, skipped: 2 },
				history: { accepted: 480, retained: 500 },
			}),
		).toMatchObject({ cookies: { imported: 12, skipped: 2 }, history: { accepted: 480, retained: 500 } });
	});

	it("accepts only bounded, path-free source metadata", () => {
		expect(
			validateBrowserImportSourceList([
				{
					sourceId: "chrome",
					name: "Google Chrome",
					running: false,
					profiles: [{ sourceProfileId: "Default", name: "Personal", email: "person@example.com" }],
				},
			]),
		).toHaveLength(1);
		expect(
			validateBrowserProfileList([
				{
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					name: "Default",
					sourceId: null,
					sourceProfileId: null,
				},
			]),
		).toHaveLength(1);
	});

	it("rejects forged paths, empty data selections, and secret-shaped results", () => {
		expect(() =>
			validateBrowserImportInput({
				sourceId: "safari",
				sourceProfileId: "Default",
				dataTypes: { cookies: true, history: false },
			}),
		).toThrow("Invalid browser source");
		expect(() =>
			validateBrowserImportInput({
				sourceId: "chrome",
				sourceProfileId: "../Default",
				dataTypes: { cookies: true, history: false },
			}),
		).toThrow("Invalid source profile id");
		expect(() =>
			validateBrowserImportInput({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: false, history: false },
			}),
		).toThrow("Select browser data");
		expect(() =>
			validateBrowserImportResult({
				profile: {
					profileId: DEFAULT_BROWSER_PROFILE_ID,
					name: "Default",
					sourceId: null,
					sourceProfileId: null,
				},
				cookies: { imported: 1, skipped: 0, values: ["secret"] },
				history: null,
			}),
		).toThrow();
	});
});
