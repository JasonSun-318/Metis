import { createServer } from "node:http";
import type { BrowserAction, BrowserObservation } from "@metis/app-protocol";
import { test as base, expect, type Page } from "@playwright/test";
import { elementId } from "./browser-agent-fixture.ts";
import { callSourceBrowser, launchSourceBrowser } from "./browser-source-harness.ts";

const documents: Record<string, string> = {
	"/select": `<label>Native choices <select id="choices"><option value="start">Start</option><option>  Implicit   value  </option><optgroup label="Group"><option value="first">Same label</option><option value="second">Same label</option><option disabled value="disabled">Disabled option</option></optgroup><optgroup disabled label="Disabled group"><option value="group-disabled">Group option</option></optgroup><option value="last">Last</option><option value="" label="Empty choice">Empty</option><option value="中文" label="Visible label">Other text</option></select></label>
		<label>Disabled choices <select disabled id="disabled-select"><option>Initial</option><option>Other</option></select></label>
		<label>Multiple choices <select multiple id="multiple"><option value="a">A</option><option value="b">B</option></select></label>
		<script>window.changes=[];for(const type of ['input','change'])document.querySelector('#choices').addEventListener(type,event=>changes.push({type,value:event.target.value,trusted:event.isTrusted}));</script>`,
	"/keys": `<label>First field <input id="first" value="original text"></label><label>Second field <input id="second"></label><script>window.keys=[];document.addEventListener('keydown',e=>keys.push({key:e.key,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey,shift:e.shiftKey}));</script>`,
	"/frames": `<h1>Outer page</h1><button id="outer" onclick="this.dataset.hits='1'">Shared action</button><div style="height:900px"></div><iframe title="Same origin" src="/frame" style="width:600px;height:400px"></iframe>`,
	"/frame": `<label>Frame field <input id="field" value="SYNTHETIC_FRAME_SECRET"></label><label>Frame choice <select id="choice"><option value="a">Frame A</option><option value="b">Frame B</option></select></label><button id="inside" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1">Shared action</button><iframe title="Nested" src="/nested" style="width:400px;height:200px"></iframe>`,
	"/nested": `<button id="nested" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1">Nested frame action</button>`,
	"/large": Array.from(
		{ length: 400 },
		(_, index) => `<button onclick="this.dataset.hits='1'">Item ${index} ${"long public label ".repeat(8)}</button>`,
	).join(""),
	"/dynamic": `<button id="stable" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1">Stable action</button><a id="link" href="/first">Stable link</a><p id="ticker">0</p><script>setInterval(()=>document.querySelector('#ticker').textContent=String(Date.now()),25)</script>`,
	"/click": `<button id="target" style="position:absolute;left:80px;top:80px;width:220px;height:80px" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1"><span>Intended action</span></button>
		<button id="overlay" style="position:absolute;left:80px;top:80px;width:220px;height:80px" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1">Covering action</button>
		<button id="nested" style="position:absolute;left:80px;top:210px;width:220px;height:80px" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1"><span style="display:block">Nested label</span></button>`,
	"/redact": `<label>One time code <input id="otp" autocomplete="one-time-code" value="SYNTHETIC_OTP_482913"></label>
		<label>Notes <textarea id="notes">SYNTHETIC_NOTES_PRIVATE</textarea></label>
		<div id="editor" contenteditable="true" role="textbox" aria-label="Editor"><p><b>SYNTHETIC_EDITOR_PRIVATE</b></p></div>
		<p>Public article remains readable</p><button>Continue</button>`,
	"/dialog": `<button id="confirm" onclick="document.querySelector('#result').textContent=String(confirm('Proceed with local test?'))">Confirm locally</button>
		<button id="alert" onclick="alert('Local notice');document.querySelector('#result').textContent='alert closed'">Alert locally</button>
		<button id="next" onclick="this.dataset.hits=Number(this.dataset.hits||0)+1">Next action</button><output id="result">Ready</output>`,
	"/form": `<form onsubmit="event.preventDefault();document.querySelector('#result').textContent='Submitted: '+this.query.value">
		<label>Query <input name="query"></label><button type="submit">Search</button></form><output id="result">Ready</output>`,
	"/checked": `<label><input type="checkbox">Remember choice</label><label><input type="radio" name="appearance">Dark mode</label>`,
};

