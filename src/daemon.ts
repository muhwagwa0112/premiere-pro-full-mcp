import { WsHost, DEFAULT_DAEMON_PORT, daemonStateDir, daemonEndpointPath, daemonPidFile } from "./bridge/ws-host.js";
import { UxpBridgeHost, UXP_DEFAULT_PORT, readUxpAuthSecret, uxpPluginDataDir, uxpAuthRootDir } from "./bridge/uxp-host.js";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Load the UXP api-catalog fingerprint from the on-disk plugin catalog so the
// daemon can verify the panel's handshake. The catalog is a CJS file exporting
// { fingerprint, counts }.
function loadUxpApiFingerprint(): string {
  const require = createRequire(import.meta.url);
  const catalogPath = join(
    process.env.LOCALAPPDATA ?? "",
    "PremiereMCP",
    "uxp-plugin-0.4.0",
    "api-catalog.cjs",
  );
  try {
    const catalog = require(catalogPath) as { fingerprint?: string };
    if (typeof catalog.fingerprint === "string" && /^[a-f0-9]{64}$/.test(catalog.fingerprint)) return catalog.fingerprint;
  } catch {
    // Fall through to the known fingerprint.
  }
  return "3ad423e187ccb155afd139a8181bdc3093de357fb183d7505b4a00e1e3c3b17e";
}

/**
 * Always-on bridge daemon entry point.
 *
 * This is the process that stays up permanently (auto-started at user logon).
 * It hosts the loopback WebSocket router and answers MCP-server "execute"
 * requests by relaying them to the Premiere CEP host and back.
 *
 * The daemon intentionally never exits on its own.
 */
export async function runDaemon(options: { port?: number } = {}): Promise<{ host: WsHost; port: number }> {
  const port = options.port ?? DEFAULT_DAEMON_PORT;
  const host = await WsHost.start(port);
  try {
    const uxp = await startUxpBridge();
    host.setUxpBridge(uxp.host);
    process.stderr.write(`[premiere-bridge-daemon] UXP bridge listening on ws://127.0.0.1:${uxp.port}/uxp (panel ${uxp.host.hostVersion ?? "not connected yet"})\n`);
  } catch (error) {
    // UXP is an optional second track. If it cannot start (e.g. the auth key
    // is missing), keep the CEP daemon alive and just log the failure.
    process.stderr.write(`[premiere-bridge-daemon] UXP bridge disabled: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return { host, port: host.port };
}

/** Start the UXP bridge (the second track) alongside the CEP daemon. */
export async function startUxpBridge(): Promise<{ host: UxpBridgeHost; port: number }> {
  const authSecret = readUxpAuthSecret();
  const fingerprint = loadUxpApiFingerprint();
  const host = await UxpBridgeHost.start({ port: UXP_DEFAULT_PORT, apiFingerprint: fingerprint, authSecret });
  // Publish the bridge port into the same plugin data folder the panel reads
  // (the panel defaults to 17777 but reads this override first).
  const pluginDataDir = uxpPluginDataDir();
  try {
    writeFileSync(
      join(pluginDataDir, "bridge-settings-v1.json"),
      `${JSON.stringify({ schemaVersion: 1, port: host.port })}\n`,
      "utf8",
    );
  } catch {
    // Non-fatal: the panel falls back to the default port.
  }
  return { host, port: host.port };
}

export function daemonInfo(): { stateDir: string; endpoint: string; pidFile: string } {
  return {
    stateDir: daemonStateDir(),
    endpoint: daemonEndpointPath(),
    pidFile: daemonPidFile(),
  };
}

export { WsHost, DEFAULT_DAEMON_PORT };

// Direct CLI entry: `node dist/daemon.js`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js") || process.argv[1]?.endsWith("dist\\daemon.js")) {
  runDaemon()
    .then(({ port }) => {
      process.stderr.write(`[premiere-bridge-daemon] listening on ws://127.0.0.1:${port}/bridge (pid ${process.pid})\n`);
    })
    .catch((error) => {
      process.stderr.write(`[premiere-bridge-daemon] fatal: ${error.stack ?? String(error)}\n`);
      process.exit(1);
    });
}

export { UxpBridgeHost, UXP_DEFAULT_PORT, readUxpAuthSecret, uxpAuthRootDir };
