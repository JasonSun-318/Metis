// Visual and E2E verification of Menu Theme and Update Check components in Chromium.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "metis-menu-theme-"));
const component = (name) => JSON.stringify(join(desktop, "src/renderer/components", name));
const bundle = join(directory, "fixture.js");

// Generate 35 skills for stress-testing submenu scrolling and truncation
const skills = Array.from({ length: 35 }, (_, i) => ({
	name: i === 0
		? "super-extra-extremely-long-skill-identifier-for-overflow-and-ellipsis-testing"
		: `skill-${String(i + 1).padStart(2, "0")}`,
	description: `Description for skill ${i + 1}`,
	source: "user",
	builtin: false,
	canEdit: true,
	canDelete: true,
}));

const mcpServers = [
	{ scope: "user", name: "github", transport: "stdio", enabled: true, toolsCount: 15 },
	{ scope: "project", name: "sqlite-database-tool-server-long-name", transport: "stdio", enabled: true, toolsCount: 8 },
];

await build({
	stdin: {
		resolveDir: resolve(desktop, "../.."),
		loader: "tsx",
		contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountMenu } from ${component("AccountMenu.tsx")};
import { ComposerAddMenu } from ${component("ComposerAddMenu.tsx")};
import { SessionSidebar } from ${component("SessionSidebar.tsx")};
import { setLocale } from ${JSON.stringify(join(desktop, "src/renderer/i18n.ts"))};
import { saveProfileIdentity } from ${JSON.stringify(join(desktop, "src/renderer/profile-identity.ts"))};

window.saveProfileIdentity = saveProfileIdentity;

const noop = () => {};
const skills = ${JSON.stringify(skills)};
const mcpServers = ${JSON.stringify(mcpServers)};

function FixtureRoot() {
	const [sidebarWidth, setSidebarWidth] = useState(302);
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateDownloading, setUpdateDownloading] = useState(false);

	window.__setSidebarWidth = setSidebarWidth;
	window.__setCheckingUpdate = setCheckingUpdate;
	window.__setUpdateDownloading = setUpdateDownloading;

	const session = {
		sessionId: 'fixture-session',
		name: 'Project Discussion and Verification Flow with Extended Long Title',
		mode: 'chat',
		cwd: '/workspace/Metis',
		cwdOrigin: 'user',
		state: 'idle',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return (
		<div style={{ display: 'flex', width: '100%', height: '100vh', overflow: 'hidden' }}>
			<div style={{ width: sidebarWidth, height: '100%', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
				<SessionSidebar
					state={{
						sessionsById: new Map([['fixture-session', session]]),
						sessionOrder: ['fixture-session'],
						activeSessionId: 'fixture-session',
						activeTurnId: null,
						interactionsById: new Map(),
						interactionOrder: [],
					}}
					platform="darwin"
					fullscreen={false}
					destination="tasks"
					onSettings={noop}
					onUpdate={noop}
					onCheckUpdate={() => {
						window.__checkUpdateClicked = (window.__checkUpdateClicked || 0) + 1;
					}}
					checkingUpdate={checkingUpdate}
					updateDownloading={updateDownloading}
					onSkills={noop}
					onSchedules={noop}
					onOpenSchedule={noop}
					onDeleteSchedule={noop}
					onToggle={noop}
					onWidthChange={setSidebarWidth}
					scheduleTasks={[]}
					selectedScheduleTaskId={null}
					updateState={{ status: 'unavailable' }}
					width={sidebarWidth}
					workspace={{
						busy: false,
						mode: 'chat',
						newTaskOpen: false,
						onModeChange: noop,
						onNewTask: noop,
						onOpen: noop,
						onDeleteSession: noop,
						onPinSession: noop,
						onRenameSession: noop,
						onCreateProjectSession: noop,
						onDeleteProject: noop,
						onPinProject: noop,
						onPreviewProjectDelete: noop,
						onRenameProject: noop,
						projectBusy: () => false,
						preferences: new Map(),
						pinnedSessionIds: new Set(),
					}}
				/>
			</div>
			<div style={{ flex: 1, padding: 32, display: 'flex', flexDirection: 'column', gap: 24, overflow: 'auto' }}>
				<h2>Menu Theme & Interaction Test Harness</h2>
				<div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
					<div id="composer-menu-container" style={{ position: 'relative' }}>
						<ComposerAddMenu
							disabled={false}
							skills={skills}
							mcpServers={mcpServers}
							onAddFiles={noop}
							onManageMcp={() => {
								window.__manageMcpClicked = (window.__manageMcpClicked || 0) + 1;
							}}
							onManageSkills={() => {
								window.__manageSkillsClicked = (window.__manageSkillsClicked || 0) + 1;
							}}
							onSelectSkill={(skill) => {
								window.__selectedSkill = skill.name;
							}}
						/>
					</div>
					<div id="composer-menu-container-edge" style={{ position: 'fixed', right: 20, bottom: 40 }}>
						<ComposerAddMenu
							disabled={false}
							skills={skills}
							mcpServers={mcpServers}
							onAddFiles={noop}
							onManageMcp={noop}
							onManageSkills={noop}
							onSelectSkill={(skill) => {
								window.__selectedEdgeSkill = skill.name;
							}}
						/>
					</div>
					<div id="composer-menu-container-tight" style={{ position: 'fixed', left: 4, bottom: 40, width: 204 }}>
						<ComposerAddMenu
							disabled={false}
							skills={skills}
							mcpServers={mcpServers}
							onAddFiles={noop}
							onManageMcp={noop}
							onManageSkills={noop}
							onSelectSkill={noop}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

const root = createRoot(document.getElementById('root'));
root.render(<FixtureRoot />);
await setLocale('en');
window.setLocale = setLocale;
`,
	},
	outfile: bundle,
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	logLevel: "silent",
});

const html = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<link rel="stylesheet" href="/tokens.css">
	<link rel="stylesheet" href="/app.css">
	<style>
		body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
		#root { width: 100vw; height: 100vh; }
	</style>
</head>
<body>
	<div id="root"></div>
	<script type="module" src="/fixture.js"></script>
</body>
</html>`;

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
const browser = await chromium.launch({
	headless: true,
	channel: process.env.PREVIEW_BROWSER_CHANNEL || "chrome",
});

const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

function assertInViewport(box, viewport, name) {
	assert.ok(box.x >= 7, `${name} left (${box.x}) must be >= 7`);
	assert.ok(box.y >= 7, `${name} top (${box.y}) must be >= 7`);
	assert.ok(box.x + box.width <= viewport.width - 7, `${name} right (${box.x + box.width}) must be <= ${viewport.width - 7}`);
	assert.ok(box.y + box.height <= viewport.height - 7, `${name} bottom (${box.y + box.height}) must be <= ${viewport.height - 7}`);
}

try {
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	await page.locator(".session-sidebar").evaluate((el) => el.getAnimations().forEach((a) => a.finish()));

	// 1. Verify CSS Menu Variables exist on document in both Dark and Light themes
	for (const theme of ["dark", "light"]) {
		await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
		const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--menu-bg").trim());
		const hover = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--menu-hover").trim());
		assert.ok(bg.length > 0, `--menu-bg should be defined in ${theme} theme`);
		assert.ok(hover.length > 0, `--menu-hover should be defined in ${theme} theme`);
		assert.notEqual(bg, hover, `--menu-bg and --menu-hover should be distinct in ${theme} theme`);
	}

	// 2. Test AccountMenu in Dark Theme
	await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	const accountTrigger = page.locator(".account-menu-trigger");
	const refreshBtn = page.locator(".account-update-check");
	await expect(accountTrigger).toBeVisible();
	await expect(refreshBtn).toBeVisible();

	// Check layout geometry: refresh button is on the right, does not overlap accountTrigger
	const triggerBox = await accountTrigger.boundingBox();
	const refreshBox = await refreshBtn.boundingBox();
	assert.ok(refreshBox.x >= triggerBox.x + triggerBox.width - 2, "Refresh button must not overlap trigger");
	assert.equal(refreshBox.width, 28, "Refresh button is 28x28");
	assert.equal(refreshBox.height, 28, "Refresh button is 28x28");

	// Open Account Menu Popover
	await accountTrigger.click();
	const accountPopover = page.locator(".account-menu-popover");
	await expect(accountPopover).toBeVisible();

	// Check menu popover background matches --menu-bg
	const popoverBg = await accountPopover.evaluate((el) => getComputedStyle(el).backgroundColor);
	const expectedDarkMenuBg = await page.evaluate(() => {
		const div = document.createElement("div");
		div.style.backgroundColor = "var(--menu-bg)";
		document.body.appendChild(div);
		const color = getComputedStyle(div).backgroundColor;
		div.remove();
		return color;
	});
	assert.equal(popoverBg, expectedDarkMenuBg, "AccountMenu background should match --menu-bg");

	// Check hover state on Settings item
	const settingsBtn = accountPopover.locator("button.account-menu-item");
	const expectedDarkMenuHover = await page.evaluate(() => {
		const div = document.createElement("div");
		div.style.backgroundColor = "var(--menu-hover)";
		document.body.appendChild(div);
		const color = getComputedStyle(div).backgroundColor;
		div.remove();
		return color;
	});
	await settingsBtn.hover();
	await expect.poll(async () => settingsBtn.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedDarkMenuHover);

	await page.screenshot({ path: join(directory, "01-dark-account-menu.png") });

	// Press Escape to close popover
	await page.keyboard.press("Escape");
	await expect(accountPopover).not.toBeVisible();

	// 3. Test AccountMenu in Light Theme
	await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
	await accountTrigger.click();
	await expect(accountPopover).toBeVisible();

	const popoverBgLight = await accountPopover.evaluate((el) => getComputedStyle(el).backgroundColor);
	const expectedLightMenuBg = await page.evaluate(() => {
		const div = document.createElement("div");
		div.style.backgroundColor = "var(--menu-bg)";
		document.body.appendChild(div);
		const color = getComputedStyle(div).backgroundColor;
		div.remove();
		return color;
	});
	assert.equal(popoverBgLight, expectedLightMenuBg, "AccountMenu light background should match --menu-bg");

	const expectedLightMenuHover = await page.evaluate(() => {
		const div = document.createElement("div");
		div.style.backgroundColor = "var(--menu-hover)";
		document.body.appendChild(div);
		const color = getComputedStyle(div).backgroundColor;
		div.remove();
		return color;
	});
	await settingsBtn.hover();
	await expect.poll(async () => settingsBtn.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(expectedLightMenuHover);

	await page.screenshot({ path: join(directory, "02-light-account-menu.png") });
	await page.keyboard.press("Escape");
	await expect(accountPopover).not.toBeVisible();

	// 4. Test Refresh Button interaction and spinning animation
	await refreshBtn.click();
	assert.equal(await page.evaluate(() => window.__checkUpdateClicked), 1, "Refresh click invokes onCheckUpdate");

	// Set checkingUpdate = true -> spin animation
	await page.evaluate(() => window.__setCheckingUpdate(true));
	await expect(refreshBtn).toHaveAttribute("aria-busy", "true");
	const spinner = refreshBtn.locator("svg.is-spinning");
	await expect(spinner).toBeVisible();

	await page.screenshot({ path: join(directory, "03-refresh-spinning.png") });

	// Reduced motion test: spinner should have animation: none
	await page.evaluate(() => (document.documentElement.dataset.motion = "reduced"));
	const animation = await spinner.evaluate((el) => getComputedStyle(el).animationName);
	assert.equal(animation, "none", "is-spinning animation must be none when data-motion is reduced");
	await page.evaluate(() => delete document.documentElement.dataset.motion);

	// Reset checkingUpdate
	await page.evaluate(() => window.__setCheckingUpdate(false));
	await expect(refreshBtn).toHaveAttribute("aria-busy", "false");

	// 5. Test ComposerAddMenu & Skills Submenu Scrolling & Truncation (Dark & Light)
	await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	const composerTrigger = page.locator("#composer-menu-container .composer-add > button");
	await composerTrigger.click();

	const composerMenu = page.locator("#composer-menu-container .composer-add-menu");
	await expect(composerMenu).toBeVisible();

	// Check menu popover background matches --menu-bg
	const composerMenuBg = await composerMenu.evaluate((el) => getComputedStyle(el).backgroundColor);
	assert.equal(composerMenuBg, expectedDarkMenuBg, "ComposerAddMenu background matches --menu-bg");

	const menuAppearance = (element) => {
		const style = getComputedStyle(element);
		return Object.fromEntries(["width", "padding", "gap", "border", "borderRadius", "backgroundColor", "boxShadow"].map((key) => [key, style[key]]));
	};
	const composerAppearance = await composerMenu.evaluate(menuAppearance);

	// Assert main menu bounding box within viewport
	const mainBox = await composerMenu.boundingBox();
	assertInViewport(mainBox, page.viewportSize(), "ComposerAddMenu main menu");

	// Click Skills item to open submenu
	const skillsItem = composerMenu.locator("button:has-text('Skills')");
	await skillsItem.click();
	const skillsSubmenu = page.locator("#composer-menu-container .composer-skill-menu");
	await expect(skillsSubmenu).toBeVisible();

	// Assert skills submenu bounding box within viewport (all 4 edges)
	const skillsSubBox = await skillsSubmenu.boundingBox();
	assertInViewport(skillsSubBox, page.viewportSize(), "Skills submenu");

	// Verify at least 35 skills are rendered
	const skillButtons = skillsSubmenu.locator("> button");
	const count = await skillButtons.count();
	assert.ok(count >= 35, `Skills submenu should have at least 35 items, found ${count}`);

	const firstSkill = skillButtons.first();
	const firstSkillLabel = firstSkill.locator(".composer-menu-item-label");
	const dims = await firstSkillLabel.evaluate((el) => ({
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
		text: el.textContent,
		parentClientWidth: el.parentElement?.clientWidth,
		overflow: getComputedStyle(el).overflow,
		textOverflow: getComputedStyle(el).textOverflow,
		whiteSpace: getComputedStyle(el).whiteSpace,
	}));
	console.log("firstSkillLabel dims:", dims);
	const isTruncated = dims.scrollWidth > dims.clientWidth;
	assert.ok(isTruncated, "First skill with long title should overflow and truncate with ellipsis");

	// Verify clicking first skill works
	await firstSkill.click();
	assert.equal(await page.evaluate(() => window.__selectedSkill), skills[0].name, "Clicking first skill selects it");

	// Reopen for scrolling and screenshot
	await composerTrigger.click();
	await composerMenu.locator("button:has-text('Skills')").click();
	await expect(skillsSubmenu).toBeVisible();

	// Take screenshot while skills submenu is fully open in dark theme
	await page.screenshot({ path: join(directory, "04-dark-composer-skills-submenu.png") });

	// Verify scrolling to and clicking the last skill item
	const lastSkill = skillsSubmenu.locator("button[title='skill-35']");
	await lastSkill.scrollIntoViewIfNeeded();
	await expect(lastSkill).toBeVisible();
	await lastSkill.click();
	assert.equal(await page.evaluate(() => window.__selectedSkill), "skill-35", "Clicking last skill selects it");

	// Reopen and test "Manage skills" button clickability
	await composerTrigger.click();
	await composerMenu.locator("button:has-text('Skills')").click();
	const manageSkillsBtn = skillsSubmenu.locator("button:has-text('Manage skills')");
	await manageSkillsBtn.scrollIntoViewIfNeeded();
	await expect(manageSkillsBtn).toBeVisible();
	await manageSkillsBtn.click();
	assert.equal(await page.evaluate(() => window.__manageSkillsClicked), 1, "Clicking Manage skills invokes callback");

	// Light theme test for ComposerAddMenu
	await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
	await composerTrigger.click();
	await expect(composerMenu).toBeVisible();
	await composerMenu.locator("button:has-text('Skills')").click();
	await expect(skillsSubmenu).toBeVisible();
	await page.screenshot({ path: join(directory, "05-light-composer-skills-submenu.png") });
	await page.keyboard.press("Escape");

	// 5.1 Test MCP Submenu operation
	await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	await composerTrigger.click();
	await expect(composerMenu).toBeVisible();
	const mcpItem = composerMenu.locator("button:has-text('MCP')");
	await mcpItem.click();
	const mcpSubmenu = page.locator("#composer-menu-container .composer-mcp-menu");
	await expect(mcpSubmenu).toBeVisible();

	// Assert MCP submenu bounding box
	const mcpSubBox = await mcpSubmenu.boundingBox();
	assertInViewport(mcpSubBox, page.viewportSize(), "MCP submenu");

	// Verify MCP servers
	const mcpButtons = mcpSubmenu.locator("> button");
	assert.ok(await mcpButtons.count() >= 3, "MCP submenu renders servers and manage button");
	const githubServer = mcpSubmenu.locator("button[title='github']");
	await expect(githubServer).toBeVisible();

	const manageMcpBtn = mcpSubmenu.locator("button:has-text('Manage MCP')");
	await expect(manageMcpBtn).toBeVisible();
	await manageMcpBtn.click();
	assert.equal(await page.evaluate(() => window.__manageMcpClicked), 1, "Clicking Manage MCP invokes callback");

	// 6. Test Edge Alignment (near right edge of screen)
	const edgeTrigger = page.locator("#composer-menu-container-edge .composer-add > button");
	await edgeTrigger.click();
	const edgeMenu = page.locator("#composer-menu-container-edge .composer-add-menu");
	await expect(edgeMenu).toBeVisible();
	const edgeMenuBox = await edgeMenu.boundingBox();
	assertInViewport(edgeMenuBox, page.viewportSize(), "Edge ComposerAddMenu main menu");

	const edgeSkills = edgeMenu.locator("button:has-text('Skills')");
	await edgeSkills.click();
	const edgeSubmenu = page.locator("#composer-menu-container-edge .composer-skill-menu");
	await expect(edgeSubmenu).toHaveClass(/is-align-left/);
	const edgeSubmenuBox = await edgeSubmenu.boundingBox();
	assertInViewport(edgeSubmenuBox, page.viewportSize(), "Edge Skills submenu");

	// Verify edge submenu items are clickable and reachable
	const edgeLastSkill = edgeSubmenu.locator("button[title='skill-35']");
	await edgeLastSkill.scrollIntoViewIfNeeded();
	await expect(edgeLastSkill).toBeVisible();
	await edgeLastSkill.click();
	assert.equal(await page.evaluate(() => window.__selectedEdgeSkill), "skill-35", "Clicking edge last skill selects it");

	await edgeTrigger.click();
	await edgeMenu.locator("button:has-text('Skills')").click();
	await page.screenshot({ path: join(directory, "06-edge-composer-submenu.png") });
	await page.keyboard.press("Escape");

	// 6.1 Test Stacked Alignment in narrow viewport
	const originalViewport = page.viewportSize();
	await page.setViewportSize({ width: 360, height: 720 });
	const tightTrigger = page.locator("#composer-menu-container-tight .composer-add > button");
	await tightTrigger.click();
	const tightMenu = page.locator("#composer-menu-container-tight .composer-add-menu");
	await expect(tightMenu).toBeVisible();
	await tightMenu.locator("button:has-text('Skills')").click();
	const tightSubmenu = page.locator("#composer-menu-container-tight .composer-skill-menu");
	await expect(tightSubmenu).toHaveClass(/is-stacked/);
	const tightSubmenuBox = await tightSubmenu.boundingBox();
	assertInViewport(tightSubmenuBox, page.viewportSize(), "Tight container stacked submenu");
	await page.keyboard.press("Escape");
	await page.setViewportSize(originalViewport);

	// 7. Test Session Three-dot Action Menu
	await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
	const sessionRow = page.locator(".session-row").first();
	await sessionRow.hover();
	const sessionActionTrigger = sessionRow.locator(".session-actions button");
	await sessionActionTrigger.click();

	const sessionActionMenu = page.locator(".session-action-menu");
	await expect(sessionActionMenu).toBeVisible();

	// Check background
	const sessionMenuBg = await sessionActionMenu.evaluate((el) => getComputedStyle(el).backgroundColor);
	assert.equal(sessionMenuBg, expectedDarkMenuBg, "Session action menu background matches --menu-bg");

	assert.deepEqual(await sessionActionMenu.evaluate(menuAppearance), composerAppearance, "Session actions must match the composer menu surface and spacing");
	assertInViewport(await sessionActionMenu.boundingBox(), page.viewportSize(), "Session actions menu");

	// Verify normal and danger item
	const deleteItem = sessionActionMenu.locator("button.session-delete-menu-item");
	await expect(deleteItem).toBeVisible();
	const normalDeleteColor = await deleteItem.evaluate((el) => getComputedStyle(el).color);
	await deleteItem.hover();
	const hoverDeleteColor = await deleteItem.evaluate((el) => getComputedStyle(el).color);
	const hoverDeleteBg = await deleteItem.evaluate((el) => getComputedStyle(el).backgroundColor);
	assert.equal(normalDeleteColor, hoverDeleteColor, "Danger text color remains danger semantic color");
	assert.equal(hoverDeleteBg, expectedDarkMenuHover, "Danger item hover background uses --menu-hover");

	await page.screenshot({ path: join(directory, "07-dark-session-actions.png") });

	await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
	assert.equal(await sessionActionMenu.evaluate((el) => getComputedStyle(el).backgroundColor), expectedLightMenuBg);
	await page.screenshot({ path: join(directory, "09-light-session-actions.png") });
	await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));

	// Test Escape closes session action menu
	await page.keyboard.press("Escape");
	await expect(sessionActionMenu).not.toBeVisible();

	// Test outside click closes session action menu
	await sessionRow.hover();
	await sessionActionTrigger.click();
	await expect(sessionActionMenu).toBeVisible();
	await page.mouse.click(500, 300);
	await expect(sessionActionMenu).not.toBeVisible();

	// 8. Test 760px window and 232px sidebar width with Chinese locale and LONG PROFILE NAME
	await page.setViewportSize({ width: 760, height: 650 });
	await page.evaluate(() => window.__setSidebarWidth(232));
	await page.evaluate(() => window.setLocale("zh-CN"));

	// Explicitly inject a long user profile name via real saveProfileIdentity
	const longDisplayName = "超级超长测试账户用户名展示超出侧边栏容器宽度测试";
	await page.evaluate((name) => window.saveProfileIdentity({ displayName: name, avatarDataUrl: null }), longDisplayName);

	const nameEl = page.locator(".account-menu-name");
	await expect(nameEl).toHaveText(longDisplayName);
	const nameDims = await nameEl.evaluate((el) => ({
		scrollWidth: el.scrollWidth,
		clientWidth: el.clientWidth,
		overflow: getComputedStyle(el).overflow,
		textOverflow: getComputedStyle(el).textOverflow,
	}));
	assert.ok(nameDims.scrollWidth > nameDims.clientWidth, "Long profile display name must truncate with ellipsis");
	assert.equal(nameDims.textOverflow, "ellipsis");

	const sidebarBox = await page.locator(".session-sidebar").boundingBox();
	assert.ok(sidebarBox.width <= 235, "Sidebar width adapted to 232px");
	const refreshBoxNarrow = await refreshBtn.boundingBox();
	const triggerBoxNarrow = await accountTrigger.boundingBox();
	assert.ok(refreshBoxNarrow.x >= triggerBoxNarrow.x + triggerBoxNarrow.width - 2, "Refresh button must not overlap trigger even with long username");
	assert.ok(refreshBoxNarrow.x + refreshBoxNarrow.width <= sidebarBox.x + sidebarBox.width, "Refresh button is within sidebar");

	// Test independent clicking under narrow long-name state
	await refreshBtn.click();
	assert.equal(await page.evaluate(() => window.__checkUpdateClicked), 2, "Refresh button is independently clickable with long name");

	await page.screenshot({ path: join(directory, "08-narrow-760px-zh.png") });

	// Both composer button sizes must retain the same 8px viewport margin.
	await page.evaluate(() => window.setLocale("en"));
	await page.setViewportSize({ width: 760, height: 600 });
	for (const mode of ["", "composer-code"]) {
		for (const [x, y] of [[330, 125], [330, 130], [0, 0], [720, 0], [0, 568], [720, 568]]) {
			await page.evaluate(({ mode, x, y }) => {
				const container = document.getElementById("composer-menu-container");
				container.className = mode;
				container.style.cssText = `position:fixed;left:${x}px;top:${y}px`;
			}, { mode, x, y });
			await composerTrigger.click();
			assertInViewport(await composerMenu.boundingBox(), page.viewportSize(), `${mode || "chat"} menu at ${x},${y}`);
			await composerMenu.locator("button:has-text('Skills')").click();
			await expect(skillsSubmenu).toBeVisible();
			assertInViewport(await skillsSubmenu.boundingBox(), page.viewportSize(), `${mode || "chat"} submenu at ${x},${y}`);
			await page.keyboard.press("Escape");
		}
	}

	assert.deepEqual(errors, [], "No page errors should occur");
	console.log("PASS: All visual, token, interaction, and responsiveness checks succeeded.");
	console.log("Screenshots saved to:", directory);

	// Copy screenshots to acceptance directory and plan assets directory
	const planAssets = "/Users/jason/Metis/docs/plans/assets/2026-09-09-menu-theme";
	const acceptanceDir = join(planAssets, "acceptance");
	const fs = await import("node:fs/promises");
	for (let i = 1; i <= 8; i++) {
		const prefix = `0${i}`;
		const files = (await fs.readdir(directory)).filter((f) => f.startsWith(prefix));
		for (const file of files) {
			const src = join(directory, file);
			await fs.copyFile(src, join(planAssets, file)).catch(() => {});
			await fs.copyFile(src, join(acceptanceDir, file)).catch(() => {});
		}
	}
} catch (error) {
	console.error("Test failed:", error);
	console.error("Page errors:", errors);
	throw error;
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}

