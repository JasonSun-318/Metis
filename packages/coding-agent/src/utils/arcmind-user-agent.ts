export function getArcMindUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `arcmind/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
