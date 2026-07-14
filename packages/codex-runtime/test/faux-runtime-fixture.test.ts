import { describe, expect, it } from "vitest";
import { createFauxRuntimeFixture } from "../src/sdk/faux-runtime-fixture.ts";

describe("createFauxRuntimeFixture", () => {
	it("creates a selectable in-memory model and cleans up registration", async () => {
		const fixture = createFauxRuntimeFixture(["fixture reply"]);
		try {
			expect(fixture.provider).toBe("faux");
			expect(fixture.model).toBe("faux-1");
		} finally {
			fixture.dispose();
		}
	});

	it("requires at least one scripted response", () => {
		expect(() => createFauxRuntimeFixture([])).toThrow("at least one response");
	});

	it("accepts deterministic host tool calls", () => {
		const fixture = createFauxRuntimeFixture([
			{ toolCall: { name: "exec_command", arguments: { cmd: "pwd" }, id: "call-1" } },
			"done",
		]);
		fixture.dispose();
	});
});
