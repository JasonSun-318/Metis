import { createHash } from "node:crypto";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface ToolManifest {
	schemaVersion: number;
	pair: string;
	tools: Record<string, { binary: string; binarySha256: string }>;
}

/** These binaries are signed before ASAR creation, which freezes their manifest. */
export function isSignedBundledNativeTool(file: string): boolean {
	return /(?:^|\/)vendor\/tools\/darwin-(?:arm64|x64)\/(?:rg|fd|officecli)$/u.test(file.replaceAll("\\", "/"));
}

export async function signBundledNativeTools(
	directory: string,
	sign: (binary: string) => Promise<void>,
): Promise<void> {
	const manifestPath = path.join(directory, "manifest.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ToolManifest;
	if (manifest.schemaVersion !== 1 || !/^darwin-(?:arm64|x64)$/u.test(manifest.pair))
		throw new Error("Invalid native-tool signing manifest");
	for (const name of ["rg", "fd", "officecli"]) {
		const entry = manifest.tools[name];
		if (!entry || entry.binary !== name || !/^[a-f0-9]{64}$/u.test(entry.binarySha256))
			throw new Error(`Invalid native-tool signing entry: ${name}`);
		const binary = path.join(directory, entry.binary);
		const metadata = await lstat(binary);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Invalid native-tool file: ${name}`);
		const digest = async () => createHash("sha256").update(await readFile(binary)).digest("hex");
		if ((await digest()) !== entry.binarySha256) throw new Error(`Native tool failed integrity before signing: ${name}`);
		await sign(binary);
		entry.binarySha256 = await digest();
	}
	// Never leave a manifest with only some signing results if signing fails.
	const temporaryPath = `${manifestPath}.signed`;
	await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(temporaryPath, manifestPath);
}
