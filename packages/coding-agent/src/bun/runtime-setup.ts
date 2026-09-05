import { bedrockProviderModule } from "@shuv1337/shuvpi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@shuv1337/shuvpi-ai/bun-oauth";
import { setBedrockProviderModule } from "@shuv1337/shuvpi-ai/compat";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
