import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { UiNamedPipeAdapter } from "../src/bridge/ui-named-pipe.js";

const token = "routing-test-token-1234567890";
const servers: Array<ReturnType<typeof createServer>> = [];

function pipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

async function listen(mode: "disconnect" | "hang"): Promise<{ adapter: UiNamedPipeAdapter }> {
  const name = `PremiereMcpRouting-${randomUUID()}`;
  const server = createServer((socket: Socket) => {
    socket.once("data", () => {
      if (mode === "disconnect") socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath(name), resolve);
  });
  return { adapter: new UiNamedPipeAdapter(token, name, 50) };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("UI dispatch-state classification", () => {
  it("classifies a pre-send connection failure as not_dispatched", async () => {
    const adapter = new UiNamedPipeAdapter(token, `PremiereMcpMissing-${randomUUID()}`, 50);
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.invoke", args: { controlId: "safe-test" } });
    expect(response).toMatchObject({ ok: false, dispatchState: "not_dispatched", error: { code: "UI_UNAVAILABLE" } });
  });

  it("classifies connection loss after request write as non-retryable unknown", async () => {
    const { adapter } = await listen("disconnect");
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.invoke", args: { controlId: "safe-test" } });
    expect(response).toMatchObject({ ok: false, dispatchState: "unknown", error: { code: "UI_DISCONNECTED", retryable: false } });
  });

  it("classifies a timeout after request write as non-retryable unknown", async () => {
    const { adapter } = await listen("hang");
    const response = await adapter.execute({ protocolVersion: 1, requestId: randomUUID(), operation: "ui.invoke", args: { controlId: "safe-test" } });
    expect(response).toMatchObject({ ok: false, dispatchState: "unknown", error: { code: "UI_TIMEOUT", retryable: false } });
  });
});
