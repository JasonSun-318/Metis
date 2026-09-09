// Real sidebar + file icons in Chromium; no running Metis instance is controlled.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "metis-navigation-icons-"));
const component = (name) => JSON.stringify(join(desktop, "src/renderer/components", name));
const bundle = join(directory, "fixture.js");
await build({
	stdin: {
		resolveDir: resolve(desktop, "../.."),
		loader: "tsx",
		contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SessionSidebar} from ${component("SessionSidebar.tsx")};
import {WorkspaceFileIcon} from ${component("WorkspaceFileIcon.tsx")};
import {setLocale} from ${JSON.stringify(join(desktop, "src/renderer/i18n.ts"))};
localStorage.setItem('metis.session-grouping.v1', JSON.stringify({chat:'project',code:'project'}));
const noop=()=>{}; const root=createRoot(document.getElementById('root'));
const session={sessionId:'fixture',name:'Navigation preview',mode:'chat',cwd:'/workspace/Metis',cwdOrigin:'user',state:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
window.renderFixture=(busy=false)=>root.render(<>
<SessionSidebar state={{sessionsById:new Map([['fixture',session]]),sessionOrder:['fixture'],activeSessionId:null,activeTurnId:null,interactionsById:new Map(),interactionOrder:[]}}
 platform="darwin" fullscreen={false} destination="tasks" onSettings={noop} onUpdate={noop} onSkills={noop} onSchedules={noop} onOpenSchedule={noop} onDeleteSchedule={noop} onToggle={noop} onWidthChange={noop} scheduleTasks={[]} selectedScheduleTaskId={null} updateState={{status:'unavailable'}} width={302}
 workspace={{busy,mode:'chat',newTaskOpen:false,onModeChange:noop,onNewTask:()=>window.taskClicks=(window.taskClicks||0)+1,onOpen:noop,onDeleteSession:noop,onPinSession:noop,onRenameSession:noop,onCreateProjectSession:noop,onDeleteProject:noop,onPinProject:noop,onPreviewProjectDelete:noop,onRenameProject:noop,projectBusy:()=>false,preferences:new Map(),pinnedSessionIds:new Set()}}/>
<section style={{padding:32}}><h2>Workspace</h2><button id="folder-fixture" disabled={busy} style={{display:'flex',alignItems:'center',gap:8,padding:12}}><WorkspaceFileIcon kind="directory" path="/workspace/documents" expanded={false}/>documents</button></section>
</>);
await setLocale('en'); window.setLocale=setLocale; window.renderFixture();
`,
	},
	outfile: bundle,
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	logLevel: "silent",
});
const html =
	'<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"><style>#root{display:flex;height:100vh}body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';
const server = createServer(async (req, res) => {
	const files = {
		"/fixture.js": [bundle, "text/javascript"],
		"/app.css": [join(desktop, "src/renderer/styles/app.css"), "text/css"],
		"/tokens.css": [join(desktop, "src/renderer/styles/tokens.css"), "text/css"],
	};
	const entry = files[req.url];
	if (req.url === "/") {
		res.setHeader("Content-Type", "text/html");
		res.end(html);
	} else if (entry) {
		res.setHeader("Content-Type", entry[1]);
		res.end(await readFile(entry[0]));
	} else {
		res.writeHead(404);
		res.end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.PREVIEW_BROWSER_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	const task = page.getByRole("button", { name: "New task", exact: true });
	await expect(task).toBeVisible();
	await page.locator(".session-sidebar").evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
	const buttons = [
		task,
		page.getByRole("button", { name: "Customize", exact: true }),
		page.getByRole("button", { name: "Scheduled tasks", exact: true }),
		page.locator(".project-heading"),
		page.locator("#folder-fixture"),
	];
	const moveAway = () => page.mouse.move(1000, 700);
	const animationCount = () =>
		page.locator(".nav-icon-motion").evaluateAll((nodes) => nodes.flatMap((n) => n.getAnimations()).length);
	for (const button of buttons) {
		await moveAway();
		const before = await button.boundingBox();
		// Hover the row label/padding, well away from its icon.
		await button.hover({ position: { x: Math.min(70, before.width - 12), y: before.height / 2 } });
		const motion = button.locator(".nav-icon-motion");
		await expect.poll(() => motion.evaluate((el) => el.getAnimations().length)).toBe(1);
		assert.equal(await animationCount(), 1, "siblings must stay still");
		const transformed = await motion.evaluate((el) => {
			const a = el.getAnimations()[0];
			a.pause();
			a.currentTime = 300;
			return { transform: getComputedStyle(el).transform, iterations: a.effect.getTiming().iterations };
		});
		assert.notEqual(transformed.transform, "none");
		assert.notEqual(transformed.transform, "matrix(1, 0, 0, 1, 0, 0)");
		assert.equal(transformed.iterations, 1);
		assert.deepEqual(await button.boundingBox(), before, "animation must not move the option");
		await motion.evaluate((el) => el.getAnimations()[0].finish());
		assert.equal(await motion.evaluate((el) => getComputedStyle(el).transform), "none", "returns to static shape");
		await moveAway();
		assert.equal(await animationCount(), 0);
		await button.hover();
		assert.equal(await motion.evaluate((el) => el.getAnimations().length), 1, "replays on next hover");
	}
	await moveAway();
	// Native keyboard focus triggers the same animation, without requiring mouseover.
	await task.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	assert.equal(await task.evaluate((el) => el.matches(":focus-visible")), true);
	assert.equal(await task.locator(".nav-icon-motion").evaluate((el) => el.getAnimations().length), 1);
	await task.click();
	assert.equal(await page.evaluate(() => window.taskClicks), 1, "navigation action still fires");
	await task.evaluate((el) => el.blur());
	await moveAway();
	for (const preference of ["system", "app"]) {
		if (preference === "system") await page.emulateMedia({ reducedMotion: "reduce" });
		else await page.evaluate(() => (document.documentElement.dataset.motion = "reduced"));
		await task.hover();
		await expect.poll(animationCount).toBe(0);
		await moveAway();
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await page.evaluate(() => delete document.documentElement.dataset.motion);
	}
	await page.evaluate(() => window.renderFixture(true));
	await expect(task).toBeDisabled();
	await task.hover();
	assert.equal(await animationCount(), 0, "disabled navigation stays still");
	await moveAway();
	await page.evaluate(() => window.renderFixture(false));
	await expect(task).toBeEnabled();
	const folder = page.locator(".project-heading");
	const openPath = await folder.locator(".nav-icon-motion").getAttribute("d");
	await folder.click();
	assert.notEqual(
		await folder.locator(".nav-icon-motion").getAttribute("d"),
		openPath,
		"folder state remains distinct",
	);
	await page.setViewportSize({ width: 760, height: 650 });
	await page.evaluate(() => window.setLocale("zh-CN"));
	for (const theme of ["dark", "light"]) {
		await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
		await moveAway();
		await page.screenshot({ path: join(directory, `navigation-${theme}.png`) });
	}
	assert.deepEqual(errors, []);
	console.log(
		"PASS: row hover, single finite animation, replay, stable layout, keyboard focus, disabled state, system/app reduced motion, click actions, folder state.",
	);
	console.log("Screenshots:", directory);
} catch (error) {
	console.error(error);
	console.error("Browser errors:", errors);
	console.error(await page.locator("body").innerText());
	throw error;
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
