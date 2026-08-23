import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const [bundleArgument, outputArgument] = process.argv.slice(2);
if (!bundleArgument || !outputArgument) throw new Error("Usage: node scripts/generate-release-sbom.mjs <bundle-root> <output>");
const repositoryRoot = resolve(import.meta.dirname, "..");
const bundleRoot = resolve(bundleArgument);
const outputPath = resolve(outputArgument);
const base = JSON.parse(await readFile(join(repositoryRoot, "SBOM.spdx.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`SBOM refused symbolic link: ${path}`);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function spdxId(value) {
  return value.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const mainPackage = base.packages.find((item) => base.documentDescribes?.includes(item.SPDXID)) ?? base.packages[0];
mainPackage.name = packageJson.name;
mainPackage.versionInfo = packageJson.version;
mainPackage.SPDXID = `SPDXRef-Package-${spdxId(packageJson.name)}-${spdxId(packageJson.version)}`;
mainPackage.description = packageJson.description;
mainPackage.downloadLocation = `https://github.com/muhwagwa0112/premiere-pro-full-mcp`;
mainPackage.homepage = `https://github.com/muhwagwa0112/premiere-pro-full-mcp`;
mainPackage.licenseDeclared = "MIT";
mainPackage.filesAnalyzed = true;
mainPackage.externalRefs = [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/muhwagwa0112/premiere-pro-full-mcp@${packageJson.version}` }];
base.documentDescribes = [mainPackage.SPDXID];
for (const pkg of base.packages) {
  if (pkg !== mainPackage && typeof pkg.SPDXID === "string") pkg.SPDXID = spdxId(pkg.SPDXID);
}

const nativeDepsPath = (await walk(join(bundleRoot, "payload", "native", "win-x64"))).find((path) => path.endsWith(".deps.json"));
if (!nativeDepsPath) throw new Error("Published .NET dependency manifest was not found");
const nativeDeps = JSON.parse(await readFile(nativeDepsPath, "utf8"));
const existingPackageIds = new Set(base.packages.map((item) => item.SPDXID));
for (const [library, metadata] of Object.entries(nativeDeps.libraries ?? {})) {
  if (metadata.type !== "package") continue;
  const slash = library.lastIndexOf("/");
  if (slash <= 0) continue;
  const name = library.slice(0, slash);
  const version = library.slice(slash + 1);
  const id = `SPDXRef-Package-nuget-${spdxId(name)}-${spdxId(version)}`;
  if (existingPackageIds.has(id)) continue;
  existingPackageIds.add(id);
  base.packages.push({
    name,
    SPDXID: id,
    versionInfo: version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseDeclared: "NOASSERTION",
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:nuget/${encodeURIComponent(name)}@${version}` }],
  });
}

const nodePath = join(bundleRoot, "payload", "runtime", "node", "node.exe");
const nodeVersion = JSON.parse(await readFile(join(bundleRoot, "payload", "integrity", "runtime-integrity.json"), "utf8")).nodeVersion;
const nodePackageId = `SPDXRef-Package-node-${spdxId(nodeVersion)}`;
base.packages.push({
  name: "Node.js",
  SPDXID: nodePackageId,
  versionInfo: nodeVersion,
  downloadLocation: `https://nodejs.org/dist/v${nodeVersion}/`,
  filesAnalyzed: false,
  licenseDeclared: "MIT",
  licenseConcluded: "NOASSERTION",
  copyrightText: "NOASSERTION",
  externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:generic/node@${nodeVersion}` }],
});

const files = [];
const fileRelationships = [];
for (const path of (await walk(bundleRoot)).sort()) {
  if (resolve(path) === outputPath) continue;
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  const id = `SPDXRef-File-${digest}`;
  files.push({ fileName: relative(bundleRoot, path).replaceAll("\\", "/"), SPDXID: id, checksums: [{ algorithm: "SHA256", checksumValue: digest }], licenseConcluded: "NOASSERTION", copyrightText: "NOASSERTION" });
  fileRelationships.push({ spdxElementId: mainPackage.SPDXID, relationshipType: "CONTAINS", relatedSpdxElement: id });
}
if (!(await stat(nodePath)).isFile()) throw new Error("Bundled Node.js executable is missing");

base.spdxVersion = "SPDX-2.3";
base.dataLicense = "CC0-1.0";
base.name = `${packageJson.name}@${packageJson.version}-windows-release`;
base.documentNamespace = `https://spdx.local/${packageJson.name}/${sha256(await readFile(join(repositoryRoot, "package-lock.json")))}`;
base.creationInfo = { created: "2000-01-01T00:00:00.000Z", creators: ["Tool: premiere-pro-full-mcp/scripts/generate-release-sbom.mjs", "Tool: npm/cli"] };
base.files = files;
base.relationships = [
  ...(base.relationships ?? []).filter((item) => item.relationshipType !== "CONTAINS"),
  ...base.packages.filter((item) => item.SPDXID !== mainPackage.SPDXID).map((item) => ({ spdxElementId: mainPackage.SPDXID, relationshipType: "DEPENDS_ON", relatedSpdxElement: item.SPDXID })),
  ...fileRelationships,
];
mainPackage.packageVerificationCode = { packageVerificationCodeValue: sha256(Buffer.from(files.map((item) => item.checksums[0].checksumValue).sort().join(""))) };
await writeFile(outputPath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
console.log(`Release SPDX SBOM: ${basename(outputPath)} (${base.packages.length} packages, ${files.length} files)`);