type SafetyBrowser = {
	page: Page;
	navigate(route: string): Promise<void>;
	observe(input?: Record<string, unknown>): Promise<BrowserObservation>;
	act(
		observation: BrowserObservation,
		action: BrowserAction | { type: "click" | "hover"; elementId: string },
	): ReturnType<typeof callSourceBrowser>;
};
const test = base.extend<{ safetyBrowser: SafetyBrowser }>({
	safetyBrowser: async ({}, use) => {
		const server = createServer((request, response) => {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(
				`<!doctype html><html><head><title>Safety fixture</title></head><body>${documents[request.url ?? ""] ?? "missing"}</body></html>`,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture address");
		const origin = `http://127.0.0.1:${address.port}`;
		let source: Awaited<ReturnType<typeof launchSourceBrowser>> | undefined;
		try {
			source = await launchSourceBrowser();
			const app = source.app;
			const call = (name: string, args: Record<string, unknown>) => callSourceBrowser(app, name, args);
			const opened = await call("browser_tabs", { action: "open" });
			expect(opened.ok, opened.text).toBe(true);
			const browserId = JSON.parse(opened.text).tabs[0].browserId;
			const navigate = async (route: string) => {
				const navigated = await call("browser_navigate", { browserId, action: "goto", url: origin + route });
				expect(navigated.ok, navigated.text).toBe(true);
			};
			await navigate("/click");
			await expect
				.poll(() =>
					app
						.context()
						.pages()
						.some((candidate) => candidate.url() === `${origin}/click`),
				)
				.toBe(true);
			const page = source.app
				.context()
				.pages()
				.find((candidate) => candidate.url() === `${origin}/click`);
			if (!page) throw new Error("Missing controlled page");
			// Keep native dialogs open: only the Metis dialog action may resolve them.
			page.on("dialog", () => undefined);
			await use({
				page,
				navigate,
				async observe(input = {}) {
					const result = await call("browser_observe", { browserId, ...input });
					expect(result.ok, result.text).toBe(true);
					return JSON.parse(result.text);
				},
				act: (observation, action) =>
					call("browser_act", {
						browserId,
						documentId: observation.documentId,
						snapshotRevision: observation.revision,
						origin,
						intent: "Exercise isolated browser safety regression",
						risk: "ordinary",
						action,
					}),
			});
		} finally {
			try {
				await source?.close();
			} finally {
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		}
	},
});

test("selects native options by exact value across implicit values, groups and duplicate labels", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/select");
	for (const value of ["Implicit value", "second", "first", "last", "", "中文"]) {
		const before = await browser.observe();
		const result = await browser.act(before, {
			type: "select",
			elementId: elementId(before.state, "Native choices"),
			value,
		});

		expect(result.ok, result.text).toBe(true);
		await expect(browser.page.locator("#choices")).toHaveValue(value);
	}
	expect(await browser.page.evaluate(() => (window as any).changes)).toEqual(
		["Implicit value", "second", "first", "last", "", "中文"].flatMap((value) => [
			{ type: "input", value, trusted: false },
			{ type: "change", value, trusted: false },
		]),
	);
});

test("selects an option discovered from observation without exposing internal option values", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/select");
	await browser.page
		.locator("#choices")
		.evaluate((element) =>
			(element as HTMLSelectElement).add(new Option("Public choice", "SYNTHETIC_PRIVATE_OPTION_VALUE")),
		);
	let before = await browser.observe();
	expect(before.state).not.toContain("SYNTHETIC_PRIVATE_OPTION_VALUE");
	const id = elementId(before.state, "Native choices");
	const line = before.state.split("\n").find((line) => line.includes(`${id} `))!;
	const options = JSON.parse(line.match(/options=(\[.*\])\]$/)![1]!) as Array<{
		index: number;
		label: string;
		group?: string;
	}>;
	const duplicated = options.filter((option) => option.label === "Same label");
	expect(duplicated).toHaveLength(2);
	expect(duplicated[1]?.group).toBe("Group");
	let result = await browser.act(before, { type: "select", elementId: id, optionIndex: duplicated[1]!.index });
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#choices")).toHaveValue("second");
	before = await browser.observe();
	result = await browser.act(before, {
		type: "select",
		elementId: id,
		optionIndex: options.find((option) => option.label === "Public choice")!.index,
	});
	expect(result.ok, result.text).toBe(true);
	expect(result.text).not.toContain("SYNTHETIC_PRIVATE_OPTION_VALUE");
	await expect(browser.page.locator("#choices")).toHaveValue("SYNTHETIC_PRIVATE_OPTION_VALUE");
	const multipleId = elementId(before.state, "Multiple choices");
	expect(before.state.split("\n").find((line) => line.includes(`${multipleId} `))).not.toContain(
		"actions=click|select",
	);
});

test("rejects unavailable native options without changing the selection", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/select");
	for (const [label, value, reason] of [
		["Native choices", "disabled", "option_unavailable"],
		["Native choices", "group-disabled", "option_unavailable"],
		["Native choices", "missing", "option_not_found"],
		["Disabled choices", "Other", "element_not_interactable"],
		["Multiple choices", "b", "unsupported_select"],
	]) {
		const before = await browser.observe();
		const result = await browser.act(before, {
			type: "select",
			elementId: elementId(before.state, label!),
			value: value!,
		});
		expect(result.ok, result.text).toBe(false);
		const receipt = JSON.parse(result.text);
		expect(receipt.reason).toBe(reason);
		if (reason !== "element_not_interactable")
			expect(receipt).toMatchObject({ status: "failed", execution: "not_started" });
	}
	await expect(browser.page.locator("#choices")).toHaveValue("start");
	expect(await browser.page.evaluate(() => (window as any).changes)).toEqual([]);
	await expect(browser.page.locator("#disabled-select")).toHaveValue("Initial");
	await expect(browser.page.locator("#multiple")).toHaveValues([]);
});

