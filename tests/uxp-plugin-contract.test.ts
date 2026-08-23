import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("UXP bridge deployment contract", () => {
  it("keeps network permission constrained to the authenticated localhost broker", async () => {
    const manifest = JSON.parse(await readFile(resolve("uxp-plugin/manifest.json"), "utf8"));
    expect(manifest.requiredPermissions.network.domains).toEqual(["ws://localhost/"]);
  });

  it("creates short-lived Adobe Action objects inside executeTransaction", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    const transaction = source.slice(source.indexOf('if (operation === "uxp.transaction.execute")'), source.indexOf('if (operation === "uxp.locked.batch")'));
    expect(transaction).toContain("project.lockedAccess(function ()");
    expect(transaction).toContain("project.executeTransaction(function (compoundAction)");
    expect(transaction).toContain("compoundAction.addAction(invocation.method.apply");
    expect(transaction).not.toContain("await invokeMember");
  });

  it("passes Premiere a Windows directory and basename for frame export", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    expect(source).toContain('const filename = normalized.slice(separator + 1)');
    expect(source).toContain('exportSequenceFrame(context.sequence, frameTime, filename, directory');
  });

  it("registers the installed panel lifecycle with the manifest entrypoint id", async () => {
    const [source, manifestText] = await Promise.all([
      readFile(resolve("uxp-plugin/main.cjs"), "utf8"),
      readFile(resolve("uxp-plugin/manifest.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    const panelId = manifest.entrypoints.find((entrypoint: { type?: string }) => entrypoint.type === "panel").id;
    expect(panelId).toBe("premiereMcp2026Panel");
    expect(source).toContain("uxp.entrypoints.setup({");
    expect(source).toContain(`${panelId}: {`);
    for (const hook of ["create", "show", "hide", "destroy"]) expect(source).toContain(`${hook}() {}`);
  });
});
