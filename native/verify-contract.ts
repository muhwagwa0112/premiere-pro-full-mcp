import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface NativeIntegrityPin {
  artifact: string;
  protocol: "premiere-mcp-native/1";
  sha256: `sha256:${string}`;
  status: "contract_only" | "enabled";
}

export interface NativeIntegrityManifest {
  schemaVersion: 1;
  pins: readonly NativeIntegrityPin[];
}

const manifestUrl = new URL("./integrity-pins-v1.json", import.meta.url);
const contractUrl = new URL("./contract-v1.json", import.meta.url);

async function loadManifest(): Promise<NativeIntegrityManifest> {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as NativeIntegrityManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.pins)) throw new Error("Unsupported native integrity manifest");
  return manifest;
}

async function verifyNativeArtifact(
  artifactPath: string,
  expected: NativeIntegrityPin,
): Promise<{ verified: boolean; digest: `sha256:${string}`; executable: boolean }> {
  const bytes = await readFile(artifactPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
  return { verified: digest === expected.sha256, digest, executable: digest === expected.sha256 && expected.status === "enabled" };
}

export async function verifyPinnedNativeArtifact(
  artifactPath: string,
  artifact: string,
): Promise<{ verified: boolean; digest: `sha256:${string}`; executable: boolean }> {
  if (artifact.includes("/") || artifact.includes("\\")) throw new Error("Native artifact identity must be a file name");
  const manifest = await loadManifest();
  const pin = manifest.pins.find((candidate) => candidate.artifact === artifact);
  if (!pin) throw new Error(`Native artifact '${artifact}' has no integrity pin`);
  return verifyNativeArtifact(artifactPath, pin);
}

function assertVersionedNativeOperation(operation: string, contract: { protocol: string; operations: readonly { id: string }[] }): void {
  if (contract.protocol !== "premiere-mcp-native/1") throw new Error("Unsupported native protocol version");
  if (!/\.v1$/.test(operation) || !contract.operations.some((entry) => entry.id === operation)) throw new Error(`Native operation '${operation}' is not present in the pinned v1 contract`);
}

export async function assertPinnedNativeOperation(operation: string): Promise<void> {
  const contractBytes = await readFile(contractUrl);
  const pinResult = await verifyPinnedNativeArtifact(fileURLToPath(contractUrl), "contract-v1.json");
  if (!pinResult.verified) throw new Error("Native v1 operation contract failed integrity verification");
  const contract = JSON.parse(contractBytes.toString("utf8")) as { protocol: string; operations: readonly { id: string }[] };
  assertVersionedNativeOperation(operation, contract);
}