test("distinguishes ambiguous choices from effects caused by a focus handler", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/select");
	await browser.page
		.locator("#choices")
		.evaluate((element) => (element as HTMLSelectElement).add(new Option("Duplicate value", "second")));
	let before = await browser.observe();
	let result = await browser.act(before, {
		type: "select",
		elementId: elementId(before.state, "Native choices"),
		value: "second",
	});
	expect(result.ok).toBe(false);
	expect(JSON.parse(result.text)).toMatchObject({
		status: "failed",
		reason: "option_ambiguous",
		execution: "not_started",
		recovery: "observe",
	});
	await expect(browser.page.locator("#choices")).toHaveValue("start");
	await browser.page.locator("#choices").evaluate((element) =>
		element.addEventListener(
			"focus",
			() => {
				(element as HTMLSelectElement).querySelector('option[value="first"]')!.remove();
			},
			{ once: true },
		),
	);
	before = await browser.observe();
	result = await browser.act(before, {
		type: "select",
		elementId: elementId(before.state, "Native choices"),
		value: "first",
	});
	expect(result.ok).toBe(false);
	expect(JSON.parse(result.text)).toMatchObject({
		status: "failed",
		reason: "select_changed",
		execution: "unknown",
		recovery: "observe",
	});
	await expect(browser.page.locator("#choices")).toHaveValue("start");
	expect(await browser.page.evaluate(() => (window as any).changes)).toEqual([]);
});

test("observes and operates nested same-origin frames with redaction and scrolled geometry", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/frames");
	let before = await browser.observe();
	expect(before.state).toContain("Frame field");
	expect(before.state).toContain("Nested frame action");
	expect(before.state).not.toContain("SYNTHETIC_FRAME_SECRET");
	const ids = [...before.state.matchAll(/(e\d+) button "Shared action"/g)].map((match) => match[1]!);
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
	const clicked = await browser.act(before, {
		type: "click",
		target: { elementId: elementId(before.state, "Nested frame action") },
	});
	expect(clicked.ok, clicked.text).toBe(true);
	await expect(browser.page.frameLocator("iframe").frameLocator("iframe").locator("#nested")).toHaveAttribute(
		"data-hits",
		"1",
	);
	before = await browser.observe();
	const typed = await browser.act(before, {
		type: "type",
		elementId: elementId(before.state, "Frame field"),
		text: "frame replacement",
		replace: true,
	});
	expect(typed.ok, typed.text).toBe(true);
	await expect(browser.page.frameLocator("iframe").locator("#field")).toHaveValue("frame replacement");
	before = await browser.observe();
	const selected = await browser.act(before, {
		type: "select",
		elementId: elementId(before.state, "Frame choice"),
		value: "b",
	});
	expect(selected.ok, selected.text).toBe(true);
	await expect(browser.page.frameLocator("iframe").locator("#choice")).toHaveValue("b");
	await expect(browser.page.locator("#outer")).not.toHaveAttribute("data-hits", "1");
});

