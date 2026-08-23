import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockText = await readFile(resolve(root, "package-lock.json"), "utf8");
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
    name: packageName(path, metadata),
    version: metadata.version,
    license: metadata.license || "SEE UPSTREAM",
    resolved: metadata.resolved || "package-lock.json",
  }))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"));

const unique = [...new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()];
const lines = [
  "# Third-party notices",
  "",
  "This distribution contains or is built from the components below. The license identifier is copied from the locked package metadata; consult the upstream package for the complete license text and notices.",
  "",
  "The generated Adobe Premiere Pro API inventory is derived from `@adobe/premierepro` under Apache-2.0.",
  "The self-contained Windows launcher includes Microsoft .NET 8 runtime components distributed under their applicable Microsoft and third-party notices.",
  "",
  "| Component | Version | License | Locked source |",
  "| --- | ---: | --- | --- |",
  ...unique.map((entry) => `| ${entry.name.replaceAll("|", "\\|")} | ${entry.version} | ${String(entry.license).replaceAll("|", "\\|")} | ${entry.resolved.replaceAll("|", "\\|")} |`),
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
normalizedSbom.documentNamespace = `https://spdx.local/premiere-pro-2026-local-mcp/${lockHash}`;
normalizedSbom.creationInfo.created = "2026-08-23T00:00:00.000Z";
await writeFile(resolve(root, "SBOM.spdx.json"), `${JSON.stringify(normalizedSbom, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ ok: true, packages: unique.length, outputs: ["THIRD-PARTY-NOTICES.md", "SBOM.spdx.json"] })}\n`);
