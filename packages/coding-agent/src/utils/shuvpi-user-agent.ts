export function getShuvpiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `shuvpi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
