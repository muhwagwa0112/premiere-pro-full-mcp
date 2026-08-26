import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DAEMON_PORT, readBridgeEndpoint } from "./bridge/ws-host.js";

/**
 * Ensure the always-on daemon is running, installing the logon auto-start
 * registration on first use. This is what "always on" means operationally:
 * - The Windows Task Scheduler entry starts the daemon at every user logon.
 * - If the port is currently free, we start it right now too.
 *
 * Returns true when a live daemon is reachable.
 */
export function ensureDaemon(): boolean {
  const existing = readBridgeEndpoint();
  if (existing && typeof existing.port === "number" && existing.port === DEFAULT_DAEMON_PORT) {
    // A daemon may be running even if the endpoint file is stale; the caller
    // still gets a client that will attempt the live connection.
    return true;
  }
  return tryStartDaemon();
}

function tryStartDaemon(): boolean {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const daemonJs = join(here, "daemon.js");
    if (!existsSync(daemonJs)) return false;
    const child = spawn(process.execPath, [daemonJs], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function autoRegisterLogon(startNow: boolean): { registered: boolean; running: boolean } {
  let registered = false;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = join(here, "..", "scripts", "install-daemon.ps1");
    if (existsSync(script)) {
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
      if (startNow) args.push("-StartNow");
      execFileSync("powershell", args, {
        stdio: "inherit",
        windowsHide: true,
      });
      registered = true;
    }
  } catch {
    registered = false;
  }
  const running = readBridgeEndpoint() !== null;
  return { registered, running };
}
