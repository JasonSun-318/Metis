import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { BrowserObservation, BrowserTabsDetails } from "@metis/app-protocol";
import { callSourceBrowser, launchSourceBrowser } from "./browser-source-harness.ts";

test("real browser pages retain actor ownership, support explicit parent review, and honor user takeover", async () => {
	const server = createServer((request, response) => {
		if (request.url === "/slow") return;
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(`<!doctype html><title>Actor ownership</title>
			<button onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)" data-clicks="0">Increment</button>
			<label>Course<select id="course"><option value="basic">Basic</option><option value="advanced">Advanced</option></select></label>
			<iframe title="Same-origin enrollment" srcdoc="<button onclick=&quot;this.dataset.done='yes'&quot;>Frame confirm</button>"></iframe>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const browser = await launchSourceBrowser();
	const call = async <T>(name: string, input: Record<string, unknown>, actorId?: string): Promise<T> => {
		const result = await callSourceBrowser(browser.app, name, input, actorId);
		expect(result.ok, result.text).toBe(true);
		return JSON.parse(result.text) as T;
	};
	const clickCount = (url: string) => browser.app.evaluate(async ({ webContents }, target) => {
		const page = webContents.getAllWebContents().find((contents) => contents.getURL() === target);
		if (!page) throw new Error("Expected real embedded browser page");
		return Number(await page.executeJavaScript('document.querySelector("button").dataset.clicks'));
	}, url);
	try {
		const first = (await call<BrowserTabsDetails>("browser_tabs", { action: "open" }, "child-a")).tabs[0]!;
		const second = (await call<BrowserTabsDetails>("browser_tabs", { action: "open" }, "child-b")).tabs.find((tab) => tab.browserId !== first.browserId)!;
		expect(first.ownerAgentId).toBe("child-a");
		expect(second.ownerAgentId).toBe("child-b");
		await Promise.all([
			call("browser_navigate", { browserId: first.browserId, action: "goto", url: `${origin}/first` }, "child-a"),
			call("browser_navigate", { browserId: second.browserId, action: "goto", url: `${origin}/second` }, "child-b"),
		]);
		const observation = await call<BrowserObservation>("browser_observe", { browserId: first.browserId }, "child-a");
		const elementId = observation.state.match(/\b(e\d+)\b[^\n]*button[^\n]*Increment/)?.[1];
		expect(elementId, observation.state).toBeTruthy();
		const action = { browserId: first.browserId, documentId: observation.documentId, snapshotRevision: observation.revision,
			origin, intent: "Increment the fixture counter once", risk: "ordinary", action: { type: "click", elementId } };
		const blocked = await callSourceBrowser(browser.app, "browser_act", action, "child-b");
		expect(blocked.ok).toBe(false);
		expect(JSON.parse(blocked.text)).toMatchObject({ code: "PAGE_IN_USE", ownerAgentId: "child-a", execution: "not_started", recovery: "request_owner_release" });
		expect(await clickCount(`${origin}/first`)).toBe(0);
		await call("browser_act", action, "child-a");
		expect(await clickCount(`${origin}/first`)).toBe(1);
		let selected = await call<BrowserObservation>("browser_observe", { browserId: first.browserId }, "child-a");
		const courseId = selected.state.match(/\b(e\d+)\b[^\n]*combobox[^\n]*Course/)?.[1];
		expect(courseId, selected.state).toBeTruthy();
		await call("browser_act", { ...action, documentId: selected.documentId, snapshotRevision: selected.revision,
			action: { type: "select", elementId: courseId, optionIndex: 1 } }, "child-a");
		selected = await call<BrowserObservation>("browser_observe", { browserId: first.browserId }, "child-a");
		const frameButtonId = selected.state.match(/\b(e\d+)\b[^\n]*button[^\n]*Frame confirm/)?.[1];
		expect(frameButtonId, selected.state).toBeTruthy();
		await call("browser_act", { ...action, documentId: selected.documentId, snapshotRevision: selected.revision,
			action: { type: "click", elementId: frameButtonId } }, "child-a");
		const enrollment = await browser.app.evaluate(async ({ webContents }, target) => {
			const page = webContents.getAllWebContents().find((contents) => contents.getURL() === target)!;
			return await page.executeJavaScript(`({ course: document.querySelector('select').value, confirmed: document.querySelector('iframe').contentDocument.querySelector('button').dataset.done })`);
		}, `${origin}/first`);
		expect(enrollment).toEqual({ course: "advanced", confirmed: "yes" });
		// The root can explicitly release an idle child's page and re-observe for its review.
		await call("browser_tabs", { action: "release", browserId: first.browserId });
		await call("browser_observe", { browserId: first.browserId });
		const ownership = await call<BrowserTabsDetails>("browser_tabs", { action: "list" });
		expect(ownership.tabs.find((tab) => tab.browserId === first.browserId)?.ownerAgentId).not.toBe("child-a");
		await call("browser_tabs", { action: "release", browserId: first.browserId });
		const transferred = await call<BrowserObservation>("browser_observe", { browserId: first.browserId }, "child-b");
		const transferredButton = transferred.state.match(/\b(e\d+)\b[^\n]*button[^\n]*Increment/)?.[1];
		await call("browser_act", { ...action, documentId: transferred.documentId, snapshotRevision: transferred.revision,
			action: { type: "click", elementId: transferredButton } }, "child-b");
		expect(await clickCount(`${origin}/first`)).toBe(2);
		await call("browser_tabs", { action: "release", browserId: first.browserId }, "child-b");
		const navigation = callSourceBrowser(browser.app, "browser_navigate", { browserId: first.browserId, action: "goto", url: `${origin}/slow` }, "child-a");
		await expect.poll(async () => (await call<BrowserTabsDetails>("browser_tabs", { action: "list" })).tabs.find((tab) => tab.browserId === first.browserId)?.controlState).toBe("agent");
		await browser.app.evaluate(async (_electron, browserId) => (await globalThis.metisBrowserSourceReady).takeControl(browserId), first.browserId);
		const taken = await callSourceBrowser(browser.app, "browser_act", action, "child-b");
		expect(taken.ok).toBe(false);
		expect(JSON.parse(taken.text)).toMatchObject({ code: "PAGE_IN_USE", recovery: "wait_for_user" });
		const parentRelease = await callSourceBrowser(browser.app, "browser_tabs", { action: "release", browserId: first.browserId });
		expect(parentRelease.ok).toBe(false);
		expect(JSON.parse(parentRelease.text)).toMatchObject({ code: "PAGE_IN_USE", recovery: "wait_for_user" });
		await expect.poll(async () => (await call<BrowserTabsDetails>("browser_tabs", { action: "list" })).tabs.find((tab) => tab.browserId === first.browserId)?.controlState).toBe("handoff");
		await browser.app.evaluate(async (_electron, browserId) => (await globalThis.metisBrowserSourceReady).resolveHandoff(browserId, "cancel"), first.browserId);
		expect(await navigation).toMatchObject({ ok: true, text: "Browser control cancelled: user_cancelled" });
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
