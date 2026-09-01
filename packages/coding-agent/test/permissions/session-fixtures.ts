import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	intersectPermissionSettings,
	PERMISSION_PRESETS,
	type PermissionPreset,
	type PermissionSettings,
	settingsForPreset,
} from "../../src/core/permissions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

export { PERMISSION_PRESETS, settingsForPreset };

const roots: string[] = [];
const harnesses: Harness[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (managers.length > 0) managers.pop()?.close();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

export function createPermissionDirs(): { readonly root: string; readonly project: string; readonly sessions: string } {
	const root = mkdtempSync(join(tmpdir(), "metis-permission-session-"));
	const project = join(root, "project");
	const sessions = join(root, "sessions");
	mkdirSync(project);
	mkdirSync(sessions);
	roots.push(root);
	return { root, project, sessions };
}

export async function createPermissionSession(preset: PermissionPreset = "auto"): Promise<{
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly id: string;
	readonly file: string;
}> {
	const { project, sessions } = createPermissionDirs();
	const sessionManager = SessionManager.create(project, sessions, { mode: "code", permissionPreset: preset });
	managers.push(sessionManager);
	const harness = await createHarness({ sessionManager, permissionPreset: preset, withAgentDir: true });
	harnesses.push(harness);
	const file = sessionManager.getSessionFile();
	if (!file) throw new Error("Permission session was not persisted");
	return { session: harness.session, sessionManager, id: sessionManager.getSessionId(), file };
}

export function readSessionJson(file: string): Record<string, unknown> {
	const header = readFileSync(file, "utf8")
		.split("\n")
		.find((line) => line.trim());
	if (!header) throw new Error("Session file is empty");
	return JSON.parse(header) as Record<string, unknown>;
}

export async function restartSession(file: string): Promise<AgentSession> {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (managers.length > 0) managers.pop()?.close();
	const sessionManager = SessionManager.open(file);
	managers.push(sessionManager);
	const harness = await createHarness({ sessionManager, withAgentDir: true });
	harnesses.push(harness);
	return harness.session;
}

export function childEffectiveSettings(
	requested: PermissionPreset,
	parentCeiling: PermissionSettings,
): PermissionSettings {
	return intersectPermissionSettings(settingsForPreset(requested), parentCeiling);
}
