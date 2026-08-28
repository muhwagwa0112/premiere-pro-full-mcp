import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  APPROVED_CEP_EXTENSION_ID,
  CEP_BRIDGE_PROTOCOL_VERSION,
} from "../src/bridge-types.js";

interface CapturedReadyPayload {
  kind?: unknown;
  premiereVersion?: unknown;
  version?: unknown;
  identity?: {
    extensionId?: unknown;
    protocolVersion?: unknown;
    bridgeVersion?: unknown;
    instanceId?: unknown;
    premiereVersion?: unknown;
  };
}

describe("CEP ready payload contract", () => {
  it("keeps the executable panel handshake aligned with the daemon constants", () => {
    const panelPath = join(process.cwd(), "cep-plugin", "main.ws.js");
    const panelSource = readFileSync(panelPath, "utf8");
    const sent: string[] = [];
    const evalScripts: string[] = [];
    const sockets: MockWebSocket[] = [];
    let projectReadThrows = false;

    class MockWebSocket {
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(readonly url: string) {
        sockets.push(this);
      }

      send(message: string): void {
        sent.push(message);
      }

      close(): void {}
    }

    class MockCSInterface {
      getExtensionID(): string {
        // Exercise main.ws.js's own fallback literal so this test catches
        // one-sided drift from APPROVED_CEP_EXTENSION_ID.
        return "";
      }

      getHostEnvironment(): { appVersion: string } {
        return { appVersion: "26.3.2-test" };
      }

      evalScript(script: string, callback?: (result: string) => void): void {
        evalScripts.push(script);
        const unusual = "project\" slash\\ controls\b\f\n\r\t\u0001";
        const app: Record<string, unknown> = {};
        if (projectReadThrows) {
          Object.defineProperty(app, "project", { get: () => { throw new Error("DOM unavailable"); } });
        } else {
          app.project = {
            name: unusual,
            activeSequence: { sequenceID: unusual, name: unusual },
          };
        }
        const result = runInContext(script, createContext({
          JSON: undefined,
          app,
        }));
        callback?.(String(result));
      }
    }

    const manifest = [
      '<ExtensionManifest ExtensionBundleVersion="9.8.7-test">',
      `  <ExtensionList><Extension Id="${APPROVED_CEP_EXTENSION_ID}" Version="9.8.7-test"/></ExtensionList>`,
      "</ExtensionManifest>",
    ].join("\n");
    const mockRequire = (specifier: string): unknown => {
      if (specifier === "fs") {
        return {
          readFileSync(file: string): string {
            return String(file).endsWith("bridge-endpoint.json")
              ? JSON.stringify({ host: "127.0.0.1", port: 48210, protocol: "ws" })
              : manifest;
          },
        };
      }
      if (specifier === "path") return { join };
      if (specifier === "os") return { homedir: () => "C:\\vm-user" };
      if (specifier === "crypto") return { randomUUID: () => "runtime-instance-test" };
      if (specifier === "ws") return MockWebSocket;
      throw new Error(`Unexpected require from CEP panel: ${specifier}`);
    };

    const sandbox: Record<string, unknown> = {
      require: mockRequire,
      WebSocket: MockWebSocket,
      CSInterface: MockCSInterface,
      __dirname: join(process.cwd(), "cep-plugin"),
      process: { env: { USERPROFILE: "C:\\vm-user" } },
      console: { log(): void {}, error(): void {} },
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    sandbox.global = sandbox;
    runInContext(panelSource, createContext(sandbox), { filename: panelPath });

    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:48210/bridge");
    socket.readyState = 1;
    socket.onopen?.();

    expect(sent).toHaveLength(1);
    const ready = JSON.parse(sent[0]!) as CapturedReadyPayload;
    expect(ready).toMatchObject({
      kind: "ready",
      premiereVersion: "26.3.2-test",
      identity: {
        extensionId: APPROVED_CEP_EXTENSION_ID,
        protocolVersion: CEP_BRIDGE_PROTOCOL_VERSION,
        bridgeVersion: "9.8.7-test",
        instanceId: "runtime-instance-test",
      },
    });
    expect(ready.identity?.instanceId).toEqual(expect.any(String));
    expect(String(ready.identity?.instanceId ?? "").length).toBeGreaterThan(0);
    expect(String(ready.identity?.bridgeVersion ?? "").length).toBeGreaterThan(0);
    expect(ready.identity).not.toHaveProperty("premiereVersion");
    expect(ready).not.toHaveProperty("version");

    socket.onmessage?.({ data: JSON.stringify({ kind: "dom_readiness_probe", requestId: "es3-dom", timeoutMs: 1_000 }) });
    expect(evalScripts).toHaveLength(1);
    expect(evalScripts[0]).not.toContain("JSON.stringify");
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]!)).toMatchObject({
      kind: "response",
      requestId: "es3-dom",
      ok: true,
      data: {
        ok: true,
        projectOpen: true,
        projectName: "project\" slash\\ controls\b\f\n\r\t\u0001",
        activeSequence: {
          id: "project\" slash\\ controls\b\f\n\r\t\u0001",
          name: "project\" slash\\ controls\b\f\n\r\t\u0001",
        },
      },
    });

    projectReadThrows = true;
    socket.onmessage?.({ data: JSON.stringify({ kind: "dom_readiness_probe", requestId: "es3-dom-error", timeoutMs: 1_000 }) });
    expect(evalScripts).toHaveLength(2);
    expect(evalScripts[1]).not.toContain("JSON.stringify");
    expect(sent).toHaveLength(3);
    expect(JSON.parse(sent[2]!)).toMatchObject({
      kind: "response",
      requestId: "es3-dom-error",
      ok: false,
      error: { code: "DOM_PROBE_SCRIPT_ERROR", message: "DOM unavailable" },
    });
  });
});
