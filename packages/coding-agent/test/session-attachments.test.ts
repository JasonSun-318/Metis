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
	replaceSessionAttachmentReferences,
	type SessionAttachment,
	splitSessionAttachmentPrompt,
} from "../src/core/session-attachments.ts";
import { formatSessionConversationQuotes } from "../src/core/session-conversation-quotes.ts";
import { formatSessionFileSelections } from "../src/core/session-file-selections.ts";
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

	it("separates public text from private attachment metadata", () => {
		const attachment = { name: "design.png", path: "/private/metis/attachments/design.png", size: 42 };
		const formatted = formatSessionAttachments("review this", [attachment]);

		expect(splitSessionAttachmentPrompt(formatted)).toEqual({
			text: "review this",
			attachments: [attachment],
			fileSelections: [],
		});
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

describe("session attachment prompt blocks", () => {
	it("serializes compact metadata with escaping while projecting name, path, and size for plural blocks", () => {
		const rich = {
			name: "报告<&>.pdf",
			path: "/private/报告a>b<c.pdf",
			size: 12,
			mime: "application/pdf",
			sha256: "abc",
		} as SessionAttachment;
		const plural =
			`<attachments>\n[\n  {\n    "name": "报告\\u003c&\\u003e.pdf",\n` +
			`    "path": "/private/报告a\\u003eb\\u003cc.pdf",\n    "size": 12\n  }\n]\n</attachments>`;

		expect(formatSessionAttachment(rich)).toBe(
			'<attachment>{"name":"报告\\u003c&\\u003e.pdf","path":"/private/报告a\\u003eb\\u003cc.pdf",' +
				'"size":12,"mime":"application/pdf","sha256":"abc"}</attachment>',
		);
		expect(formatSessionAttachments("", [rich])).toBe(plural);
		expect(formatSessionAttachments("  keep  ", [])).toBe("  keep  ");
		expect(formatSessionAttachments(" \n ", [rich])).toBe(plural);
		expect(formatSessionAttachments("  \n  keep", [rich])).toBe(`keep\n\n${plural}`);
	});
	it("parses legacy singular and plural inline, pretty, object, and whitespace blocks with extra fields", () => {
		const singular =
			'<attachment>\n\t{"name":"  first.txt  ","path":"/tmp/first","size":1,' +
			'"mime":"text/plain","extra":{"nested":true}}\n</attachment>';
		const pluralInline =
			'<attachments>[{"name":"a.txt","path":"/tmp/a","size":2,"mime":"x"},' +
			'{"name":"b.txt","path":"/tmp/b","size":3}]</attachments>';
		const pluralObject =
			'<attachments>\n {\n  "name": "one.txt",\n  "path": "/tmp/one",\n  "size": 4,\n' +
			'  "extra": true\n }\n</attachments>';
		const pluralPretty =
			'<attachments>\n\t[\n\t\t{\n\t\t\t"name": "first.docx",\n\t\t\t"path": "/tmp/first.docx",\n' +
			'\t\t\t"size": 10,\n\t\t\t"mime": "application/vnd.example"\n\t\t},\n\t\t{\n' +
			'\t\t\t"name": "second.pdf",\n\t\t\t"path": "/tmp/second.pdf",\n\t\t\t"size": 20\n\t\t}\n\t]\n</attachments>';

		expect(formatSessionAttachmentDisplayText(singular)).toBe("[first.txt]");
		expect(
			replaceSessionAttachmentReferences(singular, (found) =>
				found.map(({ name, path, size }) => `${name}|${path}|${size}`).join(","),
			),
		).toBe("first.txt|/tmp/first|1");
		expect(formatSessionAttachmentDisplayText(pluralInline)).toBe("[a.txt] [b.txt]");
		expect(formatSessionAttachmentDisplayText(pluralObject)).toBe("[one.txt]");
		expect(formatSessionAttachmentDisplayText(pluralPretty)).toBe("[first.docx] [second.pdf]");
		expect(splitSessionAttachmentPrompt(`head ${singular} tail`)).toEqual({
			text: "head  tail",
			attachments: [{ name: "first.txt", path: "/tmp/first", size: 1 }],
			fileSelections: [],
		});
	});
	it("preserves malformed, empty, oversized, and nonconforming blocks independently", () => {
		const oversized = `<attachments>${JSON.stringify(
			Array.from({ length: 17 }, (_, index) => ({ name: `n${index}`, path: `/p/${index}`, size: index })),
		)}</attachments>`;
		const malformed = [
			"<attachment>{not json}</attachment>",
			"<attachments>[]</attachments>",
			"<attachments>{}</attachments>",
			'<attachments>[{"name":"x","path":"/x","size":-1}]</attachments>',
			'<attachment>{"name":"x","path":"/x","size":"1"}</attachment>',
			'<attachment>{"name":"","path":"/x","size":1}</attachment>',
			'<attachment>{"name":"x","path":"/x","size":1,"extra":</attachment>',
			oversized,
		];
		for (const text of malformed) expect(formatSessionAttachmentDisplayText(text)).toBe(text);

		const valid = '<attachment>{"name":"ok","path":"/ok","size":1}</attachment>';
		expect(formatSessionAttachmentDisplayText(`<attachments>[]</attachments> ${valid}`)).toBe(
			`<attachments>[]</attachments> [ok]`,
		);
	});
	it("preserves display order and plural-first collection across multiple blocks", () => {
		const first = '<attachment>{"name":"a","path":"/a","size":1}</attachment>';
		const plural = '<attachments>[{"name":"b","path":"/b","size":2},{"name":"c","path":"/c","size":3}]</attachments>';
		const last = '<attachment>{"name":"d","path":"/d","size":4}</attachment>';
		const prompt = `head ${first} ${plural} ${last} tail`;

		expect(formatSessionAttachmentDisplayText(`${first} ${plural} ${last}`)).toBe("[a] [b] [c] [d]");
		expect(splitSessionAttachmentPrompt(prompt)).toEqual({
			text: "head    tail",
			// The plural pass runs before the singular pass, so collected attachments are plural-first.
			attachments: [
				{ name: "b", path: "/b", size: 2 },
				{ name: "c", path: "/c", size: 3 },
				{ name: "a", path: "/a", size: 1 },
				{ name: "d", path: "/d", size: 4 },
			],
			fileSelections: [],
		});
	});
	it("propagates attachment replacement callback errors instead of preserving the block", () => {
		const block = '<attachment>{"name":"x","path":"/x","size":1}</attachment>';
		expect(() =>
			replaceSessionAttachmentReferences(block, () => {
				throw new Error("attachment replacement failed");
			}),
		).toThrow("attachment replacement failed");
	});
	it("trims unconditionally and keeps mixed attachment, quote, and selection sequencing", () => {
		expect(splitSessionAttachmentPrompt("  plain  \n")).toEqual({
			text: "plain",
			attachments: [],
			fileSelections: [],
		});

		const attachment = { name: "a.txt", path: "/tmp/a", size: 1 };
		const quote = { sourceItemId: "q1", sourceRole: "assistant" as const, selectedText: "quoted" };
		const file = {
			source: "workspace" as const,
			name: "f.txt",
			path: "/tmp/f",
			basis: "source" as const,
			selectedText: "selected",
			startLine: 1,
			endLine: 1,
		};
		const mixed =
			`  head  \n\n${formatSessionAttachments("", [attachment])}\n\nmiddle\n\n` +
			`${formatSessionConversationQuotes("", [quote])}\n\n${formatSessionFileSelections("", [file])}\n\n  `;

		expect(splitSessionAttachmentPrompt(mixed)).toEqual({
			text: "head  \n\n\n\nmiddle",
			attachments: [attachment],
			fileSelections: [file],
			conversationQuotes: [quote],
		});
		expect(formatSessionAttachmentDisplayText(mixed)).toBe(
			"  head  \n\n[a.txt]\n\nmiddle\n\n\n\n[1 conversation quote]\n\n\n\n[f.txt:1–1]\n\n  ",
		);
	});
});
