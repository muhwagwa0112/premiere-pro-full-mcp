import { readFile } from "node:fs/promises";

export type AdobeBucket = "read" | "edit" | "sensitive" | "filesystem" | "destructive";
export type AdobeSecurityCapability = "overwrite" | "delete" | "cloudPublish" | "cloudShare" | "purchase";

export interface AdobeApiEntry {
  id: string;
  container: string;
  member: string;
  memberKind: "method" | "property" | "constructor";
  parameters: Array<{ name: string; type: string; optional: boolean; rest: boolean }>;
  returnType: string;
  returnTypeHint: string;
  readonly: boolean;
  root: string | null;
  bucket: AdobeBucket;
  risk: "R0" | "R1" | "R2" | "R3";
  authority: "inspect" | "edit" | "filesystem" | "experimental";
  mutates: boolean;
  implementationStatus: string;
  requiredOperation?: string;
}

const requiredCapabilitiesByMemberId = new Map<string, readonly AdobeSecurityCapability[]>([
  ["Project.deleteSequence", ["delete"]],
  ["SequenceEditor.createOverwriteItemAction", ["overwrite"]],
]);

/** Derive privileges from the signed generated member identity, never caller flags. */
export function requiredCapabilitiesForAdobeEntry(entry: AdobeApiEntry | null): readonly AdobeSecurityCapability[] {
  return entry ? [...(requiredCapabilitiesByMemberId.get(entry.id) ?? [])] : [];
}

interface AdobeApiCatalog {
  schemaVersion: number;
  fingerprint: string;
  source: Record<string, unknown>;
  counts: Record<string, number>;
  roots: Record<string, string>;
  entries: AdobeApiEntry[];
}

let catalogPromise: Promise<AdobeApiCatalog> | null = null;

export function loadAdobeApiCatalog(): Promise<AdobeApiCatalog> {
  catalogPromise ??= readFile(new URL("../generated/adobe-uxp-api.json", import.meta.url), "utf8").then((text) => {
    const parsed = JSON.parse(text) as AdobeApiCatalog;
    if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.entries)) throw new Error("Generated Adobe API catalog has an unsupported schema");
    return parsed;
  });
  return catalogPromise;
}

const operationByBucket: Record<AdobeBucket, string> = {
  read: "uxp.read",
  edit: "uxp.edit",
  sensitive: "uxp.sensitive",
  filesystem: "uxp.filesystem",
  destructive: "uxp.destructive",
};

export async function validateAdobeRuntimeCall(operation: string, args: Record<string, unknown>): Promise<AdobeApiEntry | null> {
  if (!operation.startsWith("uxp.") || ["uxp.catalog", "uxp.handle.release", "uxp.page.read", "uxp.transaction.execute", "uxp.locked.batch", "uxp.events.subscribe", "uxp.events.poll", "uxp.events.unsubscribe"].includes(operation)) return null;
  const memberId = args.memberId;
  if (typeof memberId !== "string") throw new Error("memberId is required");
  const catalog = await loadAdobeApiCatalog();
  const entry = catalog.entries.find((candidate) => candidate.id === memberId);
  if (!entry) throw new Error(`Adobe member '${memberId}' is not present in the generated allowlist`);
  if (operationByBucket[entry.bucket] !== operation) throw new Error(`${memberId} is classified as ${entry.bucket} and must use ${operationByBucket[entry.bucket]}`);
  return entry;
}

export function pathArgumentsForEntry(entry: AdobeApiEntry | null, args: Record<string, unknown>): Record<string, unknown> {
  if (!entry || entry.bucket !== "filesystem") return args;
  const supplied = Array.isArray(args.arguments) ? args.arguments : [];
  const paths: string[] = Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : [];
  for (let index = 0; index < entry.parameters.length; index += 1) {
    const parameter = entry.parameters[index];
    if (!parameter) continue;
    if (!/(path|file|folder|directory|preset|destination|output)/i.test(`${parameter.name} ${parameter.type}`)) continue;
    const value = supplied[index];
    if (typeof value === "string") paths.push(value);
    else if (Array.isArray(value)) paths.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return { ...args, paths };
}

export async function searchAdobeApiCatalog(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const catalog = await loadAdobeApiCatalog();
  const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
  const container = typeof args.container === "string" ? args.container : null;
  const bucket = typeof args.bucket === "string" ? args.bucket : null;
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const limit = typeof args.limit === "number" ? Math.min(200, args.limit) : 100;
  const filtered = catalog.entries.filter((entry) => (!query || `${entry.id} ${entry.parameters.map((item) => `${item.name} ${item.type}`).join(" ")} ${entry.returnType}`.toLowerCase().includes(query)) && (!container || entry.container === container) && (!bucket || entry.bucket === bucket));
  return {
    schemaVersion: catalog.schemaVersion,
    fingerprint: catalog.fingerprint,
    source: catalog.source,
    counts: catalog.counts,
    roots: catalog.roots,
    total: filtered.length,
    offset,
    limit,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
    entries: filtered.slice(offset, offset + limit),
  };
}
