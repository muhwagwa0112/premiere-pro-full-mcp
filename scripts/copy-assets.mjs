import { cp, mkdir, readdir } from "node:fs/promises";

await mkdir(new URL("../dist/workers/", import.meta.url), { recursive: true });
for (const filename of await readdir(new URL("../workers/", import.meta.url))) {
  if (filename.endsWith(".py") || filename === "README.md") {
    await cp(new URL(`../workers/${filename}`, import.meta.url), new URL(`../dist/workers/${filename}`, import.meta.url));
  }
}
await mkdir(new URL("../dist/automation/", import.meta.url), { recursive: true });
for (const filename of await readdir(new URL("../src/automation/", import.meta.url))) {
  if (filename.endsWith(".schema.json")) {
    await cp(new URL(`../src/automation/${filename}`, import.meta.url), new URL(`../dist/automation/${filename}`, import.meta.url));
  }
}
