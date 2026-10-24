import { describe, expect, it } from "vitest";
import { nativeSelectMetadata } from "../src/main/browser-native-select.ts";

const option = (text: string, attributes: string[] = []) => ({
	nodeName: "OPTION",
	attributes,
	children: [{ nodeName: "#text", nodeValue: text }],
});

describe("native select observation metadata", () => {
	it("preserves implicit values, label attributes and group indexes without conflating equal labels", () => {
		const metadata = nativeSelectMetadata({
			node: {
				nodeName: "SELECT",
				children: [
					option(" \tImplicit \n text "),
					{
						nodeName: "OPTGROUP",
						attributes: ["label", "Group"],
						children: [option("Same", ["value", "first"]), option("Same", ["value", "second"])],
					},
					option("Underlying", ["value", "", "label", "Visible"]),
				],
			},
		});
		expect(metadata).toEqual({
			multiple: false,
			truncated: false,
			options: [
				{ index: 0, value: "Implicit text", label: "Implicit text", disabled: false },
				{ index: 1, value: "first", label: "Same", group: "Group", disabled: false },
				{ index: 2, value: "second", label: "Same", group: "Group", disabled: false },
				{ index: 3, value: "", label: "Visible", disabled: false },
			],
		});
	});
	it("keeps non-ASCII whitespace and excludes script contents from implicit option text", () => {
		const metadata = nativeSelectMetadata({
			node: {
				nodeName: "SELECT",
				children: [
					{
						nodeName: "OPTION",
						children: [
							{ nodeName: "#text", nodeValue: "\u00a0中文\u00a0" },
							{ nodeName: "SCRIPT", children: [{ nodeName: "#text", nodeValue: "SYNTHETIC_SCRIPT_SECRET" }] },
						],
					},
				],
			},
		});
		expect(metadata?.options[0]).toMatchObject({ value: "\u00a0中文\u00a0", label: "\u00a0中文\u00a0" });
	});
	it("reports disabled groups, hidden options and multiple controls", () => {
		const metadata = nativeSelectMetadata({
			node: {
				nodeName: "SELECT",
				attributes: ["multiple", ""],
				children: [
					{ nodeName: "OPTGROUP", attributes: ["disabled", ""], children: [option("Disabled")] },
					option("Hidden", ["hidden", ""]),
				],
			},
		});
		expect(metadata?.multiple).toBe(true);
		expect(metadata?.options.map((option) => option.disabled)).toEqual([true, true]);
	});
	it("bounds the advertised option indexes and marks omitted options", () => {
		const metadata = nativeSelectMetadata({
			node: { nodeName: "SELECT", children: Array.from({ length: 1001 }, (_, i) => option(String(i))) },
		});
		expect(metadata?.truncated).toBe(true);
		expect(metadata?.options).toHaveLength(1000);
		expect(metadata?.options.at(-1)?.index).toBe(999);
	});
	it("does not advertise native selection for custom comboboxes or text inputs", () => {
		expect(nativeSelectMetadata({ node: { nodeName: "DIV", attributes: ["role", "combobox"] } })).toBeUndefined();
		expect(
			nativeSelectMetadata({ node: { nodeName: "INPUT", attributes: ["value", "SYNTHETIC_SECRET"] } }),
		).toBeUndefined();
	});
});
