import * as durable from "@shuv1337/shuvpi-durable";
import * as environment from "@shuv1337/shuvpi-durable/env";
import * as jsonl from "@shuv1337/shuvpi-durable/storage/jsonl";
import * as sqlite from "@shuv1337/shuvpi-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
