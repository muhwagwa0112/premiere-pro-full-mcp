import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type CatalogEntry = Record<string, unknown> & { id: string; bucket: string; mutates: boolean };
type ValidationModule = {
  buildPlan(catalog: Record<string, unknown> & { entries: CatalogEntry[]; counts: { members: number } }): { entries: Array<Record<string, unknown>>; counts: Record<string, number> };
  classifyEntry(entry: CatalogEntry): { disposition: string; reason: string };
};

async function validationModule(): Promise<ValidationModule> {
  const url = pathToFileURL(join(process.cwd(), "scripts", "uxp-full-surface-validation.mjs")).href;
  return import(url) as Promise<ValidationModule>;
}

describe("UXP full-surface validation plan", () => {
  it("places every generated member exactly once in the ledger plan", async () => {
    const module = await validationModule();
    const catalog = JSON.parse(await readFile(join(process.cwd(), "generated", "adobe-uxp-api.json"), "utf8"));
    const plan = module.buildPlan(catalog);
    expect(plan.entries).toHaveLength(761);
    expect(new Set(plan.entries.map((entry) => entry.id))).toHaveLength(761);
    expect(Object.values(plan.counts).reduce((sum, value) => sum + value, 0)).toBe(761);
  }, 20_000);

  it("never live-executes mutating, filesystem, sensitive, or destructive members", async () => {
    const module = await validationModule();
    const catalog = JSON.parse(await readFile(join(process.cwd(), "generated", "adobe-uxp-api.json"), "utf8"));
    for (const entry of catalog.entries as CatalogEntry[]) {
      const classification = module.classifyEntry(entry);
      if (entry.mutates || entry.bucket !== "read") expect(classification.disposition).not.toBe("execute_live");
    }
  });

  it("keeps live execution to deterministic zero-argument read operations", async () => {
    const module = await validationModule();
    const catalog = JSON.parse(await readFile(join(process.cwd(), "generated", "adobe-uxp-api.json"), "utf8"));
    const plan = module.buildPlan(catalog);
    const live = plan.entries.filter((entry) => entry.disposition === "execute_live");
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((entry) => entry.bucket === "read" && entry.mutates === false && entry.requiredArguments === 0)).toBe(true);
  });
});
