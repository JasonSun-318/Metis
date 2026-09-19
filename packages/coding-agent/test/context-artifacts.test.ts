import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { archiveContextOutput, restoreContextArtifact } from "../src/core/large-tool-output.ts";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("context artifacts", () => {
	it("repairs a missing owned artifact at the exact recorded path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const text = "original output\n";
			const artifact = await archiveContextOutput(root, { text });
			unlinkSync(artifact.absolutePath);
			expect(await restoreContextArtifact(root, artifact, { text })).toBe("ready");
			expect(readFileSync(artifact.absolutePath, "utf8")).toBe(text);
			expect(await restoreContextArtifact(root, artifact, { text })).toBe("ready");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("records sha256 digest and byte count from the durable file", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const text = "héllo output ✓\n";
			const artifact = await archiveContextOutput(root, { text });
			expect(artifact.digest).toBe(sha256(text));
			expect(artifact.bytes).toBe(Buffer.byteLength(text, "utf8"));
			expect(artifact.absolutePath).toBe(join(root, artifact.relativePath));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns ready without rewriting an existing file that matches", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const artifact = await archiveContextOutput(root, { text: "kept\n" });
			expect(await restoreContextArtifact(root, artifact, undefined)).toBe("ready");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to overwrite an occupied path with different content", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const artifact = await archiveContextOutput(root, { text: "original\n" });
			writeFileSync(artifact.absolutePath, "attacker content\n");
			expect(await restoreContextArtifact(root, artifact, { text: "original\n" })).toBe("unavailable");
			expect(readFileSync(artifact.absolutePath, "utf8")).toBe("attacker content\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not follow a symlink at the recorded path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		const outside = mkdtempSync(join(tmpdir(), "metis-context-artifact-outside-"));
		try {
			const text = "original\n";
			const artifact = await archiveContextOutput(root, { text });
			unlinkSync(artifact.absolutePath);
			const decoy = join(outside, "decoy.txt");
			writeFileSync(decoy, text);
			symlinkSync(decoy, artifact.absolutePath);
			expect(await restoreContextArtifact(root, artifact, { text })).toBe("unavailable");
			expect(readFileSync(artifact.absolutePath, "utf8")).toBe(text); // still the decoy, untouched
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("does not read a FIFO at the recorded path", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const artifact = await archiveContextOutput(root, { text: "original\n" });
			unlinkSync(artifact.absolutePath);
			execSync(`mkfifo ${JSON.stringify(artifact.absolutePath)}`);
			expect(await restoreContextArtifact(root, artifact, { text: "original\n" })).toBe("unavailable");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("restores across directories from an intact source path", async () => {
		const oldDir = mkdtempSync(join(tmpdir(), "metis-context-artifact-old-"));
		const newDir = mkdtempSync(join(tmpdir(), "metis-context-artifact-new-"));
		try {
			const text = "original output\n";
			const artifact = await archiveContextOutput(oldDir, { text });
			expect(await restoreContextArtifact(newDir, artifact, { sourcePath: artifact.absolutePath })).toBe("ready");
			expect(readFileSync(join(newDir, artifact.relativePath), "utf8")).toBe(text);
		} finally {
			rmSync(oldDir, { recursive: true, force: true });
			rmSync(newDir, { recursive: true, force: true });
		}
	});

	it("reports unavailable when the recovery source is gone or mismatched", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const artifact = await archiveContextOutput(root, { text: "original\n" });
			unlinkSync(artifact.absolutePath);
			expect(await restoreContextArtifact(root, artifact, { sourcePath: artifact.absolutePath })).toBe(
				"unavailable",
			);
			expect(await restoreContextArtifact(root, artifact, undefined)).toBe("unavailable");
			expect(await restoreContextArtifact(root, artifact, { text: "wrong\n" })).toBe("unavailable");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves no file behind when recovered content fails the digest check", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		const sourceDir = mkdtempSync(join(tmpdir(), "metis-context-artifact-src-"));
		try {
			const text = "original\n";
			const artifact = await archiveContextOutput(root, { text });
			unlinkSync(artifact.absolutePath);
			const decoy = join(sourceDir, "decoy.txt");
			writeFileSync(decoy, `${text}extra`); // same prefix, different digest/bytes
			expect(await restoreContextArtifact(root, artifact, { sourcePath: decoy })).toBe("unavailable");
			expect(() => readFileSync(artifact.absolutePath)).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(sourceDir, { recursive: true, force: true });
		}
	});

	it("rejects unsafe artifact records instead of writing", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const artifact = await archiveContextOutput(root, { text: "x" });
			unlinkSync(artifact.absolutePath);
			expect(await restoreContextArtifact(root, { ...artifact, relativePath: "../escape.txt" }, { text: "x" })).toBe(
				"unavailable",
			);
			expect(await restoreContextArtifact(root, { ...artifact, digest: "bad" }, { text: "x" })).toBe("unavailable");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("aborts before doing any work", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-context-artifact-"));
		try {
			const aborted = AbortSignal.abort();
			await expect(archiveContextOutput(root, { text: "x" }, aborted)).rejects.toThrow();
			const artifact = await archiveContextOutput(root, { text: "x" });
			unlinkSync(artifact.absolutePath);
			await expect(restoreContextArtifact(root, artifact, { text: "x" }, aborted)).rejects.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
