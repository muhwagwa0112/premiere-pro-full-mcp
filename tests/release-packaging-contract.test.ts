import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

  test("hash verification works in Windows PowerShell without Get-FileHash autoloading", () => {
    const common = resolve(root, "scripts", "install", "Common.ps1");
    const target = resolve(root, "LICENSE");
    const expected = createHash("sha256").update(readFileSync(target)).digest("hex");
    const command = [
      "$PSModuleAutoLoadingPreference = 'None'",
      `. '${common.replaceAll("'", "''")}'`,
      `Get-PpMcpSha256 -Path '${target.replaceAll("'", "''")}'`,
    ].join("; ");
    const actual = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8" },
    ).trim();
    expect(actual).toBe(expected);
  });
});
