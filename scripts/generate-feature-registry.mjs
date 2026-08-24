import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listFeatureRegistry, renderFeatureMatrix, serializeFeatureRegistry } from "../dist/features/registry.js";

const checkOnly = process.argv.includes("--check");
const outputs = [
  [resolve("generated/feature-registry.json"), serializeFeatureRegistry(listFeatureRegistry())],
  [resolve("docs/FEATURE_MATRIX.md"), renderFeatureMatrix(listFeatureRegistry())],
];

let stale = false;
for (const [path, expected] of outputs) {
  if (checkOnly) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      console.error(`stale generated feature registry artifact: ${path}`);
      stale = true;
    }
  } else {
    await writeFile(path, expected, "utf8");
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exitCode = 1;
