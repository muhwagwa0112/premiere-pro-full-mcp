/**
 * Live probe: asks the running always-on daemon whether a real Premiere CEP
 * host is currently connected by sending one `execute` with a trivial script
 * and a short timeout. Does not touch Premiere's project; just pings the CEP
 * host that is attached to the daemon.
 *
 * Result codes:
 *   - "host-connected"  : CEP answered (bridge is live end-to-end right now)
 *   - "host-not-there"  : daemon up, but no CEP host attached (Premiere not
 *                         running or hasn't loaded the new panel yet)
 *   - "daemon-down"     : nothing listening on the fixed port
 */
import { BridgeClient } from "../dist/bridge/ws-client.js";
import { DEFAULT_DAEMON_PORT, readBridgeEndpoint } from "../dist/bridge/ws-host.js";
import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";

const endpoint = readBridgeEndpoint();
const port = endpoint ? endpoint.port : DEFAULT_DAEMON_PORT;

if (!endpoint) {
  console.log("RESULT: daemon-down (no endpoint file)");
  process.exit(0);
}

const client = await BridgeClient.connect(port);
let operationId = null;
try {
  try {
    operationId = await client.beginOperation({
      toolName: "ping",
      backend: "cep",
      mode: "read",
      timeoutMs: 12_000,
      queueDeadlineMs: 5_000,
      args: {},
      itemCount: 1,
    });
  } catch (error) {
    if (error?.code !== "OPERATION_COORDINATOR_UNAVAILABLE") throw error;
  }
  // `ping` is a real upstream tool; its script returns app.version etc.
  const upstream = getUpstreamToolModules({
    executeScript: (script) => client.executeScript(script, 12_000, operationId ? {
      operationId,
      toolName: "ping",
      backend: "cep",
      mode: "read",
    } : undefined),
  });
  const result = await upstream["ping"].handler({});
  if (operationId) await client.endOperation(operationId, result.success === false ? "FAILED" : "SUCCEEDED", result.success === false ? "LIVE_PROBE_FAILED" : undefined);
  console.log("RESULT:", result.success === false ? "host-error" : "host-connected");
  console.log("raw:", JSON.stringify(result).slice(0, 600));
} catch (error) {
  if (operationId) {
    try { await client.endOperation(operationId, "FAILED", String(error?.code ?? "LIVE_PROBE_FAILED")); } catch { /* Preserve the probe error. */ }
  }
  console.log("RESULT: host-not-there");
  console.log("reason:", error.message);
} finally {
  await client.close();
}
