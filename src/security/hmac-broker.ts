import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

type KeyName = "cep-hmac" | "approval-hmac";

function installedHelper(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("The trusted launcher did not provide LOCALAPPDATA");
  return join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
}

async function invoke(args: string[], message: string, timeoutMs = 10_000): Promise<{ code: number; stdout: string }> {
  if (Buffer.byteLength(message, "utf8") > 1024 * 1024) throw new Error("HMAC broker input exceeds 1 MiB");
  const helper = installedHelper();
  try {
    return await new Promise((resolve, reject) => {
        const child = spawn(helper, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const timer = setTimeout(() => { child.kill(); reject(new Error("HMAC broker timed out")); }, timeoutMs);
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

const sessionKeys = new Map<KeyName, Promise<Buffer>>();

async function sessionKey(key: KeyName): Promise<Buffer> {
  const existing = sessionKeys.get(key);
  if (existing) return existing;
  const pending = invoke(["--hmac", key, "session-key", "node-server"], "", 30_000).then((result) => {
    const encoded = result.stdout.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("HMAC broker returned an invalid session key");
    const value = Buffer.from(encoded, "base64url");
    if (value.length !== 32) throw new Error("HMAC broker returned an invalid session key length");
    return value;
  });
  sessionKeys.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    sessionKeys.delete(key);
    throw error;
  }
}

export async function brokerSign(key: KeyName, message: string): Promise<string> {
  if (Buffer.byteLength(message, "utf8") > 1024 * 1024) throw new Error("HMAC input exceeds 1 MiB");
  return createHmac("sha256", await sessionKey(key)).update(message, "utf8").digest("base64url");
}

export async function brokerVerify(key: KeyName, message: string, signature: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = Buffer.from(await brokerSign(key, message), "ascii");
  const provided = Buffer.from(signature, "ascii");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
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
