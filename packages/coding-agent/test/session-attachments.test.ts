import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSessionAttachmentWorkDir,
	formatSessionAttachment,
	formatSessionAttachmentDisplayText,
	formatSessionAttachments,
	getSessionAttachmentDir,
	getSessionAttachmentWorkDir,
	importSessionAttachments,
	removeSessionAttachment,
} from "../src/core/session-attachments.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("session attachments", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arcmind-attachments-"));
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
			"[report.pdf]\n\nSummarize this",
		);
		expect(readFileSync(source, "utf8")).toBe("document");
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

	it("clears only the disposable work directory", () => {
		const source = join(cwd, "report.pdf");
		writeFileSync(source, "document");
		const [attachment] = importSessionAttachments({
			agentDir,
			sessionId: "session-work",
			cwd,
			attachments: [{ path: source }],
		});
		const workDir = getSessionAttachmentWorkDir(agentDir, "session-work");
		mkdirSync(workDir);
		writeFileSync(join(workDir, "page-1.png"), "preview");

		expect(clearSessionAttachmentWorkDir(agentDir, "session-work")).toBe(true);
		expect(existsSync(workDir)).toBe(false);
		expect(existsSync(attachment.path)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("does not follow a symlinked work directory", () => {
		const source = join(cwd, "report.pdf");
		const external = join(root, "external");
		writeFileSync(source, "document");
		mkdirSync(external);
		writeFileSync(join(external, "keep.txt"), "keep");
		importSessionAttachments({
			agentDir,
			sessionId: "session-work-link",
			cwd,
			attachments: [{ path: source }],
		});
		symlinkSync(external, getSessionAttachmentWorkDir(agentDir, "session-work-link"));

		expect(clearSessionAttachmentWorkDir(agentDir, "session-work-link")).toBe(true);
		expect(existsSync(getSessionAttachmentWorkDir(agentDir, "session-work-link"))).toBe(false);
		expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("keep");
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

	it("removes pending files and all submitted copies when the session is permanently deleted", async () => {
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
			expect((await SessionManager.deleteSession(sessionFile, { agentDir })).ok).toBe(true);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
		expect(existsSync(submitted.path)).toBe(false);
		expect(existsSync(source)).toBe(true);
	});
});
