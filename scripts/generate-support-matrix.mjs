import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORT_MATRIX_HANDLER_EVIDENCE,
  generateSupportMatrix,
  serializeSupportMatrix,
} from "../dist/support-matrix.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(repositoryRoot, "generated/support-matrix.json");
const checkOnly = process.argv.includes("--check");

for (const item of SUPPORT_MATRIX_HANDLER_EVIDENCE) {
  const source = await readFile(resolve(repositoryRoot, item.source), "utf8");
  if (!source.includes(item.sourceFragment)) {
    throw new Error(`Handler evidence is stale for ${item.actionId}/${item.backend}: ${item.source} no longer contains ${JSON.stringify(item.sourceFragment)}`);
  }
}

const generated = serializeSupportMatrix(generateSupportMatrix());
if (checkOnly) {
  const committed = await readFile(outputPath, "utf8");
  if (committed !== generated) throw new Error("generated/support-matrix.json is stale; run npm run inventory:support");
  console.log(`Verified ${outputPath}`);
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log(`Generated ${outputPath}`);
}
