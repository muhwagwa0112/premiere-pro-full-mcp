import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAction } from "../src/catalog.js";
import { PathPolicy } from "../src/security/path-policy.js";

describe("filesystem path policy", () => {
  it("allows canonical paths inside an approved root and rejects escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ppmcp-root-"));
    await mkdir(join(root, "media"));
    const policy = new PathPolicy([root]);
    const action = getAction("media.import");
    await expect(policy.assert(action, { paths: [join(root, "media", "clip.mov")] })).resolves.toBeUndefined();
    await expect(policy.assert(action, { paths: [join(root, "..", "outside.mov")] })).rejects.toThrow(/outside/);
  });

  it("fails closed when no roots are configured", async () => {
    const policy = new PathPolicy([]);
    await expect(policy.assert(getAction("export.frame"), { outputPath: "C:\\temp\\frame.png", timeSeconds: 0 })).rejects.toThrow(/No approved filesystem roots/);
  });
});
