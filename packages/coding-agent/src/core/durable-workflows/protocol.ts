/** The wire version is bumped whenever an operation or its semantics change. */
export const WORKFLOW_OWNER_PROTOCOL_VERSION = 1 as const;

// A single workflow result is capped at 1 MiB. Larger summaries are paged, and
// large archive fields are exposed through bounded base64 chunks.
export const WORKFLOW_OWNER_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_OWNER_PAGE_SIZE = 64;
export const WORKFLOW_OWNER_READ_CHUNK_BYTES = 256 * 1024;

export type WorkflowJsonValue = null | boolean | number | string | readonly WorkflowJsonValue[] | WorkflowJsonObject;

export interface WorkflowJsonObject {
	readonly [key: string]: WorkflowJsonValue;
}

export interface WorkflowOwnerOperation extends WorkflowJsonObject {
	readonly type: string;
}

export interface WorkflowOwnerRequest {
	readonly version: typeof WORKFLOW_OWNER_PROTOCOL_VERSION;
	readonly requestId: string;
	readonly operation: WorkflowOwnerOperation;
}

export type WorkflowOwnerResponse =
	| {
			readonly version: typeof WORKFLOW_OWNER_PROTOCOL_VERSION;
			readonly requestId: string;
			readonly ok: true;
			readonly value: WorkflowJsonValue;
	  }
	| {
			readonly version: typeof WORKFLOW_OWNER_PROTOCOL_VERSION;
			readonly requestId: string;
			readonly ok: false;
			readonly error: string;
	  };

export function isWorkflowOwnerRequest(value: unknown): value is WorkflowOwnerRequest {
	if (!isRecord(value)) return false;
	return (
		value.version === WORKFLOW_OWNER_PROTOCOL_VERSION &&
		typeof value.requestId === "string" &&
		value.requestId.length > 0 &&
		value.requestId.length <= 128 &&
		isRecord(value.operation) &&
		typeof value.operation.type === "string" &&
		value.operation.type.length > 0 &&
		value.operation.type.length <= 128 &&
		isWorkflowJsonValue(value.operation)
	);
}

export function isWorkflowOwnerResponse(value: unknown): value is WorkflowOwnerResponse {
	if (!isRecord(value) || value.version !== WORKFLOW_OWNER_PROTOCOL_VERSION || typeof value.requestId !== "string") {
		return false;
	}
	if (value.ok === true) return "value" in value && isWorkflowJsonValue(value.value);
	return value.ok === false && typeof value.error === "string";
}

export function isWorkflowJsonValue(value: unknown): value is WorkflowJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isWorkflowJsonValue);
	if (!isRecord(value)) return false;
	return Object.values(value).every(isWorkflowJsonValue);
}

export function isWorkflowJsonObject(value: unknown): value is WorkflowJsonObject {
	return isRecord(value) && isWorkflowJsonValue(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
