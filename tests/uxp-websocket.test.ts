import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BRIDGE_SETTINGS_FILE_NAME, UxpWebSocketAdapter } from "../src/bridge/uxp-websocket.js";
import { loadAdobeApiCatalog } from "../src/adobe-api-catalog.js";

const AUTH_FILE_NAME = "premiere-mcp-bridge-key-v1";
const UXP_PLUGIN_ID = "com.codex.premiere-pro-full-mcp";
const adapters: UxpWebSocketAdapter[] = [];
const temporaryDirectories: string[] = [];
const identities = new Map<string, { authFilePath: string; secret: string }>();

function transcript(role: "client" | "server", clientNonce: string, serverNonce: string, fingerprint: string): string {
  return `premiere-mcp-uxp-v3\n${role}\n${clientNonce}\n${serverNonce}\n${fingerprint}`;
}

function proof(secret: string, role: "client" | "server", clientNonce: string, serverNonce: string, fingerprint: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(transcript(role, clientNonce, serverNonce, fingerprint), "ascii").digest("hex");
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>)));
}

async function testAdapter(port: number): Promise<{ adapter: UxpWebSocketAdapter; authRoot: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ppmcp-uxp-auth-"));
  temporaryDirectories.push(directory);
  const authRoot = join(directory, "PPRO");
  await mkdir(authRoot, { recursive: true });
  const identity = await createAuthFile(authRoot);
  identities.set(authRoot, identity);
  const adapter = new UxpWebSocketAdapter(port, authRoot, async () => identity);
  adapters.push(adapter);
  await adapter.start();
  return { adapter, authRoot };
}

async function createAuthFile(authRoot: string): Promise<{ authFilePath: string; secret: string }> {
  const authFilePath = join(authRoot, "26", "External", UXP_PLUGIN_ID, "PluginData", AUTH_FILE_NAME);
  const secret = randomBytes(32).toString("hex");
  await mkdir(dirname(authFilePath), { recursive: true });
  await writeFile(authFilePath, secret, "utf8");
  return { authFilePath, secret };
}

async function authenticatedSocket(port: number, authRoot: string, capabilities: string[]): Promise<{ socket: WebSocket; sessionId: string }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
  await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  const catalog = await loadAdobeApiCatalog();
  const { authFilePath, secret } = identities.get(authRoot) ?? (() => { throw new Error("Test UXP authentication identity is missing"); })();
  const clientNonce = randomBytes(32).toString("hex");
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath, clientNonce, apiFingerprint: catalog.fingerprint }));
  const challenge = await nextMessage(socket);
  expect(challenge.type).toBe("challenge");
  expect(challenge.protocolVersion).toBe(3);
  const serverNonce = String(challenge.serverNonce);
  expect(challenge.serverProof).toBe(proof(secret, "server", clientNonce, serverNonce, catalog.fingerprint));
  socket.send(JSON.stringify({ type: "connect", protocolVersion: 3, clientProof: proof(secret, "client", clientNonce, serverNonce, catalog.fingerprint), hostVersion: "26.3.2", capabilities, apiFingerprint: catalog.fingerprint }));
  const connected = await nextMessage(socket);
  expect(connected.type).toBe("connected");
  expect(connected.protocolVersion).toBe(3);
  return { socket, sessionId: String(connected.sessionId) };
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  identities.clear();
});

