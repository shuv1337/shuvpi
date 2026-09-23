import * as durable from "@shuv1337/shuvpi-durable";
import * as sqlite from "@shuv1337/shuvpi-durable/storage/sqlite";

// Keep both runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(sqlite));
