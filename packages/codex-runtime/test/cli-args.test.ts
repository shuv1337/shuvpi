import { describe, expect, it } from "vitest";
import { parseRuntimeArguments } from "../src/cli-args.ts";

describe("parseRuntimeArguments", () => {
	it("requires and returns the Unix socket path", () => {
		expect(parseRuntimeArguments(["--socket", "/tmp/pi.sock"])).toEqual({
			socketPath: "/tmp/pi.sock",
			showHelp: false,
			showVersion: false,
		});
	});

	it("supports help and version without a socket", () => {
		expect(parseRuntimeArguments(["--help"]).showHelp).toBe(true);
		expect(parseRuntimeArguments(["--version"]).showVersion).toBe(true);
	});

	it("rejects missing values and unknown options", () => {
		expect(() => parseRuntimeArguments([])).toThrow("--socket is required");
		expect(() => parseRuntimeArguments(["--socket"])).toThrow("--socket requires a path");
		expect(() => parseRuntimeArguments(["--wat"])).toThrow("unknown argument");
	});
});
