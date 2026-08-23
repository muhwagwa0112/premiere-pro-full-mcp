import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const [bundleArgument, syftArgument, outputArgument] = process.argv.slice(2);
if (!bundleArgument || !syftArgument || !outputArgument) throw new Error("Usage: node scripts/generate-release-sbom.mjs <bundle-root> <syft-spdx-json> <output>");
const repositoryRoot = resolve(import.meta.dirname, "..");
const bundleRoot = resolve(bundleArgument);
const outputPath = resolve(outputArgument);
const base = JSON.parse(await readFile(resolve(syftArgument), "utf8"));
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

const spdxId = (value) => value.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const mainId = `SPDXRef-Package-${spdxId(packageJson.name)}-${spdxId(packageJson.version)}`;
base.packages ??= [];
const syftDocumentRootIds = new Set(base.packages
  .filter((item) => item.primaryPackagePurpose === "FILE" || String(item.SPDXID ?? "").startsWith("SPDXRef-DocumentRoot-"))
  .map((item) => item.SPDXID));
base.packages = base.packages.filter((item) => !syftDocumentRootIds.has(item.SPDXID));
let mainPackage = base.packages.find((item) => item.name === packageJson.name && item.versionInfo === packageJson.version);
const previousMainId = mainPackage?.SPDXID;
if (!mainPackage) {
  mainPackage = {
    name: packageJson.name, SPDXID: mainId, versionInfo: packageJson.version, packageFileName: "",
    description: packageJson.description, primaryPackagePurpose: "APPLICATION",
    downloadLocation: "https://github.com/muhwagwa0112/premiere-pro-full-mcp",
    homepage: "https://github.com/muhwagwa0112/premiere-pro-full-mcp", filesAnalyzed: true,
    licenseDeclared: "MIT", licenseConcluded: "NOASSERTION", copyrightText: "Copyright (c) 2026 muhwagwa0112",
    externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: `pkg:github/muhwagwa0112/premiere-pro-full-mcp@${packageJson.version}` }],
  };
  base.packages.push(mainPackage);
} else {
  mainPackage.SPDXID = mainId;
  mainPackage.filesAnalyzed = true;
  mainPackage.licenseDeclared = "MIT";
}
base.documentDescribes = [mainId];

const syftFileIds = new Set((base.files ?? []).map((item) => item.SPDXID));
const existingFiles = new Map();
const relationships = (base.relationships ?? [])
  .filter((item) => !syftFileIds.has(item.spdxElementId) && !syftFileIds.has(item.relatedSpdxElement))
  .filter((item) => !syftDocumentRootIds.has(item.spdxElementId) && !syftDocumentRootIds.has(item.relatedSpdxElement))
  .map((item) => ({
    ...item,
    spdxElementId: item.spdxElementId === previousMainId ? mainId : item.spdxElementId,
    relatedSpdxElement: item.relatedSpdxElement === previousMainId ? mainId : item.relatedSpdxElement,
  }));
const relationshipKeys = new Set(relationships.map((item) => `${item.spdxElementId}|${item.relationshipType}|${item.relatedSpdxElement}`));
function relate(source, type, target) {
  const key = `${source}|${type}|${target}`;
  if (!relationshipKeys.has(key)) {
    relationshipKeys.add(key);
    relationships.push({ spdxElementId: source, relationshipType: type, relatedSpdxElement: target });
  }
}

const releaseFiles = [];
for (const path of (await walk(bundleRoot)).sort()) {
  if (resolve(path) === outputPath) continue;
  const fileName = relative(bundleRoot, path).replaceAll("\\", "/");
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  let file = existingFiles.get(fileName);
  if (!file) {
    file = { fileName, SPDXID: `SPDXRef-File-${sha256(Buffer.from(`${fileName}\0${digest}`))}`, checksums: [{ algorithm: "SHA256", checksumValue: digest }], licenseConcluded: "NOASSERTION", copyrightText: "NOASSERTION" };
    existingFiles.set(fileName, file);
  } else if (!Array.isArray(file.checksums) || !file.checksums.some((item) => item.algorithm === "SHA256" && item.checksumValue === digest)) {
    file.checksums = [{ algorithm: "SHA256", checksumValue: digest }, ...(file.checksums ?? []).filter((item) => item.algorithm !== "SHA256")];
  }
  releaseFiles.push(file);
  relate(mainId, "CONTAINS", file.SPDXID);
}
for (const pkg of base.packages) if (pkg.SPDXID !== mainId) relate(mainId, "DEPENDS_ON", pkg.SPDXID);

base.spdxVersion = "SPDX-2.3";
base.dataLicense = "CC0-1.0";
base.name = `${packageJson.name}@${packageJson.version}-windows-release`;
base.documentNamespace = `https://spdx.local/${packageJson.name}/${sha256(await readFile(join(repositoryRoot, "package-lock.json")))}`;
base.creationInfo = { created: "2000-01-01T00:00:00.000Z", creators: ["Tool: anchore/syft", "Tool: premiere-pro-full-mcp/scripts/generate-release-sbom.mjs"] };
base.files = [...existingFiles.values()];
base.relationships = relationships;
mainPackage.packageVerificationCode = { packageVerificationCodeValue: sha256(Buffer.from(releaseFiles.map((item) => item.checksums.find((checksum) => checksum.algorithm === "SHA256").checksumValue).sort().join(""))) };
const localPathLeaks = [];
function findLocalPathLeaks(value, location = "$") {
  if (typeof value === "string") {
    if (/(?:^|[\s"'(=])[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value) || /(?:^|[\\/])Users[\\/][^\\/]+/i.test(value)) {
      localPathLeaks.push(`${location}: ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findLocalPathLeaks(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) findLocalPathLeaks(item, `${location}.${key}`);
  }
}
findLocalPathLeaks(base);
if (localPathLeaks.length) throw new Error(`SBOM contains local absolute paths:\n${localPathLeaks.join("\n")}`);
await writeFile(outputPath, `${JSON.stringify(base, null, 2)}\n`, "utf8");
console.log(`Release SPDX SBOM: ${basename(outputPath)} (${base.packages.length} packages, ${releaseFiles.length} release files, ${base.files.length} cataloged files)`);
