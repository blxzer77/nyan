import * as durable from "@ny4n/durable";
import * as environment from "@ny4n/durable/env";
import * as jsonl from "@ny4n/durable/storage/jsonl";
import * as sqlite from "@ny4n/durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