describe("UXP websocket bridge", () => {
  it("starts without a user-managed token and requires an authenticated plugin-data handshake", async () => {
    const port = 23000 + Math.floor(Math.random() * 5000);
    const { adapter, authRoot } = await testAdapter(port);
    const settingsFile = join(authRoot, "26", "External", UXP_PLUGIN_ID, "PluginData", BRIDGE_SETTINGS_FILE_NAME);
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { schemaVersion?: number; port?: number };
    expect(settings.port).toBe(port);
    expect((await adapter.availability()).available).toBe(false);
    const { socket } = await authenticatedSocket(port, authRoot, ["host.inspect"]);
    expect((await adapter.availability()).available).toBe(true);
    const unsupported = await adapter.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "project.save", args: {} });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error?.code).toBe("UXP_CAPABILITY_UNAVAILABLE");
    socket.close();
  });

  it("rejects browser origins before accepting a websocket", async () => {
    const port = 28000 + Math.floor(Math.random() * 2000);
    await testAdapter(port);
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
  ])("rejects a %s origin before the automatic handshake", async (_label, origin) => {
    const port = 29001 + Math.floor(Math.random() * 900);
    const { adapter } = await testAdapter(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, origin ? { origin } : undefined);
    socket.on("error", () => {});
    const status = await new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }));
    expect(status).toBe(403);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects the former public protocol-v2 fingerprint handshake", async () => {
    const port = 30001 + Math.floor(Math.random() * 1000);
    const { adapter } = await testAdapter(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 2, hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: catalog.fingerprint }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects an authentication file outside the current user's Premiere UXP data root", async () => {
    const port = 31001 + Math.floor(Math.random() * 1000);
    const { adapter, authRoot } = await testAdapter(port);
    const outsidePath = join(dirname(authRoot), AUTH_FILE_NAME);
    await writeFile(outsidePath, randomBytes(32).toString("hex"), "utf8");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath: outsidePath, clientNonce: randomBytes(32).toString("hex"), apiFingerprint: catalog.fingerprint }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects an authentication file owned by another UXP plug-in", async () => {
    const port = 31501 + Math.floor(Math.random() * 400);
    const { adapter, authRoot } = await testAdapter(port);
    const authFilePath = join(authRoot, "26", "External", "com.example.other-plugin", "PluginData", AUTH_FILE_NAME);
    await mkdir(dirname(authFilePath), { recursive: true });
    await writeFile(authFilePath, randomBytes(32).toString("hex"), "utf8");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath, clientNonce: randomBytes(32).toString("hex"), apiFingerprint: catalog.fingerprint }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects a client that cannot prove possession of the plugin-data key", async () => {
    const port = 32001 + Math.floor(Math.random() * 1000);
    const { adapter, authRoot } = await testAdapter(port);
    const { authFilePath } = identities.get(authRoot) ?? (() => { throw new Error("Test UXP authentication identity is missing"); })();
    const catalog = await loadAdobeApiCatalog();
    const clientNonce = randomBytes(32).toString("hex");
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath, clientNonce, apiFingerprint: catalog.fingerprint }));
    await nextMessage(socket);
    socket.send(JSON.stringify({ type: "connect", protocolVersion: 3, clientProof: "0".repeat(64), hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: catalog.fingerprint }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("refuses a sequence export that would overwrite an existing file without permission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-uxp-export-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "existing.mp4");
    await writeFile(outputPath, "existing", "utf8");
    const port = 33001 + Math.floor(Math.random() * 1000);
    const { adapter, authRoot } = await testAdapter(port);
    const { socket } = await authenticatedSocket(port, authRoot, ["export.sequence"]);
    const response = await adapter.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "export.sequence", args: { outputPath, presetPath: join(directory, "preset.epr"), overwrite: false } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("UXP_EXPORT_OUTPUT_EXISTS");
    socket.close();
  });

  it("binds commands and responses to the authenticated websocket session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ppmcp-uxp-export-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "created.mp4");
    const port = 34001 + Math.floor(Math.random() * 1000);
    const { adapter, authRoot } = await testAdapter(port);
    const { socket, sessionId } = await authenticatedSocket(port, authRoot, ["export.sequence"]);
    const command = new Promise<Record<string, unknown>>((resolve) => socket.once("message", (data) => resolve(JSON.parse(data.toString()))));
    const requestId = crypto.randomUUID();
    const resultPromise = adapter.execute({ protocolVersion: 1, requestId, operation: "export.sequence", args: { outputPath, presetPath: join(directory, "preset.epr"), overwrite: false } });
    const sent = await command;
    expect(sent.requestId).toBe(requestId);
    expect(sent.sessionId).toBe(sessionId);
    await writeFile(outputPath, "new encoded bytes", "utf8");
    socket.send(JSON.stringify({ type: "response", protocolVersion: 1, sessionId, requestId, ok: true, hostVersion: "26.3.2" }));
    const response = await resultPromise;
    expect(response.ok).toBe(true);
    expect(response.createdFiles).toEqual([{ name: outputPath, verified: true }]);
    expect(response.verification?.outcome).toBe("verified");
    socket.close();
  }, 20_000);

  it("rejects the removed user-token protocol", async () => {
    const port = 35001 + Math.floor(Math.random() * 1000);
    const { adapter } = await testAdapter(port);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "auth", protocolVersion: 1, token: "legacy-token", hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: "0".repeat(64) }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });

  it("rejects a client whose Adobe API catalog fingerprint does not match", async () => {
    const port = 36001 + Math.floor(Math.random() * 1000);
    const { adapter, authRoot } = await testAdapter(port);
    const { authFilePath } = identities.get(authRoot) ?? (() => { throw new Error("Test UXP authentication identity is missing"); })();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`, { origin: "file://" });
    await new Promise<void>((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath, clientNonce: randomBytes(32).toString("hex"), apiFingerprint: "0".repeat(64) }));
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    expect(code).toBe(1008);
    expect((await adapter.availability()).available).toBe(false);
  });
});
