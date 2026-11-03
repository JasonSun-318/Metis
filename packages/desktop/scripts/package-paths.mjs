import path from "node:path";

// Forge writes packaged output to `out/Metis-<platform>-<arch>` under the desktop
// package. Keep that layout in one place so packaging verification and CI setup
// cannot drift apart.
export function packagedOutputRoot(desktopRoot, { platform = process.platform, arch = process.arch } = {}) {
	return path.join(desktopRoot, "out", `Metis-${platform}-${arch}`);
}
