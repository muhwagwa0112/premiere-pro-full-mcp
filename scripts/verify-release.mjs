/** Verify source/version coherence and, when supplied, exact archive payload hashes. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const source = (path) => readFileSync(join(root, path));
const pkg = JSON.parse(source("package.json"));
const uxp = JSON.parse(source("uxp-plugin/manifest.json"));
const cep = source("cep-plugin/CSXS/manifest.xml").toString("utf8");
const plugin = JSON.parse(source(".codex-plugin/plugin.json"));
const mcp = JSON.parse(source(".mcp.json"));
const version = pkg.version;
if (uxp.version !== version || plugin.version !== version || !cep.includes(`ExtensionBundleVersion="${version}"`) || !cep.includes(`Version="${version}"`)) {
  throw new Error(`Version drift: package=${version}, plugin=${plugin.version}, uxp=${uxp.version}, CEP manifest must use ${version}`);
}
const configured = mcp.mcpServers && mcp.mcpServers["premiere-pro-full-mcp"];
if (!configured || configured.cwd !== "." || JSON.stringify(configured.args) !== JSON.stringify(["./dist/index.js"]) || configured.env) {
  throw new Error(".mcp.json must be extraction-path portable and inherit the destination environment");
}

const archive = process.argv[2];
if (archive) {
  const absolute = resolve(root, archive);
  if (!existsSync(absolute)) throw new Error(`Release archive does not exist: ${absolute}`);
  const ccx = absolute.toLowerCase().endsWith(".ccx");
  const expectedFileName = ccx ? `premiere-pro-full-mcp-${version}.ccx` : absolute.toLowerCase().endsWith(".tgz") ? `premiere-pro-full-mcp-${version}.tgz` : `premiere-pro-full-mcp-${version}-windows.zip`;
  if (!absolute.toLowerCase().endsWith(expectedFileName.toLowerCase())) throw new Error(`Archive filename/version mismatch: expected ${expectedFileName}`);
  const entries = ccx
    ? ["manifest.json", "main.cjs", "auth.cjs", "api-catalog.cjs", "index.html"]
    : ["package.json", ".codex-plugin/plugin.json", ".mcp.json", "cep-plugin/index.html", "cep-plugin/main.ws.js", "cep-plugin/CSInterface.js", "cep-plugin/CSXS/manifest.xml", "uxp-plugin/manifest.json", "uxp-plugin/main.cjs", "uxp-plugin/auth.cjs", "uxp-plugin/api-catalog.cjs", "dist/index.js", "dist/server.js", "dist/daemon.js", "scripts/install-all.ps1", "scripts/install-daemon.ps1", "scripts/daemon-task-wrapper.ps1"];
  const archiveEntries = execFileSync("tar", ["-tf", absolute], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, ""))
    .filter(Boolean);
  for (const entry of entries) {
    const archivedName = archiveEntries.find((candidate) => candidate === entry || candidate === `package/${entry}`);
    if (!archivedName) throw new Error(`Archive entry missing: ${entry}`);
    const archived = execFileSync("tar", ["-xOf", absolute, archivedName], { encoding: "buffer" });
    const local = source(ccx ? `uxp-plugin/${entry}` : entry);
    if (sha256(archived) !== sha256(local)) throw new Error(`Archive/source hash mismatch: ${entry}`);
  }
}
console.log(JSON.stringify({ ok: true, version, archive: archive || null }));
