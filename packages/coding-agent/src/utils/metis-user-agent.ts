export function getMetisUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `metis/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
