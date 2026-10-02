import { describe, expect, it } from "vitest";
import { getShuvpiUserAgent } from "../src/utils/shuvpi-user-agent.ts";

describe("getShuvpiUserAgent", () => {
	it("formats the Shuvpi user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getShuvpiUserAgent("1.2.3");

		expect(userAgent).toBe(`shuvpi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^shuvpi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
