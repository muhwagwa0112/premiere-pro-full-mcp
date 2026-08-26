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
try {
  // `ping` is a real upstream tool; its script returns app.version etc.
  const upstream = getUpstreamToolModules({
    executeScript: (script) => client.executeScript(script, 12_000),
  });
  const result = await upstream["ping"].handler({});
  console.log("RESULT:", result.success === false ? "host-error" : "host-connected");
  console.log("raw:", JSON.stringify(result).slice(0, 600));
} catch (error) {
  console.log("RESULT: host-not-there");
  console.log("reason:", error.message);
} finally {
  await client.close();
}
