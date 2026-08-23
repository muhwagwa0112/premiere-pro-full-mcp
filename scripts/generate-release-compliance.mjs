import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockText = (await readFile(resolve(root, "package-lock.json"), "utf8")).replace(/\r\n?/g, "\n");
const lock = JSON.parse(lockText);

function packageName(path, metadata) {
  if (metadata.name) return metadata.name;
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index < 0) return path;
  const remainder = path.slice(index + marker.length);
  const parts = remainder.split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

const packages = Object.entries(lock.packages)
  .filter(([path, metadata]) => path && metadata.version)
  .map(([path, metadata]) => ({
    path,
    name: packageName(path, metadata),
    version: metadata.version,
    license: metadata.license || "SEE UPSTREAM",
    resolved: metadata.resolved || "package-lock.json",
    runtime: !metadata.dev,
  }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));

const uniqueMap = new Map();
for (const entry of packages) {
  const key = `${entry.name}@${entry.version}`;
  if (!uniqueMap.has(key) || entry.runtime) uniqueMap.set(key, entry);
}
const unique = [...uniqueMap.values()];
const licenseRoot = resolve(root, "THIRD-PARTY-LICENSES");
await rm(licenseRoot, { recursive: true, force: true });
await mkdir(resolve(licenseRoot, "node"), { recursive: true });

function safeDirectoryName(entry) {
  return `${entry.name.replace(/^@/, "").replaceAll("/", "__").replaceAll(/[^A-Za-z0-9_.-]/g, "_")}@${entry.version}`;
}

for (const entry of unique) {
  const packageDirectory = resolve(root, entry.path);
  if (!(await stat(packageDirectory).catch(() => null))) {
    entry.licenseText = "not installed on this platform";
    continue;
  }
  const files = (await readdir(packageDirectory, { withFileTypes: true }))
    .filter((candidate) => candidate.isFile() && /^(license|licence|notice|copying)(\..*)?$/i.test(candidate.name));
  if (!files.length) {
    if (entry.runtime) throw new Error(`Installed runtime package is missing a top-level license file: ${entry.name}@${entry.version}`);
    entry.licenseText = "not supplied as a top-level package file";
    continue;
  }
  const relativeDirectory = `THIRD-PARTY-LICENSES/node/${safeDirectoryName(entry)}`;
  await mkdir(resolve(root, relativeDirectory), { recursive: true });
  for (const file of files) await cp(resolve(packageDirectory, file.name), resolve(root, relativeDirectory, file.name));
  entry.licenseText = `${relativeDirectory}/${files.map((file) => file.name).join(", ")}`;
}

const dotnetRoot = resolve(process.env.ProgramFiles || "C:\\Program Files", "dotnet");
const dotnetNotices = ["LICENSE.txt", "ThirdPartyNotices.txt"];
await mkdir(resolve(licenseRoot, "dotnet"), { recursive: true });
for (const file of dotnetNotices) {
  const source = resolve(dotnetRoot, file);
  if (!(await stat(source).catch(() => null))) throw new Error(`Required .NET redistribution notice is missing: ${file}`);
  await cp(source, resolve(licenseRoot, "dotnet", file));
}

const lines = [
  "# Third-party notices",
  "",
  "This distribution contains or is built from the components below. The license identifier is copied from the locked package metadata; consult the upstream package for the complete license text and notices.",
  "",
  "The generated Adobe Premiere Pro API inventory is derived from `@adobe/premierepro` under Apache-2.0.",
  "The self-contained Windows launcher includes Microsoft .NET 8 runtime components distributed under their applicable Microsoft and third-party notices.",
  "",
  "| Component | Version | Scope | License | License text | Locked source |",
  "| --- | ---: | --- | --- | --- | --- |",
  ...unique.map((entry) => `| ${entry.name.replaceAll("|", "\\|")} | ${entry.version} | ${entry.runtime ? "runtime" : "development"} | ${String(entry.license).replaceAll("|", "\\|")} | ${entry.licenseText.replaceAll("|", "\\|")} | ${entry.resolved.replaceAll("|", "\\|")} |`),
  "",
];
await writeFile(resolve(root, "THIRD-PARTY-NOTICES.md"), lines.join("\n"), "utf8");

const sbomArguments = ["sbom", "--package-lock-only", "--sbom-format", "spdx", "--sbom-type", "application"];
const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm";
const commandArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", `npm ${sbomArguments.join(" ")}`]
  : sbomArguments;
const sbom = execFileSync(command, commandArguments, {
  cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
});
const normalizedSbom = JSON.parse(sbom);
const lockHash = createHash("sha256").update(lockText).digest("hex");
normalizedSbom.documentNamespace = `https://spdx.local/premiere-pro-full-mcp/${lockHash}`;
normalizedSbom.creationInfo.created = "2026-08-23T00:00:00.000Z";
await writeFile(resolve(root, "SBOM.spdx.json"), `${JSON.stringify(normalizedSbom, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  ok: true,
  packages: unique.length,
  packagesWithLicenseFiles: unique.filter((entry) => entry.licenseText.startsWith("THIRD-PARTY-LICENSES/")).length,
  outputs: ["THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES", "SBOM.spdx.json"],
})}\n`);
