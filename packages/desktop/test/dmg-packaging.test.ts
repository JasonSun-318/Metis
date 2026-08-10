import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = join(import.meta.dirname, "..");

function source(path: string): string {
	return readFileSync(join(desktopRoot, path), "utf8");
}

function pngDimensions(path: string): { width: number; height: number } {
	const image = readFileSync(join(desktopRoot, path));
	expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
	return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe("macOS DMG install guidance", () => {
	it("ships standard and Retina backgrounds at appdmg's expected dimensions", () => {
		expect(pngDimensions("assets/dmg-background.png")).toEqual({ width: 658, height: 498 });
		expect(pngDimensions("assets/dmg-background@2x.png")).toEqual({ width: 1316, height: 996 });
	});

	it("keeps the install and replacement guidance in the editable source", () => {
		const svg = source("assets/dmg-background.svg");
		expect(svg).toContain("请先退出正在运行的 Metis");
		expect(svg).toContain("将 Metis 拖到“应用程序”");
		expect(svg).toContain("如果提示应用已存在，请选择“替换”");
	});

	it("positions the real app and Applications link over the background", () => {
		const forgeConfig = source("forge.config.ts");
		expect(forgeConfig).toContain(
			'extraResource: process.platform === "darwin" ? [path.join(desktopRoot, "assets", "metis.icns")] : []',
		);
		expect(forgeConfig).toContain('CFBundleIconFile: "metis.icns"');
		expect(forgeConfig).toContain('background: path.join(desktopRoot, "assets", "dmg-background.png")');
		expect(forgeConfig).toContain("iconSize: 88");
		expect(forgeConfig).toContain('{ x: 178, y: 278, type: "file", path: options.appPath }');
		expect(forgeConfig).toContain('{ x: 480, y: 278, type: "link", path: "/Applications" }');
		expect(forgeConfig).toContain('additionalDMGOptions: { filesystem: "APFS" }');
	});
});