test("rejects covered and obsolete same-origin frame targets", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/frames");
	const frame = browser.page.frameLocator("iframe").frameLocator("iframe");
	await frame.locator("#nested").scrollIntoViewIfNeeded();
	await browser.page.locator("iframe").evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const overlay = document.createElement("button");
		overlay.id = "frame-overlay";
		overlay.textContent = "Frame cover";
		overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:99`;
		overlay.onclick = () => {
			overlay.dataset.hits = "1";
		};
		document.body.append(overlay);
	});
	let before = await browser.observe();
	let result = await browser.act(before, {
		type: "click",
		target: { elementId: elementId(before.state, "Nested frame action") },
	});
	expect(result.ok, result.text).toBe(false);
	expect(JSON.parse(result.text)).toMatchObject({ status: "stale", reason: "element_not_interactable" });
	expect(await frame.locator("#nested").getAttribute("data-hits")).toBeNull();
	expect(await browser.page.locator("#frame-overlay").getAttribute("data-hits")).toBeNull();
	await browser.page.locator("#frame-overlay").evaluate((element) => element.remove());
	before = await browser.observe();
	const old = elementId(before.state, "Nested frame action");
	await browser.page
		.frameLocator("iframe")
		.locator("iframe")
		.evaluate((element) => ((element as HTMLIFrameElement).src = "/nested?replaced"));
	await expect(frame.locator("#nested")).toHaveCount(0);
	result = await browser.act(before, { type: "click", target: { elementId: old } });
	expect(result.ok, result.text).toBe(false);
	expect(JSON.parse(result.text)).toMatchObject({ status: "stale", reason: "document_changed" });
	before = await browser.observe();
	const field = elementId(before.state, "Frame field");
	await browser.page.locator("iframe").evaluate((element) => element.remove());
	result = await browser.act(before, { type: "type", elementId: field, text: "must not reach outer page" });
	expect(result.ok, result.text).toBe(false);
	expect((await browser.observe()).state).not.toContain("Frame field");
});

test("applies composite shortcuts and rejects malformed keys without input", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/keys");
	let before = await browser.observe();
	expect(
		(await browser.act(before, { type: "click", target: { elementId: elementId(before.state, "First field") } })).ok,
	).toBe(true);
	let result = await browser.act(await browser.observe(), { type: "press", key: "ControlOrMeta+A" });
	expect(result.ok, result.text).toBe(true);
	result = await browser.act(await browser.observe(), { type: "press", key: "Backspace" });
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#first")).toHaveValue("");
	before = await browser.observe();
	expect(
		(await browser.act(before, { type: "click", target: { elementId: elementId(before.state, "Second field") } })).ok,
	).toBe(true);
	result = await browser.act(await browser.observe(), { type: "press", key: "Shift+Tab" });
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#first")).toBeFocused();
	result = await browser.act(await browser.observe(), { type: "press", key: "Control+Alt+Shift+k" });
	expect(result.ok, result.text).toBe(true);
	expect(await browser.page.evaluate(() => (window as any).keys.at(-1))).toMatchObject({
		key: "K",
		ctrl: true,
		alt: true,
		shift: true,
		meta: false,
	});
	const count = await browser.page.evaluate(() => (window as any).keys.length);
	for (const key of ["Meta+BogusKey", "Control+Control+A", "A+B"])
		expect((await browser.act(await browser.observe(), { type: "press", key })).ok).toBe(false);
	expect(await browser.page.evaluate(() => (window as any).keys.length)).toBe(count);
});

test("uses word-selection shortcuts in native editable fields", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/keys");
	const before = await browser.observe();
	let result = await browser.act(before, {
		type: "type",
		elementId: elementId(before.state, "First field"),
		text: "alpha beta",
		replace: true,
	});
	expect(result.ok, result.text).toBe(true);
	result = await browser.act(await browser.observe(), {
		type: "press",
		key: process.platform === "darwin" ? "Alt+Shift+ArrowLeft" : "Control+Shift+ArrowLeft",
	});
	expect(result.ok, result.text).toBe(true);
	expect(
		await browser.page.locator("#first").evaluate((element) => {
			const input = element as HTMLInputElement;
			return input.value.slice(input.selectionStart!, input.selectionEnd!);
		}),
	).toBe("beta");
	result = await browser.act(await browser.observe(), { type: "press", key: "Backspace" });
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#first")).toHaveValue("alpha ");
	result = await browser.act(await browser.observe(), { type: "press", key: "X" });
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#first")).toHaveValue("alpha X");
});

test("keeps native select arguments literal and detects page changes instead of claiming success", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/select");
	const literal = '");window.injected=true;//';
	await browser.page.locator("#choices").evaluate((element, value) => {
		(element as HTMLSelectElement).add(new Option("Literal option", value));
		(window as any).Event = () => {
			throw new Error("page constructor must not be used");
		};
	}, literal);
	let before = await browser.observe();
	let result = await browser.act(before, {
		type: "select",
		elementId: elementId(before.state, "Native choices"),
		value: literal,
	});
	expect(result.ok, result.text).toBe(true);
	await expect(browser.page.locator("#choices")).toHaveValue(literal);
	expect(await browser.page.evaluate(() => (window as any).injected)).toBeUndefined();
	result = await browser.act(await browser.observe(), {
		type: "select",
		elementId: elementId(before.state, "Native choices"),
		value: literal,
	});
	expect(result.ok, result.text).toBe(true);
	expect(await browser.page.evaluate(() => (window as any).changes.length)).toBe(2);
	await browser.page.locator("#choices").evaluate((element) =>
		element.addEventListener("change", () => {
			(element as HTMLSelectElement).value = "start";
		}),
	);
	before = await browser.observe();
	result = await browser.act(before, {
		type: "select",
		elementId: elementId(before.state, "Native choices"),
		value: "second",
	});
	expect(result.ok, result.text).toBe(false);
	expect(JSON.parse(result.text)).toMatchObject({
		status: "failed",
		reason: "selection_changed",
		execution: "dispatched",
		recovery: "observe",
	});
	expect(result.text).toContain("browser_observe");
	await expect(browser.page.locator("#choices")).toHaveValue("start");
});

test("flat clicks preserve hit testing and invalid targets never dispatch", async ({ safetyBrowser: browser }) => {
	const before = await browser.observe();
	const covered = elementId(before.state, "Intended action");
	const nested = elementId(before.state, "Nested label");
	const invalid = await browser.act(before, {
		type: "click",
		elementId: nested,
		target: { elementId: covered },
	} as any);
	expect(invalid.ok).toBe(false);
	expect(invalid.text).not.toContain("action.key");
	expect(invalid.text).not.toContain("action.text");
	const blocked = await browser.act(before, { type: "click", elementId: covered });
	expect(blocked.ok).toBe(false);
	expect(JSON.parse(blocked.text).reason).toBe("element_not_interactable");
	await expect(browser.page.locator("#target")).not.toHaveAttribute("data-hits");
	await expect(browser.page.locator("#overlay")).not.toHaveAttribute("data-hits");
	await expect(browser.page.locator("#nested")).not.toHaveAttribute("data-hits");
	const clicked = await browser.act(await browser.observe(), { type: "click", elementId: nested });
	expect(clicked.ok, clicked.text).toBe(true);
	await expect(browser.page.locator("#nested")).toHaveAttribute("data-hits", "1");
});

test("rejects an obscured element without clicking its overlay and accepts a nested label", async ({
	safetyBrowser: browser,
}) => {
	let observation = await browser.observe();
	const rejected = await browser.act(observation, {
		type: "click",
		target: { elementId: elementId(observation.state, "Intended action") },
	});
	expect(rejected.ok, rejected.text).toBe(false);
	expect(JSON.parse(rejected.text)).toMatchObject({ status: "stale", reason: "element_not_interactable" });
	expect(await browser.page.locator("#target").getAttribute("data-hits")).toBeNull();
	expect(await browser.page.locator("#overlay").getAttribute("data-hits")).toBeNull();
	observation = await browser.observe();
	const clicked = await browser.act(observation, {
		type: "click",
		target: { elementId: elementId(observation.state, "Nested label") },
	});
	expect(clicked.ok, clicked.text).toBe(true);
	await expect(browser.page.locator("#nested")).toHaveAttribute("data-hits", "1");
	await browser.page.locator("#overlay").evaluate((element) => element.remove());
	observation = await browser.observe();
	const uncovered = await browser.act(observation, {
		type: "click",
		target: { elementId: elementId(observation.state, "Intended action") },
	});
	expect(uncovered.ok, uncovered.text).toBe(true);
	await expect(browser.page.locator("#target")).toHaveAttribute("data-hits", "1");
	await browser.page.locator("#nested").evaluate((element) => {
		element.addEventListener(
			"pointerenter",
			() => {
				const rect = element.getBoundingClientRect();
				const overlay = document.createElement("button");
				overlay.id = "hover-overlay";
				overlay.textContent = "Hover overlay";
				overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;z-index:99`;
				overlay.onclick = () => {
					overlay.dataset.hits = "1";
				};
				document.body.append(overlay);
			},
			{ once: true },
		);
	});
	observation = await browser.observe();
	const coveredOnHover = await browser.act(observation, {
		type: "click",
		target: { elementId: elementId(observation.state, "Nested label") },
	});
	expect(coveredOnHover.ok, coveredOnHover.text).toBe(false);
	await expect(browser.page.locator("#hover-overlay")).toBeAttached();
	expect(await browser.page.locator("#hover-overlay").getAttribute("data-hits")).toBeNull();
	await expect(browser.page.locator("#nested")).toHaveAttribute("data-hits", "1");
});

