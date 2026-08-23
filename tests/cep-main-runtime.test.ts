import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("CEP host scheduling", () => {
  it("isolates the public command namespace and serializes ExtendScript evaluation", async () => {
    const source = await readFile(new URL("../cep-plugin/main.js", import.meta.url), "utf8");

    expect(source).toContain('"PremiereMCP", "cep-public-v1"');
    expect(source).toContain("var hostEvalBusy = false;");
    expect(source).toContain("var lastHeartbeatAt = 0;");
    expect(source).toContain("if (busy || hostEvalBusy) return;");
    expect(source).toContain("Date.now() - lastHeartbeatAt >= 20000");
    expect(source).toContain('typeof PPMCP.heartbeat!==\\"function\\"');
    expect(source).toContain('typeof PPMCP.dispatch!==\\"function\\"');
    expect(source).not.toContain('hostLoaderPrefix + "return PPMCP.heartbeat()');
    expect(source).not.toContain('hostLoaderPrefix + "return PPMCP.dispatch(');
  });
});
