import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.SHUVPI_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.SHUVPI_SKIP_VERSION_CHECK;
	} else {
		process.env.SHUVPI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3", packageName: PACKAGE_NAME });
	});

	it("queries the installed package's npm latest version with its user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^shuvpi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({
			version: "1.2.4",
			packageName: PACKAGE_NAME,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the installed package identity instead of accepting a replacement update target", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				name: PACKAGE_NAME,
				packageName: "@unexpected-scope/other",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: PACKAGE_NAME,
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			note: "**Read this**",
			version: "1.2.4",
			packageName: PACKAGE_NAME,
		});
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.SHUVPI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.SHUVPI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it.each([
		null,
		[],
		{ version: "latest" },
		{ version: "" },
		{ version: 2 },
		{ version: "1.2.4", name: "@unexpected/pkg" },
	])("ignores malformed or mismatched registry data %j", async (data) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(data)),
		);
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
	});

	it("handles malformed JSON and registry failures without announcing an update", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("broken json")),
		);
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});

	it("compares prereleases semantically and makes no offline request", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4-beta.2" }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewPiVersion("1.2.4-beta.1")).resolves.toMatchObject({
			version: "1.2.4-beta.2",
			packageName: PACKAGE_NAME,
		});
		await expect(checkForNewPiVersion("1.2.4")).resolves.toBeUndefined();
		fetchMock.mockClear();
		vi.stubEnv("SHUVPI_OFFLINE", "1");
		await expect(getLatestPiRelease("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
