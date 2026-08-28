/** Build the complete, locally verifiable release set without publishing it. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const index = process.argv.indexOf("--out");
if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node scripts/build-release.mjs --out <empty-directory>");
const out = resolve(root, process.argv[index + 1]);
const allowDirty = process.argv.includes("--allow-dirty");
if (existsSync(out) && readdirSync(out).length) throw new Error(`Release output must be empty: ${out}`);
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8").toString()).version;
if (!allowDirty) {
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (dirty) throw new Error("Release builds require a clean worktree; commit/stash changes or pass --allow-dirty for a non-publishable local verification build");
}
if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${version}`], { cwd: root }).status === 0) {
  throw new Error(`Release tag v${version} already exists; bump the package version before rebuilding artifacts`);
}
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(npmCli)) throw new Error(`npm CLI entrypoint not found: ${npmCli}`);
const runNpm = (args) => execFileSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: "inherit" });
runNpm(["run", "check"]);
runNpm(["pack", "--json", "--pack-destination", out]);
execFileSync(process.execPath, ["scripts/build-ccx.mjs", "--out", out], { cwd: root, stdio: "inherit" });
const tgz = readdirSync(out).find((name) => name.endsWith(".tgz"));
if (!tgz) throw new Error("npm pack did not produce a .tgz archive");
const staging = mkdtempSync(join(tmpdir(), "premiere-mcp-release-"));
try {
  execFileSync("tar", ["-xf", join(out, tgz), "-C", staging], { cwd: root, stdio: "inherit" });
  const packageRoot = join(staging, "package");
  const windowsZip = join(out, `premiere-pro-full-mcp-${version}-windows.zip`);
  execFileSync("tar", ["-a", "-cf", windowsZip, "-C", packageRoot, "."], { cwd: root, stdio: "inherit" });
  for (const name of readdirSync(out)) {
    if (name.endsWith(".tgz") || name.endsWith("-windows.zip") || name.endsWith(".ccx")) {
      execFileSync(process.execPath, ["scripts/verify-release.mjs", resolve(out, name)], { cwd: root, stdio: "inherit" });
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
const artifactNames = readdirSync(out).filter((name) => name.endsWith(".tgz") || name.endsWith(".zip") || name.endsWith(".ccx")).sort();
const artifacts = Object.fromEntries(artifactNames.map((name) => [name, createHash("sha256").update(readFileSync(join(out, name))).digest("hex")]));
for (const [name, digest] of Object.entries(artifacts)) writeFileSync(join(out, `${name}.sha256`), `${digest}  ${name}\n`, "utf8");
writeFileSync(join(out, "release-manifest.json"), `${JSON.stringify({ schemaVersion: 1, version, publishable: !allowDirty, artifacts }, null, 2)}\n`, "utf8");
console.log(`[build-release] staged verified TGZ, Windows ZIP, CCX, checksums, and release manifest in ${out}`);
