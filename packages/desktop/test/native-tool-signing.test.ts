import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSignedBundledNativeTool, signBundledNativeTools } from "../scripts/native-tool-signing.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), "metis-native-signing-"));
	roots.push(directory);
	const tools: Record<string, { binary: string; binarySha256: string }> = {};
	for (const name of ["rg", "fd", "officecli"]) {
		await writeFile(path.join(directory, name), name);
		tools[name] = { binary: name, binarySha256: digest(name) };
	}
	const manifest = { schemaVersion: 1, pair: "darwin-arm64", tools };
	await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
	return { directory, manifest };
}

describe("packaged native-tool signing", () => {
	it("records final signed bytes and excludes exactly those tools from a second signing pass", async () => {
		const { directory } = await fixture();
		await signBundledNativeTools(directory, async (binary) => writeFile(binary, `${path.basename(binary)}-signed`));
		const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
		for (const name of ["rg", "fd", "officecli"]) {
			expect(manifest.tools[name].binarySha256).toBe(digest(await readFile(path.join(directory, name))));
			expect(
				isSignedBundledNativeTool(
					`/Metis.app/Contents/Resources/app.asar.unpacked/vendor/tools/darwin-arm64/${name}`,
				),
			).toBe(true);
		}
		expect(isSignedBundledNativeTool("/Metis.app/Contents/MacOS/Metis")).toBe(false);
		expect(isSignedBundledNativeTool("/vendor/tools/darwin-arm64/manifest.json")).toBe(false);
	});
	it("refuses to sign a binary that does not match its staged manifest", async () => {
		const { directory } = await fixture();
		await writeFile(path.join(directory, "rg"), "corrupted");
		const sign = vi.fn();
		await expect(signBundledNativeTools(directory, sign)).rejects.toThrow("integrity before signing: rg");
		expect(sign).not.toHaveBeenCalled();
	});
	it("does not publish a partially signed manifest after signing fails", async () => {
		const { directory, manifest } = await fixture();
		await expect(
			signBundledNativeTools(directory, async (binary) => {
				if (path.basename(binary) === "fd") throw new Error("signing failed");
				await writeFile(binary, "signed");
			}),
		).rejects.toThrow("signing failed");
		expect(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"))).toEqual(manifest);
	});
});
