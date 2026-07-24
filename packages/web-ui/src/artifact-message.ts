/** Transcript-only message representing an artifact mutation. */
export interface ArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	title?: string;
	timestamp: string;
}

declare module "@shuv1337/shuvpi-agent-core" {
	interface CustomAgentMessages {
		artifact: ArtifactMessage;
	}
}

/** Validate an artifact message received from a local or remote transcript. */
export function isArtifactMessage(message: unknown): message is ArtifactMessage {
	if (typeof message !== "object" || message === null) return false;
	const candidate = message as Record<string, unknown>;
	return (
		candidate.role === "artifact" &&
		(candidate.action === "create" || candidate.action === "update" || candidate.action === "delete") &&
		typeof candidate.filename === "string" &&
		typeof candidate.timestamp === "string" &&
		(candidate.content === undefined || typeof candidate.content === "string") &&
		(candidate.title === undefined || typeof candidate.title === "string")
	);
}
