import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("bounded live bridge deadlines", () => {
  it("keeps CEP inside freshness and gives UI worker serialization headroom", async () => {
    const [cep, uxp, ui, worker, broker, program] = await Promise.all([
      readFile(new URL("../src/bridge/cep-file.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/bridge/uxp-websocket.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/bridge/ui-named-pipe.ts", import.meta.url), "utf8"),
      readFile(new URL("../windows-ui-agent/UiaWorkerClient.cs", import.meta.url), "utf8"),
      readFile(new URL("../src/security/hmac-broker.ts", import.meta.url), "utf8"),
      readFile(new URL("../windows-ui-agent/Program.cs", import.meta.url), "utf8"),
    ]);

    expect(cep).toContain("timeoutMs = 58_000");
    expect(cep).toContain("Math.min(this.#timeoutMs, 60_000)");
    expect(cep).toContain('request.operation === "export.sequence" ? this.#longRunningTimeoutMs : this.#timeoutMs');
    expect(cep).toContain("longRunningTimeoutMs = 5 * 60_000");
    expect(uxp).toContain('request.operation === "export.sequence" ? 30 * 60_000 : 30_000');
    expect(uxp).toContain('pending.request.operation === "export.sequence" ? 60_000 : 5_000');
    expect(ui).toContain('operation === "premiere.controls.catalog" ? 50_000 : 5_000');
    expect(worker).toContain("CatalogDeadline = TimeSpan.FromSeconds(45)");
    expect(broker).toContain('["--hmac", key, "session-key", "node-server"]');
    expect(broker).toContain('createHmac("sha256", await sessionKey(key))');
    expect(broker).toContain("timingSafeEqual(expected, provided)");
    expect(program).toContain('["--hmac", "cep-hmac" or "approval-hmac", "session-key", "node-server"]');
  });
});
