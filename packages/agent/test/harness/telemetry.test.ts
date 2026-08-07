import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTypedSpanStarter, NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@shuv1337/shuvpi-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderAgentTelemetrySchemaMarkdown } from "../../scripts/generate-telemetry-docs.ts";
import {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startAiSpan,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("agent telemetry schemas", () => {
	it("serializes both schemas and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		expect(AGENT_TELEMETRY_SCHEMAS).toEqual([AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA]);
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"shuvpi.harness.run",
			"shuvpi.harness.compaction",
			"shuvpi.harness.navigation",
			"shuvpi.harness.checkpoint",
			"shuvpi.harness.turn",
			"shuvpi.harness.step",
			"shuvpi.harness.tool",
			"shuvpi.harness.hook",
			"shuvpi.harness.sleep",
			"shuvpi.harness.event_handler",
			"shuvpi.session.write",
		]);
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(renderAgentTelemetrySchemaMarkdown());
	});

	it("starts AI-request and harness spans through one composed typed starter", async () => {
		const startSpan = createTypedSpanStarter(NOOP_TELEMETRY_CONTEXT, AGENT_TELEMETRY_SCHEMAS);
		await startSpan(
			"shuvpi.harness.step",
			{
				"shuvpi.lane.name": "main",
				"shuvpi.operation.id": "operation",
				"shuvpi.step.kind": "assistant",
				"shuvpi.step.attempt": 1,
			},
			async (stepSpan, startChildSpan) => {
				stepSpan.setAttributes({ "shuvpi.step.outcome": "succeeded" });
				await startChildSpan(
					"shuvpi.ai.request",
					{
						"shuvpi.ai.operation": "stream",
						"shuvpi.ai.provider": "provider",
						"shuvpi.ai.model": "model",
						"shuvpi.ai.api": "api",
						"shuvpi.ai.streaming": true,
					},
					(requestSpan) => {
						requestSpan.setAttributes({ "shuvpi.ai.response.stop_reason": "stop" });
					},
				);
			},
		);
	});

	it("infers exact AI start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"shuvpi.ai.request">;
		type End = AiSpanEndAttributes<"shuvpi.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"shuvpi.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"shuvpi.ai.provider": string;
			"shuvpi.ai.model": string;
			"shuvpi.ai.api": string;
			"shuvpi.ai.streaming": boolean;
			"shuvpi.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["shuvpi.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			telemetryContext,
			"shuvpi.ai.request",
			{
				"shuvpi.ai.operation": "stream",
				"shuvpi.ai.provider": "provider",
				"shuvpi.ai.model": "model",
				"shuvpi.ai.api": "api",
				"shuvpi.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "shuvpi.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error shuvpi.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"shuvpi.ai.operation": "stream",
				"shuvpi.ai.provider": "provider",
				"shuvpi.ai.model": "model",
				"shuvpi.ai.api": "api",
				"shuvpi.ai.streaming": true,
				"shuvpi.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(telemetryContext, "shuvpi.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(telemetryContext, "shuvpi.ai.request", { "shuvpi.ai.operation": "stream" }, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("infers per-span harness literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"shuvpi.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"shuvpi.harness.run">;
		expectTypeOf<RunStart["shuvpi.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["shuvpi.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"shuvpi.harness.run",
			{
				"shuvpi.session.id": "session",
				"shuvpi.lane.name": "main",
				"shuvpi.operation.id": "operation",
				"shuvpi.operation.kind": "run",
				"shuvpi.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "shuvpi.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"shuvpi.session.id": "session",
				"shuvpi.lane.name": "main",
				"shuvpi.operation.id": "operation",
				"shuvpi.operation.kind": "run",
				"shuvpi.operation.recovery": false,
				"shuvpi.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "shuvpi.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"shuvpi.harness.checkpoint",
				{
					"shuvpi.lane.name": "main",
					"shuvpi.operation.id": "operation",
					"shuvpi.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "shuvpi.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"shuvpi.harness.run",
				{
					"shuvpi.session.id": "session",
					"shuvpi.lane.name": "main",
					"shuvpi.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"shuvpi.operation.kind": "navigation",
					"shuvpi.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "shuvpi.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
