import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");
const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const releaseName = `${packageJson.name}-${packageJson.version}`;
const releaseRoot = resolve(repositoryRoot, "release");
const stageRoot = resolve(releaseRoot, releaseName);
const nativePublishRoot = resolve(releaseRoot, ".native-publish-win-x64");
const zipPath = resolve(releaseRoot, `${releaseName}-win-x64.zip`);
if (process.argv.includes("--skip-build")) {
  throw new Error("--skip-build is disabled for public release packaging; a clean native and MCP build is required");
}

function assertChild(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) {
    throw new Error(`Refusing unsafe output path: ${child}`);
  }
}

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: repositoryRoot, stdio: "inherit", windowsHide: true });
}

async function copyPath(sourceRelative, destinationRelative = sourceRelative, options = {}) {
  const source = join(repositoryRoot, sourceRelative);
  const destination = join(stageRoot, destinationRelative);
  await cp(source, destination, {
    recursive: true,
    filter: (candidate) => {
      const normalized = candidate.replaceAll("\\", "/").toLowerCase();
      if (/(^|\/)bootstrap(?:\.|\/|$)/.test(normalized)) return false;
      if (/(^|\/)(\.env(?:\..*)?|node_modules|coverage|bin|obj)(\/|$)/.test(normalized)) return false;
      return options.filter ? options.filter(candidate) : true;
    },
  });
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root);
  return result;
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function normalizeTimestamps(root) {
  const epoch = new Date("2000-01-01T00:00:00.000Z");
  const files = await listFiles(root);
  for (const path of files) await utimes(path, epoch, epoch);
  const directories = [root];
  for (const file of files) {
    let directory = dirname(file);
    while (directory.startsWith(root) && directory !== root) {
      directories.push(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...new Set(directories)].sort().reverse()) await utimes(directory, epoch, epoch);
}

await mkdir(releaseRoot, { recursive: true });
assertChild(releaseRoot, stageRoot);
assertChild(releaseRoot, nativePublishRoot);
await rm(stageRoot, { recursive: true, force: true });
await rm(nativePublishRoot, { recursive: true, force: true });
await rm(zipPath, { force: true });

run("cmd.exe", ["/d", "/s", "/c", "npm run build"]);
run("dotnet.exe", [
  "publish",
  "windows-ui-agent/PremiereMcp.WindowsUiAgent.csproj",
  "--configuration", "Release",
  "--runtime", "win-x64",
  "--self-contained", "true",
  "--output", nativePublishRoot,
  "/p:DebugType=None",
  "/p:DebugSymbols=false",
  "/p:PublishSingleFile=false",
]);

await mkdir(stageRoot, { recursive: true });
await copyPath("bundle");
await copyPath("generated");
await copyPath("uxp-plugin");
await copyPath("cep-plugin");
await copyPath("THIRD-PARTY-LICENSES");
await cp(nativePublishRoot, join(stageRoot, "native", "win-x64"), { recursive: true });

for (const sourceDirectory of ["src", "scripts", "windows-ui-agent/tests"]) {
  await copyPath(sourceDirectory, join("source", sourceDirectory));
}
for (const sourceFile of [
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json",
  "windows-ui-agent/PremiereMcp.WindowsUiAgent.csproj",
  "windows-ui-agent/Program.cs", "windows-ui-agent/McpLauncher.cs", "windows-ui-agent/BrokerSecurity.cs",
  "windows-ui-agent/ApprovalBroker.cs", "windows-ui-agent/PremiereAutomation.cs",
  "windows-ui-agent/Protocol.cs", "windows-ui-agent/SecretStore.cs",
  "windows-ui-agent/UiaWorkerClient.cs", "windows-ui-agent/UiaWorkerEntry.cs",
  "windows-ui-agent/UiaWorkerProtocol.cs",
]) {
  await copyPath(sourceFile, join("source", sourceFile));
}

for (const document of [
  "README.md", "SECURITY.md", "CONTRIBUTING.md", "RESEARCH.md", "CHANGELOG.md",
  "THIRD-PARTY-NOTICES.md", "SBOM.spdx.json", "docs/DEPLOYMENT.md",
  "docs/LIVE-VALIDATION.md", "docs/RELEASE-CHECKLIST.md",
]) {
  await copyPath(document, join("docs", basename(document)));
}

for (const template of ["Install.ps1", "Uninstall.ps1", "RELEASE-README.md"]) {
  const content = (await readFile(join(repositoryRoot, "release-template", template), "utf8"))
    .replaceAll("__PACKAGE_NAME__", packageJson.name)
    .replaceAll("__VERSION__", packageJson.version);
  await writeFile(join(stageRoot, template), content, "utf8");
}

const metadata = {
  schemaVersion: 1,
  name: packageJson.name,
  version: packageJson.version,
  runtimeIdentifier: "win-x64",
  mcpBundle: "bundle/premiere-mcp.bundle.mjs",
  nativeLauncher: "native/win-x64/PremiereMcp.WindowsUiAgent.exe",
  uxpPlugin: "uxp-plugin/manifest.json",
  cepExtension: "cep-plugin/CSXS/manifest.xml",
  build: { selfContained: true, secretsIncluded: false, bootstrapIncluded: false },
};
await writeFile(join(stageRoot, "RELEASE-METADATA.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

const udtRegistrationHelper = join(stageRoot, "source", "scripts", "register-udt-workspace.mjs");
if (!(await stat(udtRegistrationHelper).catch(() => null))) {
  throw new Error("Release is missing source/scripts/register-udt-workspace.mjs required for portable UDT registration");
}

const stagedFiles = await listFiles(stageRoot);
const forbidden = stagedFiles.filter((path) => {
  const name = basename(path).toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name.startsWith("bootstrap.") || name === "bootstrap";
});
if (forbidden.length) throw new Error(`Forbidden development/secret files staged: ${forbidden.join(", ")}`);

const manifestLines = [];
for (const path of stagedFiles) {
  const rel = relative(stageRoot, path).replaceAll("\\", "/");
  manifestLines.push(`${await sha256(path)} *${rel}`);
}
await writeFile(join(stageRoot, "MANIFEST.sha256"), `${manifestLines.join("\n")}\n`, "utf8");
await normalizeTimestamps(stageRoot);

run("powershell.exe", [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
  `Compress-Archive -LiteralPath '${stageRoot.replaceAll("'", "''")}' -DestinationPath '${zipPath.replaceAll("'", "''")}' -CompressionLevel Optimal -Force`,
]);

console.log(`Release stage: ${stageRoot}`);
console.log(`Release ZIP:   ${zipPath}`);
console.log(`Files hashed:  ${manifestLines.length}`);
console.log("Important: build the final native launcher and pin its MCP bundle hash before running package:release.");
