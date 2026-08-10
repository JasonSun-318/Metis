import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { describe, expect, it, vi } from "vitest";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

type SubmittedInput = { text: string; images?: undefined };
type SubmitEditor = { onSubmit?: (text: string) => void | Promise<void> };

function createTuiDriver(harness: Harness) {
	const defaultEditor: SubmitEditor = {};
	const statuses: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	let prompt: Promise<void> | undefined;
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		defaultEditor,
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		flushPendingBashComponents: vi.fn(),
		takeClipboardInput: (text: string): SubmittedInput => ({ text }),
		onInputCallback: (input: SubmittedInput) => {
			prompt = harness.session.prompt(input.text, { images: input.images });
		},
		pendingUserInputs: [],
		showStatus: (message: string) => statuses.push(message),
		showWarning: (message: string) => warnings.push(message),
		showError: (message: string) => errors.push(message),
	});
	(
		InteractiveMode.prototype as unknown as {
			setupEditorSubmitHandler(this: typeof mode): void;
		}
	).setupEditorSubmitHandler.call(mode);

	return {
		statuses,
		warnings,
		errors,
		async submit(text: string) {
			prompt = undefined;
			await defaultEditor.onSubmit?.(text);
			if (prompt) await prompt;
		},
	};
}

function successfulReadCount(harness: Harness, marker: string): number {
	return harness.session.messages.filter(
		(message) => message.role === "toolResult" && getMessageText(message).includes(marker),
	).length;
}

describe("Code additional directories E2E", () => {
	it("runs add, read, resume, list, remove, and denied outside-read through the TUI submit path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-add-dir-e2e-"));
		const primary = join(root, "primary");
		const external = join(root, "external with spaces");
		const sessions = join(root, "sessions");
		const marker = "external-e2e-marker";
		const externalFile = join(external, "shared.txt");
		mkdirSync(primary);
		mkdirSync(external);
		writeFileSync(externalFile, marker);
		const canonicalPrimary = realpathSync(primary);
		const canonicalExternal = realpathSync(external);

		let harness: Harness | undefined;
		let manager: SessionManager | undefined;
		const harnessTempDirs: string[] = [];
		const cleanupActive = async () => {
			const currentHarness = harness;
			const currentManager = manager;
			harness = undefined;
			manager = undefined;
			try {
				await currentHarness?.cleanup();
			} finally {
				currentManager?.close();
			}
		};

		try {
			const approvals: PermissionApprovalRequest[] = [];
			manager = SessionManager.create(primary, sessions, { mode: "code", permissionMode: "ask" });
			const sessionFile = manager.getSessionFile()!;
			harness = await createHarness({
				sessionManager: manager,
				permissionSettings: { mode: "ask" },
				requestPermissionApproval: async (request) => {
					approvals.push(request);
					return { decision: "deny", reason: "E2E denial" };
				},
			});
			harnessTempDirs.push(harness.tempDir);
			const firstTui = createTuiDriver(harness);

			await firstTui.submit(`/add-dir "${external}"`);
			expect(manager.getWorkspaceRoots()).toEqual([canonicalPrimary, canonicalExternal]);
			expect(harness.session.systemPrompt).toContain(JSON.stringify(canonicalExternal));
			expect(firstTui.errors).toEqual([]);

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: externalFile })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read complete"),
			]);
			await firstTui.submit("Read the external file");
			expect(successfulReadCount(harness, marker)).toBe(1);
			expect(approvals).toEqual([]);

			await cleanupActive();
			expect(existsSync(harnessTempDirs[0]!)).toBe(false);

			manager = SessionManager.open(sessionFile, sessions);
			harness = await createHarness({
				sessionManager: manager,
				permissionSettings: { mode: "ask" },
				requestPermissionApproval: async (request) => {
					approvals.push(request);
					return { decision: "deny", reason: "E2E denial" };
				},
			});
			harnessTempDirs.push(harness.tempDir);
			const resumedTui = createTuiDriver(harness);
			expect(manager.getWorkspaceRoots()).toEqual([canonicalPrimary, canonicalExternal]);
			expect(harness.session.systemPrompt).toContain(JSON.stringify(canonicalExternal));

			await resumedTui.submit("/dirs");
			expect(resumedTui.statuses).toContain(
				`Working directories:\n- ${canonicalPrimary} (primary)\n- ${canonicalExternal}`,
			);

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: externalFile })], { stopReason: "toolUse" }),
				fauxAssistantMessage("resumed read complete"),
			]);
			const readsBeforeResume = successfulReadCount(harness, marker);
			await resumedTui.submit("Read the restored external file");
			const readsAfterResume = successfulReadCount(harness, marker);
			expect(readsAfterResume).toBe(readsBeforeResume + 1);
			expect(approvals).toEqual([]);

			await resumedTui.submit(`/remove-dir "${external}"`);
			expect(manager.getWorkspaceRoots()).toEqual([canonicalPrimary]);
			expect(harness.session.systemPrompt).not.toContain(JSON.stringify(canonicalExternal));

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: externalFile })], { stopReason: "toolUse" }),
				fauxAssistantMessage("denied read complete"),
			]);
			await resumedTui.submit("Try the removed external file");
			expect(approvals).toHaveLength(1);
			expect(approvals[0]!.action.risks).toContain("outside-read");
			expect(successfulReadCount(harness, marker)).toBe(readsAfterResume);
			expect(
				harness.session.messages.some(
					(message) => message.role === "toolResult" && getMessageText(message).includes("Permission denied"),
				),
			).toBe(true);
			expect(resumedTui.warnings).toEqual([]);
			expect(resumedTui.errors).toEqual([]);
		} finally {
			try {
				await cleanupActive();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}

		expect(existsSync(root)).toBe(false);
		for (const path of harnessTempDirs) expect(existsSync(path)).toBe(false);
	});
});
