import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("release SBOM", () => {
  test("removes Syft document roots without leaking build paths", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ppmcp-sbom-"));
    temporaryRoots.push(temporaryRoot);
    const bundleRoot = join(temporaryRoot, "bundle");
    const syftPath = join(temporaryRoot, "syft.json");
    const outputPath = join(temporaryRoot, "release.spdx.json");
    mkdirSync(bundleRoot);
    writeFileSync(join(bundleRoot, "payload.txt"), "release payload\n");
    const documentRootId = "SPDXRef-DocumentRoot-Directory-D--PP-MCP-.release-staging-release";
    writeFileSync(syftPath, JSON.stringify({
      SPDXID: "SPDXRef-DOCUMENT",
      packages: [
        {
          name: "D:\\PP_MCP\\.release-staging\\release",
          SPDXID: documentRootId,
          primaryPackagePurpose: "FILE",
          filesAnalyzed: false,
          downloadLocation: "NOASSERTION",
        },
        {
          name: "example-dependency",
          SPDXID: "SPDXRef-Package-example-dependency",
          versionInfo: "1.0.0",
          filesAnalyzed: false,
          downloadLocation: "NOASSERTION",
        },
      ],
      files: [{ fileName: "syft-input", SPDXID: "SPDXRef-File-syft-input" }],
      relationships: [
        { spdxElementId: documentRootId, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-File-syft-input" },
        { spdxElementId: documentRootId, relationshipType: "CONTAINS", relatedSpdxElement: "SPDXRef-Package-example-dependency" },
      ],
    }));

    execFileSync(process.execPath, [
      resolve(root, "scripts", "generate-release-sbom.mjs"), bundleRoot, syftPath, outputPath,
    ]);
    const outputText = readFileSync(outputPath, "utf8");
    const output = JSON.parse(outputText);
    expect(outputText).not.toContain("D:\\\\PP_MCP");
    expect(outputText).not.toContain("SPDXRef-DocumentRoot-");
    expect(output.packages.some((item: { name: string }) => item.name === "example-dependency")).toBe(true);
    expect(output.files.map((item: { fileName: string }) => item.fileName).sort()).toEqual(["payload.txt"]);
    expect(output.relationships).toContainEqual({
      spdxElementId: "SPDXRef-Package-premiere-pro-full-mcp-0.3.0",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: "SPDXRef-Package-example-dependency",
    });
  });
});
