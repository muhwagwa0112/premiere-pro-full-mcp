import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("bounded live bridge deadlines", () => {
  it("keeps CEP inside freshness and gives UI worker serialization headroom", async () => {
    const [cep, ui, worker] = await Promise.all([
      readFile(new URL("../src/bridge/cep-file.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/bridge/ui-named-pipe.ts", import.meta.url), "utf8"),
      readFile(new URL("../windows-ui-agent/UiaWorkerClient.cs", import.meta.url), "utf8"),
    ]);

    expect(cep).toContain("timeoutMs = 58_000");
    expect(cep).toContain("Math.min(this.#timeoutMs, 60_000)");
    expect(ui).toContain('operation === "premiere.controls.catalog" ? 50_000 : 5_000');
    expect(worker).toContain("CatalogDeadline = TimeSpan.FromSeconds(45)");
  });
});
