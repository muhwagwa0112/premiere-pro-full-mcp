import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("release package coherence", () => {
  it("keeps package, UXP, and CEP manifest versions identical", () => {
    const root = process.cwd();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const uxp = JSON.parse(readFileSync(join(root, "uxp-plugin", "manifest.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(root, ".codex-plugin", "plugin.json"), "utf8"));
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    const cep = readFileSync(join(root, "cep-plugin", "CSXS", "manifest.xml"), "utf8");
    expect(uxp.version).toBe(pkg.version);
    expect(plugin.version).toBe(pkg.version);
    expect(cep).toContain(`ExtensionBundleVersion="${pkg.version}"`);
    expect(cep).toContain(`Extension Id="com.codex.premiere-pro-full-mcp.cep.headless" Version="${pkg.version}"`);
    expect(mcp.mcpServers["premiere-pro-full-mcp"]).toMatchObject({ cwd: ".", args: ["./dist/index.js"] });
    expect(mcp.mcpServers["premiere-pro-full-mcp"]).not.toHaveProperty("env");
  });

  it("runs the standalone source verifier", () => {
    const output = execFileSync(process.execPath, ["scripts/verify-release.mjs"], { cwd: process.cwd(), encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });

  it("ships both Premiere host plugins in npm and Windows package inputs", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["cep-plugin", "uxp-plugin", "dist/**/*.js", "scripts"]));
  });
});
