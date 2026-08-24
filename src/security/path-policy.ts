import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ActionDescriptor } from "../contracts.js";
import { createHash } from "node:crypto";

function configuredRoots(): string[] {
  return (process.env.PREMIERE_MCP_APPROVED_ROOTS ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function collectPaths(value: unknown, key = ""): string[] {
  if (typeof value === "string") return /path(s)?$/i.test(key) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPaths(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => collectPaths(child, childKey));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function canonicalize(path: string): Promise<string> {
  const absolute = resolve(path);
  if (await exists(absolute)) return realpath(absolute);
  const suffix: string[] = [];
  let cursor = absolute;
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`No existing parent could be resolved for path: ${path}`);
    suffix.unshift(cursor.slice(parent.length).replace(/^[/\\]+/, ""));
    cursor = parent;
  }
  const canonicalParent = await realpath(cursor);
  return resolve(canonicalParent, ...suffix);
}

function isWithin(path: string, root: string): boolean {
  const result = relative(root, path);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

export class PathPolicy {
  readonly #roots: string[];

  constructor(roots = configuredRoots()) {
    this.#roots = roots;
  }

  async approvedRootDigests(): Promise<string[]> {
    const roots = await Promise.all(this.#roots.map(async (root) => {
      if (!isAbsolute(root)) throw new Error("Approved filesystem roots must be absolute");
      return canonicalize(root);
    }));
    return [...new Set(roots.map((root) => `sha256:${createHash("sha256").update(root, "utf8").digest("hex")}`))].sort();
  }

  roots(): readonly string[] { return [...this.#roots]; }

  async assert(action: ActionDescriptor, args: Record<string, unknown>): Promise<void> {
    if (action.authority !== "filesystem") return;
    const paths = collectPaths(args);
    if (paths.length === 0) throw new Error(`Filesystem action ${action.id} did not provide a path-bearing argument`);
    if (this.#roots.length === 0) throw new Error("No approved filesystem roots are configured in PREMIERE_MCP_APPROVED_ROOTS");
    const roots = await Promise.all(this.#roots.map(async (root) => {
      if (!isAbsolute(root)) throw new Error("Approved filesystem roots must be absolute");
      return canonicalize(root);
    }));
    for (const path of paths) {
      if (!isAbsolute(path)) throw new Error("Filesystem paths must be absolute");
      const canonical = await canonicalize(path);
      if (!roots.some((root) => isWithin(canonical, root))) throw new Error("A requested path is outside the approved filesystem roots");
    }
  }
}
