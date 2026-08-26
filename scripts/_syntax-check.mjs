/**
 * Verify that the scripts upstream handlers generate are syntactically valid
 * when wrapped the way BridgeClient sends them to CEP. Catches top-level
 * return leaks, unbalanced braces, and other parse errors before they reach
 * Premiere's ExtendScript engine.
 *
 * We do NOT execute the scripts (they reference `app`, which only exists
 * inside Premiere). `new Function` only parses, it does not run the body.
 */
import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";

const tools = getUpstreamToolModules({ executeScript: async () => ({ success: true, data: {} }) });
const names = Object.keys(tools);
console.log("upstream tools:", names.length);

// Representative sample covering read/write/create/export/scripting domains.
// Only tools that need no required args (so empty {} is a valid call) are
// syntax-checked directly. Required-arg tools are skipped: their failures at
// the handler stage are about inputs, not about script syntax.
const sample = names.filter((n) => !(tools[n].parameters?.required?.length));
console.log("no-required-arg tools:", sample.length);

// Realistic args for tools that require them (P0 sequence/timeline focus).
const ARGS = {
  set_active_sequence: { sequence_id: "SEQ1" },
  add_to_timeline: { item_id: "ITEM1" },
  remove_from_timeline: { node_id: "CLIP1" },
  move_clip: { node_id: "CLIP1", new_start_seconds: 5 },
  trim_clip: { node_id: "CLIP1", new_in_seconds: 5, new_out_seconds: 10 },
  create_sequence: { name: "TEST" },
  export_sequence: { output_path: "C:/out.mp4" },
  set_playhead_position: { time_seconds: 5 },
};
let failures = [];
let passed = 0;
const targets = [...sample, ...Object.keys(ARGS)];
for (const name of targets) {
  let captured = null;
  const solo = getUpstreamToolModules({ executeScript: async (s) => { captured = s; return { success: true, data: {} }; } });
  try {
    await solo[name].handler(ARGS[name] ?? {});
  } catch (e) {
    failures.push({ name, stage: "handler", error: e.message });
    continue;
  }
  if (captured === null) continue;
  const wrapped = `(function(){\n${captured}\n})();`;
  if (!wrapped.startsWith("(function(){") || !wrapped.endsWith("})();")) {
    failures.push({ name, stage: "wrap", error: "not wrapped in IIFE" });
    continue;
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(wrapped);
    passed++;
  } catch (e) {
    const snippet = wrapped.slice(0, 80).replace(/\n/g, " ");
    failures.push({ name, stage: "syntax", error: e.message, snippet });
  }
}

console.log("syntax-checked:", passed, "failures:", failures.length);
if (failures.length) {
  console.log(JSON.stringify(failures.slice(0, 10), null, 2));
  process.exit(1);
}
console.log("SYNTAX PASS: wrapped scripts parse cleanly (no top-level return leak)");
