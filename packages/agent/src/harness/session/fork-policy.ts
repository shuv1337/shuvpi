/**
 * Final action for current state at one address:
 * - copy: emit the current value in the destination;
 * - exclude: omit it from the destination;
 * - reconstruct: do not copy the row because lane handling emits a coherent replacement.
 */
export type ForkDisposition = "copy" | "exclude" | "reconstruct";

/** Decide the final fork action for one current scalar or list address. */
export function classifyForkAddress(
	address: { readonly namespace: string; readonly key: string },
	scope: "branch" | "tree",
	isEntryCopied: (entryId: string) => boolean,
): ForkDisposition {
	switch (address.namespace) {
		case "shuvpi.session.name":
			return "copy";
		case "shuvpi.entry.label":
			return isEntryCopied(address.key) ? "copy" : "exclude";
		case "shuvpi.branch.tip":
		case "shuvpi.lane.config":
		case "shuvpi.lane.state":
			return "reconstruct";
		case "shuvpi.result":
			return "exclude";
	}
	if (address.namespace.startsWith("shuvpi.op.") || address.namespace.startsWith("shuvpi.pending.")) return "exclude";
	if (address.namespace === "shuvpi" || address.namespace.startsWith("shuvpi.")) {
		throw new Error(`Unknown reserved fork namespace: ${address.namespace}`);
	}
	return scope === "tree" ? "copy" : "exclude";
}
