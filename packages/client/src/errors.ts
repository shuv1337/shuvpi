import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@shuv1337/shuvpi-protocol";

export class ShuvpiServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "ShuvpiServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class ShuvpiDisconnectedError extends Error {
	constructor(message = "Shuvpi client is disconnected") {
		super(message);
		this.name = "ShuvpiDisconnectedError";
	}
}

export class ShuvpiClientDisposedError extends Error {
	constructor() {
		super("Shuvpi client is disposed");
		this.name = "ShuvpiClientDisposedError";
	}
}

export class ShuvpiSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "ShuvpiSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class ShuvpiSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "ShuvpiSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): ShuvpiDisconnectedError {
	const cause = toError(error);
	return cause instanceof ShuvpiDisconnectedError ? cause : new ShuvpiDisconnectedError(cause.message);
}
