import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { type NormalizePermissionActionInput, normalizePermissionAction } from "../../src/core/permissions/index.ts";

export const projectDir = resolve(tmpdir(), "metis-permission-fixture", "project");
export const outsideFile = resolve(tmpdir(), "metis-permission-fixture", "outside.txt");

export function actionInput(overrides: Partial<NormalizePermissionActionInput> = {}): NormalizePermissionActionInput {
	return {
		actionId: "action-1",
		toolName: "read_file",
		provenance: "builtin",
		toolIdentity: "builtin:read_file:v1",
		args: { path: join(projectDir, "README.md") },
		cwd: projectDir,
		workspaceRoots: [projectDir],
		readPaths: [join(projectDir, "README.md")],
		writePaths: [],
		networkEndpoints: [],
		effects: [],
		...overrides,
	};
}

export const ordinaryRead = () => normalizePermissionAction(actionInput());
export const workspaceWrite = () =>
	normalizePermissionAction(
		actionInput({
			toolName: "write_file",
			toolIdentity: "builtin:write_file:v1",
			args: { path: join(projectDir, "out.txt"), content: "hello" },
			writePaths: [join(projectDir, "out.txt")],
		}),
	);
export const outsideRead = () => normalizePermissionAction(actionInput({ readPaths: [outsideFile] }));
export const sensitiveRead = () => normalizePermissionAction(actionInput({ effects: ["sensitive-read"] }));
export const externalWrite = () =>
	normalizePermissionAction(
		actionInput({
			toolName: "publish",
			toolIdentity: "mcp:publisher:publish:v1",
			provenance: "mcp",
			networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
			effects: ["external-side-effect"],
		}),
	);
export const rootRecursiveDelete = () =>
	normalizePermissionAction(
		actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			args: { command: "rm -rf /" },
			command: "rm -rf /",
			readPaths: [],
			writePaths: [parse(projectDir).root],
			effects: ["destructive"],
		}),
	);