test("redacts editable descendants in full, changed and diff observations", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/redact");
	const before = await browser.observe();
	expect(before.state).not.toContain("SYNTHETIC_");
	for (const label of ["One time code", "Notes", "Editor", "Public article remains readable"])
		expect(before.state).toContain(label);
	await browser.page.locator("#otp").fill("SYNTHETIC_OTP_CHANGED");
	const changed = await browser.observe({ sinceRevision: before.revision });
	expect(changed.state).not.toContain("SYNTHETIC_");
	const full = await browser.observe();
	expect(full.state).not.toContain("SYNTHETIC_");
	const typed = await browser.act(full, {
		type: "type",
		elementId: elementId(full.state, "Notes"),
		text: "SYNTHETIC_TYPED_PRIVATE",
		replace: true,
	});
	expect(typed.ok, typed.text).toBe(true);
	expect(typed.text).not.toContain("SYNTHETIC_");
	await expect(browser.page.locator("#notes")).toHaveValue("SYNTHETIC_TYPED_PRIVATE");
});

test("reports real checkbox and radio checked states before and after clicks", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/checked");
	for (const label of ["Remember choice", "Dark mode"]) {
		const before = await browser.observe();
		const id = elementId(before.state, label);
		expect(before.state.split("\n").find((line) => line.includes(`${id} `))).toContain("checked=false");
		const clicked = await browser.act(before, { type: "click", target: { elementId: id } });
		expect(clicked.ok, clicked.text).toBe(true);
		const after = await browser.observe();
		expect(after.state.split("\n").find((line) => line.includes(`${id} `))).toContain("checked=true");
		await expect(browser.page.getByLabel(label)).toBeChecked();
	}
});

