import { WsHost, DEFAULT_DAEMON_PORT, daemonStateDir, daemonEndpointPath, daemonPidFile } from "./bridge/ws-host.js";

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
