import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";
import { type ShuvpiCommandContext, shuvpiCommand } from "./commands/shuvpi.ts";

export type ExperimentalCliContext = ShuvpiCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = shuvpiCommand.command(serverCommand).command(clientCommand);
