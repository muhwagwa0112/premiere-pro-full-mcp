import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { CepFileAdapter } from "../src/bridge/cep-file.js";
import { signEnvelope, verifyEnvelope } from "../src/security/signed-envelope.js";

const secret = randomBytes(32);
const authenticate = {
  sign: async (value: Record<string, unknown>) => signEnvelope(value, secret),
  verify: async (value: Record<string, unknown>, signature: unknown) => verifyEnvelope(value, signature, secret),
};

async function commandFile(directory: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = (await readdir(directory)).find((entry) => /^command-.*\.json$/.test(entry));
    if (name) return name;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("CEP command was not created");
}

describe("authenticated CEP file bridge", () => {
  it("accepts only a signed fresh heartbeat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-cep-"));
    const unsigned = { timestamp: Date.now(), hostVersion: "26.3.2", capabilities: ["typed"], nonce: "heartbeat-test", sessionId: "session-test" };
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ ...unsigned, signature: signEnvelope(unsigned, secret) }));
    await expect(new CepFileAdapter("cep", directory, 1_000, authenticate).availability()).resolves.toMatchObject({ available: true, hostVersion: "26.3.2" });
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ ...unsigned, signature: "tampered" }));
    await expect(new CepFileAdapter("cep", directory, 1_000, authenticate).availability()).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/signature/) });
  });

  it("allows broker startup jitter but rejects an actually stale heartbeat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-cep-"));
    const recent = { timestamp: Date.now() - 10_000, hostVersion: "26.3.2", capabilities: ["typed"], nonce: "heartbeat-recent", sessionId: "session-recent" };
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ ...recent, signature: signEnvelope(recent, secret) }));
    await expect(new CepFileAdapter("cep", directory, 1_000, authenticate).availability()).resolves.toMatchObject({ available: true });

    const stale = { ...recent, timestamp: Date.now() - 61_000, nonce: "heartbeat-stale" };
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ ...stale, signature: signEnvelope(stale, secret) }));
    await expect(new CepFileAdapter("cep", directory, 1_000, authenticate).availability()).resolves.toMatchObject({ available: false, reason: "CEP heartbeat is stale" });
  });

  it("signs requests and verifies the response nonce and signature", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-cep-"));
    const adapter = new CepFileAdapter("cep", directory, 2_000, authenticate);
    const heartbeat = { timestamp: Date.now(), hostVersion: "26.3.2", capabilities: ["typed"], nonce: "heartbeat-command", sessionId: "session-command" };
    await writeFile(join(directory, "heartbeat.json"), JSON.stringify({ ...heartbeat, signature: signEnvelope(heartbeat, secret) }));
    const pending = adapter.execute({ protocolVersion: 1, requestId: "request-1", operation: "host.inspect", args: {} });
    const filename = await commandFile(directory);
    const command = JSON.parse(await readFile(join(directory, filename), "utf8")) as Record<string, unknown>;
    const { signature, ...unsignedCommand } = command;
    expect(verifyEnvelope(unsignedCommand, signature, secret)).toBe(true);
    const response = { protocolVersion: 1, requestId: "request-1", ok: true, result: { host: "Premiere" }, bridgeNonce: command.nonce, issuedAt: Date.now() };
    await writeFile(join(directory, filename.replace("command-", "response-")), JSON.stringify({ ...response, signature: signEnvelope(response, secret) }));
    await expect(pending).resolves.toMatchObject({ ok: true, requestId: "request-1", result: { host: "Premiere" } });
  });
});
