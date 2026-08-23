import { spawn } from "node:child_process";
import { join } from "node:path";

type KeyName = "cep-hmac" | "approval-hmac";

function installedHelper(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("The trusted launcher did not provide LOCALAPPDATA");
  return join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
}

async function invoke(args: string[], message: string): Promise<{ code: number; stdout: string }> {
  if (Buffer.byteLength(message, "utf8") > 1024 * 1024) throw new Error("HMAC broker input exceeds 1 MiB");
  const helper = installedHelper();
  try {
    return await new Promise((resolve, reject) => {
        const child = spawn(helper, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => { child.kill(); reject(new Error("HMAC broker timed out")); }, 10_000);
        child.stdout.on("data", (chunk: Buffer) => { if (stdout.reduce((sum, value) => sum + value.length, 0) + chunk.length <= 1024 * 1024) stdout.push(chunk); });
        child.stderr.on("data", (chunk: Buffer) => { if (stderr.reduce((sum, value) => sum + value.length, 0) + chunk.length <= 4096) stderr.push(chunk); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === null) return reject(new Error("HMAC broker terminated unexpectedly"));
          if (code !== 0 && code !== 4) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `HMAC broker failed with code ${code}`));
          resolve({ code, stdout: Buffer.concat(stdout).toString("utf8") });
        });
        child.stdin.end(message, "utf8");
    });
  } catch (error) {
    throw new Error(`HMAC broker is unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function brokerSign(key: KeyName, message: string): Promise<string> {
  const result = await invoke(["--hmac", key, "sign", "node-server"], message);
  const signature = result.stdout.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error("HMAC broker returned an invalid signature");
  return signature;
}

export async function brokerVerify(key: KeyName, message: string, signature: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  return (await invoke(["--hmac", key, "verify", "node-server", signature], message)).code === 0;
}

export async function brokerProtect(message: string): Promise<string> {
  const value = (await invoke(["--protect", "approval-payload", "protect", "node-server"], message)).stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error("Protection broker returned invalid ciphertext");
  return value;
}

export async function brokerUnprotect(ciphertext: string): Promise<string> {
  if (!/^[A-Za-z0-9+/=]+$/.test(ciphertext)) throw new Error("Protected approval payload is invalid");
  return (await invoke(["--protect", "approval-payload", "unprotect", "node-server"], ciphertext)).stdout;
}
