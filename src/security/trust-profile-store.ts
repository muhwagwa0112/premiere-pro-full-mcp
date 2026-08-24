import { spawn } from "node:child_process";
import { join } from "node:path";
import { parseTrustProfile, type TrustProfile } from "./trust-profile.js";

const MAX_PROFILE_BYTES = 1024 * 1024;

export interface TrustProfileStore {
  load(profileId: string): Promise<TrustProfile>;
}

export type TrustProfileBrokerInvoker = (args: readonly string[], input: string) => Promise<string>;

function installedHelper(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("The trusted launcher did not provide LOCALAPPDATA");
  return join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
}

async function invokeInstalledBroker(args: readonly string[], input: string): Promise<string> {
  if (Buffer.byteLength(input, "utf8") > MAX_PROFILE_BYTES) throw new Error("Trust profile broker input exceeds 1 MiB");
  return new Promise((resolve, reject) => {
    const child = spawn(installedHelper(), [...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Trust profile broker timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_PROFILE_BYTES) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 4_096) stderr.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Trust profile broker failed with code ${String(code)}`));
        return;
      }
      if (stdoutBytes > MAX_PROFILE_BYTES) {
        reject(new Error("Trust profile broker output exceeds 1 MiB"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(input, "utf8");
  });
}

export class BrokerTrustProfileStore implements TrustProfileStore {
  readonly #invoke: TrustProfileBrokerInvoker;

  constructor(invoke: TrustProfileBrokerInvoker = invokeInstalledBroker) {
    this.#invoke = invoke;
  }

  async load(profileId: string): Promise<TrustProfile> {
    assertProfileId(profileId);
    const raw = await this.#invoke(["--trust-profile", "read", "node-server", profileId], "");
    try {
      return parseTrustProfile(JSON.parse(raw));
    } catch (error) {
      throw new Error(`Trust profile broker returned an invalid profile: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

}

function assertProfileId(profileId: string): void {
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(profileId)) throw new Error("Trust profile ID is invalid");
}
