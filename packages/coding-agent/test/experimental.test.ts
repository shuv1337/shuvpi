import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalShuvpiExperimental = process.env.SHUVPI_EXPERIMENTAL;

	afterEach(() => {
		if (originalShuvpiExperimental === undefined) {
			delete process.env.SHUVPI_EXPERIMENTAL;
		} else {
			process.env.SHUVPI_EXPERIMENTAL = originalShuvpiExperimental;
		}
	});

	it("returns false when SHUVPI_EXPERIMENTAL is unset", () => {
		delete process.env.SHUVPI_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SHUVPI_EXPERIMENTAL is empty", () => {
		process.env.SHUVPI_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when SHUVPI_EXPERIMENTAL is set to 1", () => {
		process.env.SHUVPI_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when SHUVPI_EXPERIMENTAL is set to 0", () => {
		process.env.SHUVPI_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when SHUVPI_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.SHUVPI_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
