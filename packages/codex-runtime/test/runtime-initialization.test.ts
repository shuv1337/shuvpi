import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	registerBunOAuthFlows: vi.fn(),
}));

vi.mock("@shuv1337/shuvpi-ai/bun-oauth", () => ({
	registerBunOAuthFlows: mocks.registerBunOAuthFlows,
}));

beforeEach(() => {
	mocks.registerBunOAuthFlows.mockClear();
	vi.resetModules();
});

describe("initializeStandaloneRuntime", () => {
	it("registers bundled OAuth implementations exactly once", async () => {
		const { initializeStandaloneRuntime } = await import("../src/runtime-initialization.ts");

		initializeStandaloneRuntime();
		initializeStandaloneRuntime();

		expect(mocks.registerBunOAuthFlows).toHaveBeenCalledTimes(1);
	});
});
