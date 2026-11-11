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
		root = mkdtempSync(join(tmpdir(), "metis-workspaces-"));
		agentDir = join(root, "agent");
		hostCwd = join(root, "project");
		mkdirSync(hostCwd);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates a managed workspace when no directory is requested", () => {
		const managed = resolveNewSessionWorkspace({ id: "managed", hostCwd, agentDir });
		expect(managed).toEqual({
			cwd: realpathSync(getManagedWorkspaceDir("managed", agentDir)),
			cwdOrigin: "managed",
		});
		expect(lstatSync(managed.cwd).isDirectory()).toBe(true);
	});

	it("keeps a requested directory external", () => {
		const explicit = join(root, "other");
		mkdirSync(explicit);
		expect(resolveNewSessionWorkspace({ id: "selected", requestedCwd: hostCwd, hostCwd, agentDir })).toEqual({
			cwd: realpathSync(hostCwd),
			cwdOrigin: "user-selected",
		});
		expect(resolveNewSessionWorkspace({ id: "other", requestedCwd: explicit, hostCwd, agentDir })).toEqual({
			cwd: realpathSync(explicit),
			cwdOrigin: "user-selected",
		});
		expect(existsSync(join(agentDir, "workspaces"))).toBe(false);
	});

	it("rejects missing, non-directory, and invalid workspace inputs", () => {
		const file = join(root, "file");
		writeFileSync(file, "x");
		expect(() =>
			resolveNewSessionWorkspace({ id: "missing", requestedCwd: join(root, "missing"), hostCwd, agentDir }),
		).toThrow();
		expect(() => resolveNewSessionWorkspace({ id: "file", requestedCwd: file, hostCwd, agentDir })).toThrow(
			"not a directory",
		);
		expect(() => resolveNewSessionWorkspace({ id: "../escape", hostCwd, agentDir })).toThrow("Session id");
	});

	it.skipIf(process.platform === "win32")("copies managed derivatives without dereferencing symlinks", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", hostCwd, agentDir });
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
		const workspace = resolveNewSessionWorkspace({ id: "source", hostCwd, agentDir });
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

	it("recovers a deterministic managed copy after publication is interrupted", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "inside.txt"), "inside");
		const input = {
			sourceId: "source",
			sourceCwd: workspace.cwd,
			targetId: "recoverable",
			agentDir,
			recoveryKey: "request-1",
		};
		expect(() =>
			publishManagedWorkspaceCopy({
				...input,
				publish: () => {
					throw new Error("interrupted after workspace publish");
				},
			}),
		).toThrow("interrupted after workspace publish");
		expect(existsSync(getManagedWorkspaceDir("recoverable", agentDir))).toBe(true);

		const recovered = publishManagedWorkspaceCopy({ ...input, publish: (targetCwd) => targetCwd });
		expect(readFileSync(join(recovered, "inside.txt"), "utf8")).toBe("inside");
		expect(() =>
			publishManagedWorkspaceCopy({ ...input, recoveryKey: "different-request", publish: (targetCwd) => targetCwd }),
		).toThrow("cannot be recovered");
	});

	it("copies the workspace and uses the new encoded session directory for branches", () => {
		const workspace = resolveNewSessionWorkspace({ id: "source", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "state.txt"), "copied");
		const source = SessionManager.create(workspace.cwd, getDefaultSessionDir(workspace.cwd, agentDir), {
			id: "source",
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

	it("keeps a proven managed workspace retryable when Trash is unavailable", async () => {
		const workspace = resolveNewSessionWorkspace({ id: "owned", hostCwd, agentDir });
		writeFileSync(join(workspace.cwd, "owned.txt"), "owned");
		const session = SessionManager.create(workspace.cwd, getDefaultSessionDir(workspace.cwd, agentDir), {
			id: "owned",
			cwdOrigin: "managed",
		});
		const sessionFile = session.getSessionFile()!;
		session.close();

		const previousPath = process.env.PATH;
		const previousDataHome = process.env.XDG_DATA_HOME;
		// Linux renames into the XDG trash and ignores PATH. macOS and Windows resolve
		// osascript or powershell through PATH. Both have to be unavailable.
		const blockedBin = join(root, "no-trash-bin");
		mkdirSync(blockedBin);
		const blockedDataHome = join(root, "xdg-data-home");
		writeFileSync(blockedDataHome, "not a directory");
		process.env.PATH = blockedBin;
		process.env.XDG_DATA_HOME = blockedDataHome;
		try {
			expect(await SessionManager.deleteSession(sessionFile, { agentDir })).toMatchObject({
				ok: false,
				method: "trash",
				code: "OPERATION_FAILED",
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = previousDataHome;
		}
		expect(existsSync(sessionFile)).toBe(true);
		expect(existsSync(workspace.cwd)).toBe(true);
	});

	it("never treats an external or forged cwd as an owned deletion target", async () => {
		const external = join(root, "external");
		mkdirSync(external);
		const sentinel = join(external, "keep.txt");
		writeFileSync(sentinel, "keep");
		const session = SessionManager.create(external, join(root, "sessions"), {
			id: "external",
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