test("submits a native form with Enter after typing", async ({ safetyBrowser: browser }) => {
	await browser.navigate("/form");
	const before = await browser.observe();
	const typed = await browser.act(before, {
		type: "type",
		elementId: elementId(before.state, "Query"),
		text: "browser automation",
		replace: true,
	});
	expect(typed.ok, typed.text).toBe(true);
	const submitted = await browser.act(await browser.observe(), { type: "press", key: "Enter" });
	expect(submitted.ok, submitted.text).toBe(true);
	await expect(browser.page.locator("#result")).toHaveText("Submitted: browser automation");
});

for (const [label, decision, expected] of [
	["Confirm locally", "accept", "true"],
	["Confirm locally", "dismiss", "false"],
	["Alert locally", "accept", "alert closed"],
] as const) {
	test(`native dialog ${label} ${decision} remains observable and resumes the page`, async ({
		safetyBrowser: browser,
	}) => {
		await browser.navigate("/dialog");
		const before = await browser.observe();
		const opened = await browser.act(before, {
			type: "click",
			target: { elementId: elementId(before.state, label) },
		});
		expect(opened.ok, opened.text).toBe(true);
		expect(JSON.parse(opened.text).state).toContain("actions=dialog");
		const pending = await browser.observe({ mode: "both" });
		expect(pending.state).toContain("dialog");
		const resolved = await browser.act(pending, { type: "dialog", decision });
		expect(resolved.ok, resolved.text).toBe(true);
		await expect(browser.page.locator("#result")).toHaveText(expected);
		const after = await browser.observe();
		const next = await browser.act(after, {
			type: "click",
			target: { elementId: elementId(after.state, "Next action") },
		});
		expect(next.ok, next.text).toBe(true);
		await expect(browser.page.locator("#next")).toHaveAttribute("data-hits", "1");
	});
}

