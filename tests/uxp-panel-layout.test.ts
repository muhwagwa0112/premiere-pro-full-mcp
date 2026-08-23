import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("UXP panel minimum layout", () => {
  it("uses Premiere-compatible block flow and keeps every primary control in the minimum panel", async () => {
    const [html, manifestText] = await Promise.all([
      readFile(new URL("../uxp-plugin/index.html", import.meta.url), "utf8"),
      readFile(new URL("../uxp-plugin/manifest.json", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    const panel = manifest.entrypoints.find((entrypoint: { id?: string }) => entrypoint.id === "premiereMcp2026Panel");

    expect(panel.minimumSize).toEqual({ width: 320, height: 260 });
    expect(html).toContain("height:100vh");
    expect(html).toMatch(/\.panel \{[^}]*position:absolute;[^}]*display:block;/);
    expect(html).toMatch(/input \{[^}]*display:block;[^}]*margin:0;/);
    expect(html).not.toContain("display:grid");
    for (const id of ["port", "token", "pair", "connect", "status"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});
