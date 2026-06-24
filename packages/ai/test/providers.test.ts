import { describe, expect, it } from "vitest";
import { getModel, getModels, getProviders } from "../src/models.ts";

describe("built-in provider catalog", () => {
	it("includes baseten with generated models", () => {
		expect(getProviders()).toContain("baseten");

		const models = getModels("baseten");
		expect(models.length).toBeGreaterThan(0);
		expect(models.every((model) => model.provider === "baseten")).toBe(true);
		expect(models.every((model) => model.api === "openai-completions")).toBe(true);
		expect(models.every((model) => model.baseUrl === "https://inference.baseten.co/v1")).toBe(true);
	});

	it("resolves the default Baseten model from the generated catalog", () => {
		const model = getModel("baseten", "moonshotai/Kimi-K2.6");
		expect(model).toBeDefined();
		expect(model?.provider).toBe("baseten");
	});
});
