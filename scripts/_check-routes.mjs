import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";
import { readFileSync } from "node:fs";
import { EXTRA_TOOL_NAMES } from "../dist/tool-names.js";

const tools = getUpstreamToolModules({ executeScript: async () => ({ success: true }) });
const upstream = new Set(Object.keys(tools));
const src = readFileSync("src/server.ts", "utf8");
const targets = [...src.matchAll(/target: "([a-z0-9_]+)"/g)].map((m) => m[1]);
const uniq = [...new Set(targets)];
const missing = uniq.filter((n) => !upstream.has(n));
console.log("unique routed targets:", uniq.length);
console.log("MISSING from upstream:", missing.length);
console.log(missing.join(", "));
const routeKeys = [...src.matchAll(/^  ([a-z0-9_]+): \{ target:/gm)].map((m) => m[1]);
console.log("extra route entries:", routeKeys.length);
const routeSet = new Set(routeKeys);
const local = new Set([
  "helpers_ticks_to_timecode", "helpers_seconds_to_timecode", "helpers_timecode_to_seconds", "helpers_timecode_to_ticks",
  "premiere_connection_status", "premiere_health_check",
]);
const extraScriptNames = [...src.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]);
const handled = new Set([...routeSet, ...local, ...extraScriptNames]);
const unhandled = EXTRA_TOOL_NAMES.filter((n) => !handled.has(n));
console.log("total extra:", EXTRA_TOOL_NAMES.length, "handled:", handled.size, "unhandled:", unhandled.length);
console.log("UNHANDLED:", unhandled.join(", ") || "(none)");
console.log("---all upstream names for reference---");
console.log([...upstream].sort().join(", "));
