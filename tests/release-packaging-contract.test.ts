import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("release packaging contract", () => {
  test("requires an explicit Adobe UDT CCX before checking the worktree", () => {
    const script = readFileSync(resolve(root, "scripts", "Build-Release.ps1"), "utf8");
    const requiredCheck = script.indexOf("A CCX packaged by Adobe UXP Developer Tool is required");
    const dirtyCheck = script.indexOf("status --porcelain");
    expect(requiredCheck).toBeGreaterThan(0);
    expect(requiredCheck).toBeLessThan(dirtyCheck);
    expect(script).not.toContain("scripts\\Build-Ccx.ps1");
  });

  test("development archive cannot be emitted as a CCX", () => {
    const script = readFileSync(resolve(root, "scripts", "Build-Ccx.ps1"), "utf8");
    expect(script).toContain("uxp-dev-archive.zip");
    expect(script).toContain("Only Adobe UXP Developer Tool may produce a release .ccx");
    expect(script).not.toContain("Move-Item -LiteralPath $zipPath");
  });

  test("npm exposes the archive only as a development command", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.scripts["uxp:dev-archive"]).toBeTruthy();
    expect(pkg.scripts["uxp:package"]).toBeUndefined();
    expect(pkg.private).toBe(true);
  });
});
