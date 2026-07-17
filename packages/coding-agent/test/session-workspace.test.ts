import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import {
	getManagedWorkspaceDir,
	getOwnedManagedWorkspace,
	publishManagedWorkspaceCopy,
	resolveNewSessionWorkspace,
} from "../src/core/session-workspace.ts";

describe("managed session workspaces", () => {
	let root: string;
	let agentDir: string;
	let hostCwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arcmind-workspaces-"));
		agentDir = join(root, "agent");
		hostCwd = join(root, "project");
		mkdirSync(hostCwd);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates managed Chat workspaces and keeps selected paths external", () => {
		const managed = resolveNewSessionWorkspace({ id: "chat-managed", mode: "chat", hostCwd, agentDir });
		expect(managed).toEqual({
			cwd: realpathSync(getManagedWorkspaceDir("chat-managed", agentDir)),
			cwdOrigin: "managed",
		});
		expect(lstatSync(managed.cwd).isDirectory()).toBe(true);

		const selected = resolveNewSessionWorkspace({
			id: "chat-selected",
			mode: "chat",
			requestedCwd: hostCwd,
			hostCwd,
			agentDir,
		});
		expect(selected).toEqual({ cwd: realpathSync(hostCwd), cwdOrigin: "user-selected" });
		expect(existsSync(getManagedWorkspaceDir("chat-selected", agentDir))).toBe(false);
	});

	it("uses the host or explicit directory for Code without creating a workspace", () => {
		const explicit = join(root, "other");
		mkdirSync(explicit);
		expect(resolveNewSessionWorkspace({ id: "code-host", mode: "code", hostCwd, agentDir })).toEqual({
			cwd: realpathSync(hostCwd),
			cwdOrigin: "user-selected",
		});
		expect(
			resolveNewSessionWorkspace({ id: "code-other", mode: "code", requestedCwd: explicit, hostCwd, agentDir }),
		).toEqual({ cwd: realpathSync(explicit), cwdOrigin: "user-selected" });
		expect(existsSync(join(agentDir, "workspaces"))).toBe(false);
	});

	it("rejects missing, non-directory, and invalid workspace inputs", () => {
		const file = join(root, "file");
		writeFileSync(file, "x");
		expect(() =>
			resolveNewSessionWorkspace({
				id: "missing",
				mode: "code",
				requestedCwd: join(root, "missing"),
				hostCwd,
				agentDir,
			}),
		).toThrow();
		expect(() =>
			resolveNewSessionWorkspace({ id: "file", mode: "chat", requestedCwd: file, hostCwd, agentDir }),
		).toThrow("not a directory");
		expect(() => resolveNewSessionWorkspace({ id: "../escape", mode: "chat", hostCwd, agentDir })).toThrow(
			"Session id",
		);
	});

	it.skipIf(process.platform === "win32")("copies managed derivatives without dereferencing symlinks", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", mode: "chat", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "inside.txt"), "inside");
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(workspace.cwd, "outside-link"));

		const result = publishManagedWorkspaceCopy({
			sourceId: "source",
			sourceCwd: workspace.cwd,
			targetId: "target",
			agentDir,
			publish: (targetCwd) => targetCwd,
		});
		expect(readFileSync(join(result, "inside.txt"), "utf8")).toBe("inside");
		expect(lstatSync(join(result, "outside-link")).isSymbolicLink()).toBe(true);
		expect(readlinkSync(join(result, "outside-link"))).toBe(outside);
	});

	it("removes an incomplete copy when publication fails", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", mode: "chat", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "inside.txt"), "inside");
		expect(() =>
			publishManagedWorkspaceCopy({
				sourceId: "source",
				sourceCwd: workspace.cwd,
				targetId: "failed",
				agentDir,
				publish: () => {
					throw new Error("publish failed");
				},
			}),
		).toThrow("publish failed");
		expect(existsSync(getManagedWorkspaceDir("failed", agentDir))).toBe(false);
		expect(existsSync(workspace.cwd)).toBe(true);
	});

	it("copies the workspace and uses the new encoded session directory for branches", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", mode: "chat", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "state.txt"), "copied");
		const source = SessionManager.create(workspace.cwd, getDefaultSessionDir(workspace.cwd, agentDir), {
			id: "source",
			mode: "chat",
			cwdOrigin: "managed",
		});
		const leafId = source.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		const branch = source.createBranchedSessionManager(leafId);
		expect(branch.getSessionId()).not.toBe("source");
		expect(branch.getCwdOrigin()).toBe("managed");
		expect(branch.getCwd()).not.toBe(workspace.cwd);
		expect(readFileSync(join(branch.getCwd(), "state.txt"), "utf8")).toBe("copied");
		expect(dirname(branch.getSessionFile()!)).toBe(getDefaultSessionDir(branch.getCwd(), agentDir));
		branch.close();
		source.close();
	});

	it("deletes only a proven managed workspace with its session", async () => {
		const workspace = resolveNewSessionWorkspace({ id: "owned", mode: "chat", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "owned.txt"), "owned");
		const session = SessionManager.create(workspace.cwd, getDefaultSessionDir(workspace.cwd, agentDir), {
			id: "owned",
			mode: "chat",
			cwdOrigin: "managed",
		});
		const sessionFile = session.getSessionFile()!;
		session.close();

		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(await SessionManager.deleteSession(sessionFile, { agentDir })).toEqual({
				ok: true,
				method: "unlink",
				warning: undefined,
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(workspace.cwd)).toBe(false);
	});

	it("never treats an external or forged cwd as an owned deletion target", async () => {
		const external = join(root, "external");
		mkdirSync(external);
		const sentinel = join(external, "keep.txt");
		writeFileSync(sentinel, "keep");
		const session = SessionManager.create(external, join(root, "sessions"), {
			id: "external",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		const sessionFile = session.getSessionFile()!;
		session.close();
		expect(
			getOwnedManagedWorkspace({ id: "external", cwd: external, cwdOrigin: "user-selected", agentDir }),
		).toBeUndefined();

		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await SessionManager.deleteSession(sessionFile, { agentDir });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});

	it.skipIf(process.platform === "win32")("does not trust a symlinked managed-workspace root", async () => {
		mkdirSync(agentDir);
		const externalRoot = join(root, "external-workspaces");
		mkdirSync(externalRoot);
		symlinkSync(externalRoot, join(agentDir, "workspaces"));
		const forgedWorkspace = join(externalRoot, "forged");
		mkdirSync(forgedWorkspace);
		const sentinel = join(forgedWorkspace, "keep.txt");
		writeFileSync(sentinel, "keep");
		const session = SessionManager.create(forgedWorkspace, join(root, "sessions"), {
			id: "forged",
			mode: "chat",
			cwdOrigin: "managed",
		});
		const sessionFile = session.getSessionFile()!;
		session.close();

		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			await SessionManager.deleteSession(sessionFile, { agentDir });
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(readFileSync(sentinel, "utf8")).toBe("keep");
	});
});
