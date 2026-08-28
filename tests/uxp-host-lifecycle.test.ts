import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { UxpBridgeHost } from "../src/bridge/uxp-host.js";

let host: UxpBridgeHost | null = null;
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  if (host) { await host.close(); host = null; }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for UXP message")), 2_000);
    socket.once("message", (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
}

async function connectPanel(port: number, secret: string, fingerprint: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const clientNonce = randomBytes(32).toString("hex");
  const challengeMessage = nextMessage(socket);
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath: "test", clientNonce, apiFingerprint: fingerprint }));
  const challenge = await challengeMessage;
  const serverNonce = String(challenge.serverNonce);
  const transcript = `premiere-mcp-uxp-v3\nclient\n${clientNonce}\n${serverNonce}\n${fingerprint}`;
  const clientProof = createHmac("sha256", Buffer.from(secret, "hex")).update(Buffer.from(transcript, "ascii")).digest("hex");
  const connectedMessage = nextMessage(socket);
  socket.send(JSON.stringify({
    type: "connect", protocolVersion: 3, clientProof, hostVersion: "26.3", capabilities: ["test"], apiFingerprint: fingerprint,
  }));
  await connectedMessage;
  return socket;
}

describe("UXP bridge pending lifecycle", () => {
  it("settles pending dispatches on disconnect, replacement, and host close", async () => {
    const secret = "1".repeat(64);
    const fingerprint = "2".repeat(64);
    host = await UxpBridgeHost.start({ port: await freePort(), apiFingerprint: fingerprint, authSecret: secret });

    const first = await connectPanel(host.port, secret, fingerprint);
    const disconnected = host.dispatch("test.operation");
    await nextMessage(first);
    first.close();
    await expect(disconnected).resolves.toMatchObject({ success: false, code: "UXP_DISCONNECTED" });

    const oldPanel = await connectPanel(host.port, secret, fingerprint);
    const replaced = host.dispatch("test.operation");
    await nextMessage(oldPanel);
    await connectPanel(host.port, secret, fingerprint);
    await expect(replaced).resolves.toMatchObject({ success: false, code: "UXP_REPLACED" });

    const closing = host.dispatch("test.operation");
    const active = clients.at(-1)!;
    await nextMessage(active);
    const closePromise = host.close();
    await expect(closing).resolves.toMatchObject({ success: false, code: "UXP_HOST_CLOSED" });
    await closePromise;
    host = null;
  });

  it("uses the caller timeout for the panel command and marks timeout outcome unknown", async () => {
    const secret = "3".repeat(64);
    const fingerprint = "4".repeat(64);
    host = await UxpBridgeHost.start({ port: await freePort(), apiFingerprint: fingerprint, authSecret: secret });
    const panel = await connectPanel(host.port, secret, fingerprint);

    const dispatch = host.dispatch("test.timeout", {}, undefined, 250);
    const command = await nextMessage(panel);
    expect(command).toMatchObject({ type: "command", operation: "test.timeout", timeoutMs: 250 });
    await expect(dispatch).resolves.toMatchObject({ success: false, code: "UXP_TIMEOUT", outcomeUnknown: true });
  });
});
