import * as durable from "@blxzer/nyan-durable";
import * as environment from "@blxzer/nyan-durable/env";
import * as jsonl from "@blxzer/nyan-durable/storage/jsonl";
import * as sqlite from "@blxzer/nyan-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
