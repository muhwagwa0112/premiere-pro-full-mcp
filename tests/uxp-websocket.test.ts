import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UxpWebSocketAdapter } from "../src/bridge/uxp-websocket.js";
import { loadAdobeApiCatalog } from "../src/adobe-api-catalog.js";

const adapters: UxpWebSocketAdapter[] = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("UXP websocket bridge", () => {
  it("starts without a token and requires a valid local handshake with declared capabilities", async () => {
    const port = 23000 + Math.floor(Math.random() * 5000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    expect((await adapter.availability()).available).toBe(false);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: catalog.fingerprint }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    expect((await adapter.availability()).available).toBe(true);
    const unsupported = await adapter.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "project.save", args: {} });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error?.code).toBe("UXP_CAPABILITY_UNAVAILABLE");
    socket.close();
  });

  it("rejects browser origins before accepting a websocket", async () => {
    const port = 28000 + Math.floor(Math.random() * 2000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "https://attacker.example" });
    socket.on("error", () => {});
    const status = await new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }));
    expect(status).toBe(403);
  });

  it.each([
    ["missing", undefined],
    ["opaque", "null"],
    ["unrelated UXP plug-in", "uxp://other-plugin"],
  ])("rejects a %s origin before the token-free handshake", async (_label, origin) => {
    const port = 29001 + Math.floor(Math.random() * 900);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, origin ? { origin } : undefined);
    socket.on("error", () => {});
    const status = await new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }));
    expect(status).toBe(403);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("accepts Premiere UXP's exact file origin with the token-free local handshake", async () => {
    const port = 30001 + Math.floor(Math.random() * 2000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: catalog.fingerprint }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    expect((await adapter.availability()).available).toBe(true);
    socket.close();
  });

  it("refuses a sequence export that would overwrite an existing file without permission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-uxp-export-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "existing.mp4");
    await writeFile(outputPath, "existing", "utf8");
    const port = 32001 + Math.floor(Math.random() * 2000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["export.sequence"], apiFingerprint: catalog.fingerprint }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    const response = await adapter.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "export.sequence", args: { outputPath, presetPath: join(directory, "preset.epr"), overwrite: false } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UXP_EXPORT_OUTPUT_EXISTS");
    socket.close();
  });

  it("verifies a newly created stable sequence file after local UXP dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-uxp-export-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "created.mp4");
    const port = 34001 + Math.floor(Math.random() * 1000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["export.sequence"], apiFingerprint: catalog.fingerprint }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    const command = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
    const requestId = crypto.randomUUID();
    const resultPromise = adapter.execute({ protocolVersion: 1, requestId, operation: "export.sequence", args: { outputPath, presetPath: join(directory, "preset.epr"), overwrite: false } });
    expect((await command).requestId).toBe(requestId);
    await writeFile(outputPath, "new encoded bytes", "utf8");
    socket.send(JSON.stringify({ type: "response", protocolVersion: 1, requestId, ok: true, hostVersion: "26.3.2" }));
    const response = await resultPromise;
    expect(response.ok).toBe(true);
    expect(response.createdFiles).toEqual([{ name: outputPath, verified: true }]);
    expect(response.verification?.outcome).toBe("verified");
    socket.close();
  }, 20_000);

  it("rejects the removed token-auth protocol instead of accepting an ambiguous legacy client", async () => {
    const port = 35001 + Math.floor(Math.random() * 1000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(JSON.stringify({ type: "auth", protocolVersion: 1, token: "legacy-token", hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: "0".repeat(64) }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects a token-free client whose Adobe API catalog fingerprint does not match", async () => {
    const port = 36001 + Math.floor(Math.random() * 1000);
    const adapter = new UxpWebSocketAdapter(port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: "0".repeat(64) }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });
});
