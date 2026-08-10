import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSessionAttachmentNonFiles,
	clearSessionWorkDir,
	createSessionWorkDir,
	formatSessionAttachment,
	formatSessionAttachmentDisplayText,
	formatSessionAttachments,
	getOwnedSessionWorkDirs,
	getSessionAttachmentDir,
	importSessionAttachments,
	pruneStaleSessionWorkDirs,
	removeSessionAttachment,
} from "../src/core/session-attachments.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("session attachments", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-attachments-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(cwd);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("copies files into the owned session directory and formats safe prompt references", () => {
		const source = join(cwd, "report.pdf");
		writeFileSync(source, "document");
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-1",
			cwd,
			attachments: [{ path: "report.pdf" }],
		});

		expect(attachment.name).toBe("report.pdf");
		expect(attachment.path.startsWith(getSessionAttachmentDir(agentDir, "session-1"))).toBe(true);
		expect(readFileSync(attachment.path, "utf8")).toBe("document");
		expect(formatSessionAttachments("Summarize this", [attachment])).toContain(JSON.stringify(attachment.path));
		expect(formatSessionAttachmentDisplayText(formatSessionAttachments("Summarize this", [attachment]))).toBe(
			"Summarize this\n\n[report.pdf]",
		);
		expect(readFileSync(source, "utf8")).toBe("document");
	});

	it("keeps an explicit skill invocation first when attachments are present", () => {
		const attachment = { name: "report.pdf", path: "/private/report.pdf", size: 8 };
		const prompt = formatSessionAttachments("/skill:pdf Summarize this", [attachment]);

		expect(prompt.startsWith("/skill:pdf Summarize this\n\n<attachments>")).toBe(true);
	});

	it("imports long display names without creating an overlong internal filename", () => {
		const source = join(cwd, "report.pdf");
		writeFileSync(source, "document");
		const longName = `${"😀".repeat(200)}.pdf`;
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-long-name",
			cwd,
			attachments: [{ path: source, name: longName }],
		});

		expect(attachment.name).toBe(longName);
		expect(attachment.path.endsWith(".pdf")).toBe(true);
		expect(readFileSync(attachment.path, "utf8")).toBe("document");
	});

	it("does not copy an unsafe user-supplied extension into the internal filename", () => {
		const source = join(cwd, "report.pdf");
		writeFileSync(source, "document");
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-unsafe-extension",
			cwd,
			attachments: [{ path: source, name: "report.bad:name" }],
		});

		expect(attachment.name).toBe("report.bad:name");
		expect(basename(attachment.path)).not.toContain(":");
		expect(readFileSync(attachment.path, "utf8")).toBe("document");
	});

	it("hides internal attachment metadata in display text without changing malformed blocks", () => {
		const singular =
			'<attachment>{"name":"report.pdf","path":"/private/attachments/token-report.pdf","size":123}</attachment> 请总结';
		const plural = `请比较

<attachments>
[
  {"name":"first.docx","path":"/private/attachments/first.docx","size":10},
  {"name":"second.pdf","path":"/private/attachments/second.pdf","size":20}
]
</attachments>`;

		expect(formatSessionAttachmentDisplayText(singular)).toBe("[report.pdf] 请总结");
		expect(formatSessionAttachmentDisplayText(plural)).toBe("请比较\n\n[first.docx] [second.pdf]");
		expect(formatSessionAttachmentDisplayText("<attachment>not-json</attachment>")).toBe(
			"<attachment>not-json</attachment>",
		);
		const safelySerialized = formatSessionAttachment({
			name: "odd</attachment>.pdf",
			path: "/private/odd.pdf",
			size: 1,
		});
		expect(safelySerialized).not.toContain("odd</attachment>");
		expect(formatSessionAttachmentDisplayText(safelySerialized)).toBe("[attachment_.pdf]");
	});

	it("creates unique disposable work directories outside attachments", () => {
		const source = join(cwd, "report.pdf");
		writeFileSync(source, "document");
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-work",
			cwd,
			attachments: [{ path: source }],
		});
		const first = createSessionWorkDir(agentDir, "session-work");
		const second = createSessionWorkDir(agentDir, "session-work");
		writeFileSync(join(first, "page-1.png"), "preview");

		expect(first).not.toBe(second);
		expect(first.startsWith(join(realpathSync(agentDir), "tmp", "document-work"))).toBe(true);
		expect(first.startsWith(getSessionAttachmentDir(agentDir, "session-work"))).toBe(false);
		expect(clearSessionWorkDir(agentDir, attachment.path)).toBe(false);
		expect(clearSessionWorkDir(agentDir, first)).toBe(true);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(true);
		expect(existsSync(attachment.path)).toBe(true);
	});

	it("enumerates only exact real work directories for one session", () => {
		const first = createSessionWorkDir(agentDir, "session-owned");
		const second = createSessionWorkDir(agentDir, "session-owned");
		const other = createSessionWorkDir(agentDir, "session-other");
		mkdirSync(join(agentDir, "tmp", "document-work", "session-owned-short"));

		expect(getOwnedSessionWorkDirs(agentDir, "session-owned")).toEqual([first, second].sort());
		expect(getOwnedSessionWorkDirs(agentDir, "session-other")).toEqual([other]);

		rmSync(first, { recursive: true });
		symlinkSync(other, first);
		expect(() => getOwnedSessionWorkDirs(agentDir, "session-owned")).toThrow("real directory");
	});

	it.skipIf(process.platform === "win32")("does not follow a replaced work-directory symlink", () => {
		const external = join(root, "external");
		mkdirSync(external);
		writeFileSync(join(external, "keep.txt"), "keep");
		const workDir = createSessionWorkDir(agentDir, "session-work-link");
		rmSync(workDir, { recursive: true });
		symlinkSync(external, workDir);

		expect(clearSessionWorkDir(agentDir, workDir)).toBe(true);
		expect(existsSync(workDir)).toBe(false);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep");
	});

	it("prunes only expired run directories", () => {
		const now = Date.now();
		const expired = createSessionWorkDir(agentDir, "session-expired");
		const current = createSessionWorkDir(agentDir, "session-current");
		const old = new Date(now - 2_000);
		utimesSync(expired, old, old);

		expect(pruneStaleSessionWorkDirs(agentDir, 1_000, now)).toBe(1);
		expect(existsSync(expired)).toBe(false);
		expect(existsSync(current)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("removes attachment-side scratch without following symlinks", () => {
		const source = join(cwd, "report.pdf");
		const external = join(root, "external");
		writeFileSync(source, "document");
		mkdirSync(external);
		writeFileSync(join(external, "keep.txt"), "keep");
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-scratch",
			cwd,
			attachments: [{ path: source }],
		});
		const attachmentDir = getSessionAttachmentDir(agentDir, "session-scratch");
		mkdirSync(join(attachmentDir, "work"));
		writeFileSync(join(attachmentDir, "work", "document.txt"), "temporary");
		symlinkSync(external, join(attachmentDir, ".work"));

		expect(clearSessionAttachmentNonFiles(agentDir, "session-scratch")).toBe(2);
		expect(existsSync(join(attachmentDir, "work"))).toBe(false);
		expect(existsSync(join(attachmentDir, ".work"))).toBe(false);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep");
		expect(existsSync(attachment.path)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked input files", () => {
		const source = join(cwd, "source.pdf");
		const link = join(cwd, "link.pdf");
		writeFileSync(source, "document");
		symlinkSync(source, link);
		expect(() =>
			importSessionAttachments({
				agentDir,
				sessionId: "session-2",
				cwd,
				attachments: [{ path: link }],
			}),
		).toThrow("regular file");
	});

	it("keeps submitted copies retryable when Trash is unavailable", async () => {
		const source = join(cwd, "notes.docx");
		writeFileSync(source, "document");
		const session = SessionManager.create(cwd, join(root, "sessions"), { id: "session-3" });
		const sessionFile = session.getSessionFile()!;
		const [pending] = importSessionAttachments({
			agentDir,
			sessionId: session.getSessionId(),
			cwd,
			attachments: [{ path: source }],
		});
		expect(removeSessionAttachment(agentDir, session.getSessionId(), pending.path)).toBe(true);
		const [submitted] = importSessionAttachments({
			agentDir,
			sessionId: session.getSessionId(),
			cwd,
			attachments: [{ path: source }],
		});
		session.close();

		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(await SessionManager.deleteSession(sessionFile, { agentDir })).toMatchObject({
				ok: false,
				method: "trash",
				code: "OPERATION_FAILED",
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(existsSync(submitted.path)).toBe(true);
		expect(existsSync(source)).toBe(true);
	});
});
