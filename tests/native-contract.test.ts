import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPinnedNativeOperation, verifyPinnedNativeArtifact, type NativeIntegrityManifest } from "../native/verify-contract.js";

describe("native extension contract", () => {
  it("uses a versioned allowlist and pins every declared operation to integrity verification", async () => {
    const contractPath = new URL("../native/contract-v1.json", import.meta.url);
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as {
      protocol: string;
      operations: Array<{ id: string; requiresIntegrityPin: boolean; requiresExactPluginDependency: boolean; unknownOutcomePolicy?: string }>;
    };
    expect(contract.protocol).toBe("premiere-mcp-native/1");
    expect(contract.operations.every((operation) => operation.id.endsWith(".v1") && operation.requiresIntegrityPin && operation.requiresExactPluginDependency)).toBe(true);
    expect(contract.operations.find((operation) => operation.id === "native.plugin.invoke.v1")?.unknownOutcomePolicy).toBe("reconciliation_required_no_retry");
    await expect(assertPinnedNativeOperation("native.plugin.inspect.v1")).resolves.toBeUndefined();
    await expect(assertPinnedNativeOperation("native.plugin.inspect")).rejects.toThrow(/pinned v1 contract/);
  });

  it("verifies the exact SHA-256 pin but keeps contract-only artifacts non-executable", async () => {
    const manifest = JSON.parse(await readFile(new URL("../native/integrity-pins-v1.json", import.meta.url), "utf8")) as NativeIntegrityManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pins).toHaveLength(1);
    const pin = manifest.pins[0]!;
    const result = await verifyPinnedNativeArtifact(fileURLToPath(new URL(`../native/${pin.artifact}`, import.meta.url)), pin.artifact);
    expect(result.digest).toBe(pin.sha256);
    expect(result.verified).toBe(true);
    expect(result.executable).toBe(false);
    expect(pin.status).toBe("contract_only");
    await expect(verifyPinnedNativeArtifact(fileURLToPath(new URL("../native/README.md", import.meta.url)), "README.md")).rejects.toThrow(/no integrity pin/);
  });
});