test("reads a large page through bounded JSON continuations and clicks a later-page target", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/large");
	let observation = await browser.observe();
	expect(JSON.stringify(observation).length).toBeLessThan(50_000);
	expect(observation.statePage?.nextCursor).toBeDefined();
	let state = observation.state;
	const revision = observation.revision;
	for (let count = 0; observation.statePage?.nextCursor; count++) {
		expect(count).toBeLessThan(20);
		observation = await browser.observe({ cursor: observation.statePage.nextCursor });
		expect(observation.revision).toBe(revision);
		expect(observation.cursorReset).toBeUndefined();
		expect(observation.statePage?.offset).toBe(state.length);
		expect(JSON.stringify(observation).length).toBeLessThan(50_000);
		state += observation.state;
	}
	expect(state).toContain("Item 399");
	const target = elementId(state, `Item 399 ${"long public label ".repeat(8).trim()}`);
	const clicked = await browser.act(observation, { type: "click", target: { elementId: target } });
	expect(clicked.ok, clicked.text).toBe(true);
	await expect(browser.page.getByRole("button").nth(399)).toHaveAttribute("data-hits", "1");
});

test("clicks a stable ordinary target while an unrelated counter keeps changing", async ({
	safetyBrowser: browser,
}) => {
	await browser.navigate("/dynamic");
	const observation = await browser.observe();
	const before = await browser.page.locator("#ticker").textContent();
	await expect(browser.page.locator("#ticker")).not.toHaveText(before!);
	const clicked = await browser.act(observation, {
		type: "click",
		target: { elementId: elementId(observation.state, "Stable action") },
	});
	expect(clicked.ok, clicked.text).toBe(true);
	await expect(browser.page.locator("#stable")).toHaveAttribute("data-hits", "1");
	const beforeRename = await browser.observe();
	await browser.page.locator("#stable").evaluate((element) => {
		element.textContent = "Changed action";
	});
	const renamed = await browser.act(beforeRename, {
		type: "click",
		target: { elementId: elementId(beforeRename.state, "Stable action") },
	});
	expect(renamed.ok, renamed.text).toBe(false);
	expect(JSON.parse(renamed.text).status).toBe("stale");
	await expect(browser.page.locator("#stable")).toHaveAttribute("data-hits", "1");
	const beforeHref = await browser.observe();
	await browser.page.locator("#link").evaluate((element) => element.setAttribute("href", "/unexpected"));
	const redirected = await browser.act(beforeHref, {
		type: "click",
		target: { elementId: elementId(beforeHref.state, "Stable link") },
	});
	expect(redirected.ok, redirected.text).toBe(false);
	expect(JSON.parse(redirected.text).status).toBe("stale");
	await expect(browser.page).toHaveURL(/\/dynamic$/u);
});
