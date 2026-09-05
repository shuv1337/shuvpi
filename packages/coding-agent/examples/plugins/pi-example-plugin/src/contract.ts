import { type Context, defineService, type ReplicatedState } from "@shuv1337/shuvpi-chord";

export interface ExampleFacetReply {
	readonly message: string;
	readonly workerActivations: number;
}

export interface ExampleFacetService {
	readonly workerActivations: ReplicatedState<{ count: number }>;
	greet(input: { readonly name: string }, context: Context): Promise<ExampleFacetReply>;
}

export const ExampleFacetService = defineService<ExampleFacetService>("shuvpi.example-plugin.greeting");
