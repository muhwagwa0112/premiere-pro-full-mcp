import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { runtimeConfig } from "./config.js";

export interface InstalledPlugin {
  id: string;
  name: string;
  kind: "effect" | "cep" | "uxp";
  version: string | null;
  source: "adobe" | "user" | "third_party";
}

export interface LocalInventory {
  generatedAt: string;
  platform: NodeJS.Platform;
  architecture: string;
  supportedHost: { product: string; expectedVersion: string; executablePresent: boolean };
  plugins: InstalledPlugin[];
  counts: { effects: number; cep: number; uxp: number; total: number };
  revision: string;
  warnings: string[];
}

const MAX_DISCOVERED_FILES = 4_000;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walk(root: string, predicate: (path: string) => boolean, maxDepth = 8): Promise<string[]> {
  const found: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > maxDepth || found.length >= MAX_DISCOVERED_FILES) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_DISCOVERED_FILES) return;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (entry.isFile() && predicate(child)) found.push(child);
    }
  }
  if (await exists(root)) await visit(root, 0);
  return found;
}

function cleanEffectName(path: string): string {
  return basename(path, extname(path)).replace(/[_-]+/g, " ").trim();
}

function classifySource(path: string): InstalledPlugin["source"] {
  const normalized = path.toLowerCase();
  if (normalized.includes("\\users\\") || normalized.includes("/users/")) return "user";
  if (normalized.includes("\\adobe\\") && !normalized.includes("filmimpact") && !normalized.includes("misterhorse") && !normalized.includes("mocha")) return "adobe";
  return "third_party";
}

async function parseManifest(path: string, kind: "cep" | "uxp"): Promise<InstalledPlugin | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (kind === "uxp") {
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const id = typeof manifest.id === "string" ? manifest.id : basename(join(path, ".."));
      const name = typeof manifest.name === "string" ? manifest.name : id;
      const version = typeof manifest.version === "string" ? manifest.version : null;
      return { id, name, kind, version, source: classifySource(path) };
    }
    const id = /ExtensionBundleId="([^"]+)"/.exec(raw)?.[1] ?? basename(join(path, "..", ".."));
    const name = /ExtensionBundleName="([^"]+)"/.exec(raw)?.[1] ?? id;
    const version = /ExtensionBundleVersion="([^"]+)"/.exec(raw)?.[1] ?? null;
    return { id, name, kind, version, source: classifySource(path) };
  } catch {
    return null;
  }
}

export async function collectLocalInventory(): Promise<LocalInventory> {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  // The host root can be overridden for other install locations; the default
  // is the standard Adobe folder for the current product family.
  const premiereRoot = process.env.PREMIERE_MCP_PREMIERE_ROOT ?? join(programFiles, "Adobe", runtimeConfig.product);
  const executable = join(premiereRoot, "Adobe Premiere Pro.exe");
  const effectRoots = [
    join(premiereRoot, "PlugIns"),
    join(programFiles, "Adobe", "Common", "Plug-ins", "7.0", "MediaCore"),
    join(programFiles, "Common Files", "Adobe", "Plug-ins", "7.0", "MediaCore"),
  ];
  const cepRoots = [
    join(programFiles, "Common Files", "Adobe", "CEP", "extensions"),
    join(appData, "Adobe", "CEP", "extensions"),
  ];
  const uxpRoots = [
    join(premiereRoot, "UXP", "plugins"),
    join(appData, "Adobe", "UXP", "PluginsStorage", "PPRO"),
  ];

  const plugins: InstalledPlugin[] = [];
  const effectPaths = (await Promise.all(effectRoots.map((root) => walk(root, (path) => extname(path).toLowerCase() === ".prm", 10)))).flat();
  for (const path of effectPaths) {
    const name = cleanEffectName(path);
    plugins.push({ id: `effect:${name.toLowerCase().replace(/\s+/g, "-")}`, name, kind: "effect", version: null, source: classifySource(path) });
  }

  const cepManifests = (await Promise.all(cepRoots.map((root) => walk(root, (path) => path.toLowerCase().endsWith("csxs\\manifest.xml") || path.toLowerCase().endsWith("csxs/manifest.xml"), 4)))).flat();
  for (const path of cepManifests) {
    const parsed = await parseManifest(path, "cep");
    if (parsed) plugins.push(parsed);
  }

  const uxpManifests = (await Promise.all(uxpRoots.map((root) => walk(root, (path) => basename(path).toLowerCase() === "manifest.json", 8)))).flat();
  for (const path of uxpManifests) {
    const parsed = await parseManifest(path, "uxp");
    if (parsed) plugins.push(parsed);
  }

  const unique = [...new Map(plugins.map((plugin) => [`${plugin.kind}:${plugin.id}`, plugin])).values()]
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
  const revision = createHash("sha256").update(JSON.stringify(unique.map(({ id, kind, version }) => ({ id, kind, version })))).digest("hex");
  const counts = {
    effects: unique.filter((plugin) => plugin.kind === "effect").length,
    cep: unique.filter((plugin) => plugin.kind === "cep").length,
    uxp: unique.filter((plugin) => plugin.kind === "uxp").length,
    total: unique.length,
  };
  const warnings: string[] = [];
  if (effectPaths.length >= MAX_DISCOVERED_FILES) warnings.push("Effect scan reached its safety limit");
  if (!(await exists(executable))) warnings.push(`${runtimeConfig.product} executable was not found`);
  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    supportedHost: { product: runtimeConfig.product, expectedVersion: runtimeConfig.minimumHostVersion, executablePresent: await exists(executable) },
    plugins: unique,
    counts,
    revision,
    warnings,
  };
}
