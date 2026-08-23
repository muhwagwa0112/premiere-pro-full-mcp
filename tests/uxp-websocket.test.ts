import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { UxpWebSocketAdapter } from "../src/bridge/uxp-websocket.js";
import { loadAdobeApiCatalog } from "../src/adobe-api-catalog.js";

const adapters: UxpWebSocketAdapter[] = [];
afterEach(async () => Promise.all(adapters.splice(0).map((adapter) => adapter.close())));

describe("UXP websocket bridge", () => {
  it("requires authentication and declared capabilities", async () => {
    const port = 23000 + Math.floor(Math.random() * 5000);
    const token = "test-token-with-more-than-24-characters";
    const adapter = new UxpWebSocketAdapter(token, port);
    adapters.push(adapter);
    await adapter.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/uxp`);
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    const catalog = await loadAdobeApiCatalog();
    socket.send(JSON.stringify({ type: "auth", protocolVersion: 1, token, hostVersion: "26.3.2", capabilities: ["host.inspect"], apiFingerprint: catalog.fingerprint }));
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    expect((await adapter.availability()).available).toBe(true);
    const unsupported = await adapter.execute({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "project.save", args: {} });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.error?.code).toBe("UXP_CAPABILITY_UNAVAILABLE");
    socket.close();
  });
});
