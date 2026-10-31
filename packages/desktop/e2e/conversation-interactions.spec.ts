import path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

async function expectCustomAnswerAligned(card: Locator) {
	const offset = await card.locator(".ask-user-custom").evaluate((row) => {
		const icon = row.querySelector(".ask-user-option-number")!.getBoundingClientRect();
		const input = row.querySelector("textarea")!.getBoundingClientRect();
		return Math.abs(icon.top + icon.height / 2 - input.top - input.height / 2);
	});
	expect(offset).toBeLessThanOrEqual(1);
}

async function expectCompactGaps(card: Locator) {
	await expect.poll(() => card.evaluate((node) => {
		const group = node.closest(".transcript-tool-group")!;
		const execution = group.querySelector(":scope > .execution-chain, :scope > .code-execution");
		const answer = group.nextElementSibling!;
		const rect = node.getBoundingClientRect();
		const gaps = [answer.getBoundingClientRect().top - rect.bottom];
		if (execution) {
			const visibleExecution = execution.hasAttribute("open") ? execution : execution.querySelector(":scope > summary")!;
			gaps.push(rect.top - visibleExecution.getBoundingClientRect().bottom);
		}
		return gaps.every((gap) => Math.abs(gap - 10) <= 1);
	})).toBe(true);
}

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: inline questions, approvals and tasks preserve drafts and history`, async ({}, testInfo) => {
		test.setTimeout(180_000);
		const app = await launchPermissionApp({ mode, preset: "ask", locale: "en", tools: (marker, dirs) => {
			if (marker.includes("case-question")) return { name: "ask_user", arguments: { questions: [
				{ question: "Which direction should we take?", multiple: false, options: [{ label: "Inspect first", description: "Read the current implementation before making changes." }, { label: "Discuss first", description: "Align on the design before implementation." }] },
				{ question: "Which checks should be included?", multiple: true, options: [{ label: "UI acceptance" }, { label: "Regression tests" }] },
			] } };
			if (marker.includes("case-permission")) return { name: "bash", arguments: { command: `printf 'approved' > '${path.join(dirs.outsideDir, `${marker.match(/case-permission[a-z-]*/)?.[0]}.txt`)}'` } };
			if (marker.includes("case-tasks")) return { name: "set_tasks", arguments: { tasks: [{ task: marker.includes("completed") ? "Completed earlier work" : "Review the proposed interface", completed: marker.includes("completed") }, { task: "Verify the implementation", completed: marker.includes("completed") }] } };
			return undefined;
		} });
		try {
			const page = app.page;
			await page.setViewportSize({ width: 1280, height: 900 });
			await app.submit("case-history\n" + "Earlier conversation context.\n".repeat(70));
			await expect(page.getByText(/^done:case-history/).last()).toBeVisible();
			await app.submit("case-question");
			const card = page.locator(".conversation-interaction-card.is-pending");
			await expect(card.locator(".ask-user-panel")).toBeVisible();
			await expect(page.locator(".composer-panels .ask-user-panel")).toHaveCount(0);
			const geometry = await card.evaluate((node) => {
				const column = node.closest(".transcript-turn, .code-transcript-turn")!;
				const a = node.getBoundingClientRect(), b = column.getBoundingClientRect();
				return { left: a.left - b.left, right: a.right - b.right, buttons: Array.from(node.querySelectorAll(".ask-user-actions button")).map((button) => button.getBoundingClientRect().height) };
			});
			expect(Math.abs(geometry.left)).toBeLessThanOrEqual(2);
			expect(Math.abs(geometry.right)).toBeLessThanOrEqual(2);
			expect(Math.max(...geometry.buttons)).toBeLessThanOrEqual(32);
			await expectCustomAnswerAligned(card);
			const input = page.locator("#composer-input");
			await input.fill("Keep this draft while I answer");
			const requests = app.provider.primaryCount;
			await input.press("Enter");
			expect(app.provider.primaryCount).toBe(requests);
			await expect(input).toContainText("Keep this draft while I answer");
			await card.getByRole("radio", { name: /Inspect first/ }).click();
			await page.screenshot({ path: testInfo.outputPath(`${mode}-questions-dark.png`) });
			await page.locator(".transcript-scroll").evaluate((node) => { node.scrollTop = 0; });
			await expect(page.getByRole("button", { name: "View pending request", exact: true })).toBeVisible();
			await expect(card.getByRole("radio", { name: /Inspect first/ })).toHaveAttribute("aria-checked", "true");
			await page.getByRole("button", { name: "View pending request", exact: true }).click();
			await expect(card).toBeInViewport();
			await card.getByRole("button", { name: "Continue", exact: true }).click();
			await card.getByRole("checkbox", { name: "UI acceptance", exact: true }).click();
			await card.getByRole("textbox", { name: "Something else", exact: true }).fill("Also check keyboard navigation");
			await expectCustomAnswerAligned(card);
			await card.getByRole("button", { name: "Confirm and continue", exact: true }).click();
			await app.waitDone("case-question");
			await expect(input).toContainText("Keep this draft while I answer");
			const summary = page.locator(".ask-user-answer-summary");
			await expect(summary).toBeVisible();
			await summary.locator("summary").click();
			await expect(summary).toContainText("Also check keyboard navigation");
			await app.submit("case-permission");
			await expect(app.approval).toBeVisible();
			await expect(page.locator(".process-state")).toHaveText("Waiting for permission approval");
			await expect(page.getByText("The command has not started.", { exact: true })).toBeVisible();
			await expect(page.locator(".composer-panels .permission-approval-panel")).toHaveCount(0);
			await app.approval.scrollIntoViewIfNeeded();
			expect(await app.approval.locator("footer button").evaluateAll((buttons) => Math.max(...buttons.map((button) => button.getBoundingClientRect().height)))).toBeLessThanOrEqual(30);
			const corners = await app.approval.evaluate((node) => {
				const reject = getComputedStyle(node.querySelector(".permission-approval-reject")!);
				const allow = getComputedStyle(node.querySelector(".permission-approval-allow")!);
				const menu = getComputedStyle(node.querySelector(".menu-select-trigger")!);
				return { outer: [reject.borderTopLeftRadius, allow.borderTopLeftRadius, menu.borderTopRightRadius].map(parseFloat), joined: [allow.borderTopRightRadius, menu.borderTopLeftRadius].map(parseFloat) };
			});
			expect(corners.outer.every((radius) => radius > 0 && radius <= 8)).toBe(true);
			expect(corners.joined).toEqual([0, 0]);
			await expect(app.approval.locator("xpath=ancestor::article").getByText("Ran command", { exact: true })).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath(`${mode}-approval-dark.png`) });
			await app.chooseApprovalOption("Allow for this session");
			await app.waitDone("case-permission");
			const receipt = page.locator(".conversation-permission-receipt");
			await expect(receipt).toContainText("Allowed for this session");
			await expect(page.locator(".transcript-tool-group > .conversation-permission-receipt")).toHaveCount(0);
			const execution = page.locator(".execution-chain, .code-execution").filter({ has: receipt });
			await expect(execution).toHaveCount(1);
			await expect.poll(() => execution.locator(":scope > .transcript-drawer").evaluate((node) => node.getBoundingClientRect().height)).toBe(0);
			expect(await receipt.evaluate((node) => !!node.closest("[inert]"))).toBe(true);
			await page.screenshot({ path: testInfo.outputPath(`${mode}-execution-collapsed.png`) });
			await execution.locator(":scope > summary").click();
			await expect(execution).toHaveAttribute("open", "");
			await execution.locator(".code-command > summary, .tool-step-command > summary").click();
			await expect(receipt).toBeVisible();
			await receipt.locator(":scope > summary").click();
			await expect(receipt.locator("code")).toContainText("case-permission.txt");
			await page.screenshot({ path: testInfo.outputPath(`${mode}-receipt-details.png`) });
			await execution.locator(":scope > summary").click();
			await expect(execution).not.toHaveAttribute("open");
			await expect.poll(() => execution.locator(":scope > .transcript-drawer").evaluate((node) => node.getBoundingClientRect().height)).toBe(0);
			expect(await receipt.evaluate((node) => !!node.closest("[inert]"))).toBe(true);
			await app.submit("case-tasks-completed");
			await app.waitDone("case-tasks-completed");
			await app.submit("case-tasks-next");
			await app.waitDone("case-tasks-next");
			await expect(page.locator(".conversation-tasks")).toHaveCount(2);
			await expect(page.locator(".conversation-tasks").first().locator("button")).toHaveAttribute("aria-expanded", "false");
			await expect(page.locator(".conversation-tasks").last()).toContainText("Review the proposed interface");
			await expectCompactGaps(page.locator(".conversation-tasks").last());
			await expect(page.locator(".conversation-tasks").first().locator(".task-list-spinner")).toHaveCount(0);
			const spinners = page.locator(".conversation-tasks").last().locator(".task-list-spinner");
			await expect(spinners).toHaveCount(2);
			const initialTransform = await spinners.first().evaluate((node) => getComputedStyle(node).transform);
			await expect.poll(() => spinners.first().evaluate((node) => getComputedStyle(node).transform)).not.toBe(initialTransform);
			await page.screenshot({ path: testInfo.outputPath(`${mode}-tasks-spacing.png`) });
			await app.submit("case-permission-deny");
			await expect(app.approval).toBeVisible();
			await app.reject();
			await app.waitDone("case-permission-deny");
			await expect(page.locator(".conversation-permission-receipt").last()).toContainText("Rejected");
			await app.submit("case-permission-cancel");
			await expect(app.approval).toBeVisible();
			await app.interrupt();
			await expect(app.approval).toHaveCount(0);
			await expect(page.locator(".conversation-permission-receipt").last()).toContainText("Approval cancelled or expired");
			await app.relaunch();
			await expect(app.page.locator(".conversation-permission-receipt").first()).toContainText("Allowed for this session");
			await expect(app.page.locator(".conversation-permission-receipt").last()).toContainText("Approval cancelled or expired");
			await expect(app.page.locator(".conversation-tasks")).toHaveCount(2);
			await app.page.locator(".ask-user-answer-summary summary").click();
			await expect(app.page.locator(".ask-user-answer-summary")).toContainText("Also check keyboard navigation");
			await app.page.evaluate(() => { localStorage.setItem("metis.theme.v1", "light"); localStorage.setItem("metis.general-preferences.v1", JSON.stringify({ motion: "reduced" })); });
			await app.page.reload();
			if (mode === "code") await app.page.getByRole("button", { name: "Code", exact: true }).click();
			await app.page.setViewportSize({ width: 900, height: 740 });
			await expect.poll(() => app.page.locator(".task-list-spinner").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("none");
			await app.submit("case-question-again");
			await expect(app.page.locator(".ask-user-panel")).toBeVisible();
			const narrowCard = app.page.locator(".conversation-interaction-card.is-pending");
			await narrowCard.getByRole("textbox", { name: "Something else", exact: true }).fill("First line\nSecond line\nA third line to check expanded alignment");
			await expectCustomAnswerAligned(narrowCard);
			await app.page.screenshot({ path: testInfo.outputPath(`${mode}-questions-light-narrow.png`) });
			expect(await app.page.locator(".conversation-interaction-card.is-pending").evaluate((node) => node.scrollWidth <= node.clientWidth + 2)).toBe(true);
			await app.page.getByRole("button", { name: "Skip all questions", exact: true }).click();
			await app.waitDone("case-question-again");
			await expect(app.page.locator(".conversation-card-status").last()).toHaveText("Questions closed");
		} finally { await app.close(); }
	});
}
