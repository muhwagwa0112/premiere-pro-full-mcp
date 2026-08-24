import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { uiAdapterCatalogArgs, uiAdapterInvokeArgs, uiSemanticActions } from "../src/features/ui/semantic-adapters.js";

describe("versioned UI semantic adapter contract", () => {
  it("exposes only catalog and fixed registry invocation schemas", () => {
    expect(uiSemanticActions.map((action) => action.id)).toEqual(["ui.adapter.catalog", "ui.adapter.invoke"]);
    expect(uiAdapterCatalogArgs.parse({})).toEqual({});
    expect(() => uiAdapterCatalogArgs.parse({ selector: "*" })).toThrow();
    expect(() => uiAdapterInvokeArgs.parse({
      adapterId: "premiere.workspace.editing",
      adapterVersion: 1,
      hostBuild: "26.3.2.1",
      locale: "ko-KR",
      uiFingerprint: `sha256:${"a".repeat(64)}`,
      automationId: "arbitrary-control",
    })).toThrow();
  });

  it("uses targeted FindFirst ancestor chaining with host, locale, fingerprint, and postcondition gates", async () => {
    const source = await readFile(new URL("../windows-ui-agent/PremiereAutomation.cs", import.meta.url), "utf8");
    expect(source).toContain("root.FindFirst(TreeScope.Descendants, ExactCondition(definition.Ancestor))");
    expect(source).toContain("ancestor.FindFirst(TreeScope.Descendants, ExactCondition(definition.Target))");
    expect(source).not.toContain("FindAll(");
    expect(source).not.toContain("TreeWalker");
    expect(source).toContain("definition.Supports(context.HostBuild, context.Locale)");
    expect(source).toContain("FixedTimeTextEquals(currentFingerprint, args.UiFingerprint)");
    expect(source).toContain("VerifyPostcondition(target, definition.Postcondition)");
  });

  it("removes raw selector/catalog operations from the named-pipe wire contract", async () => {
    const protocol = await readFile(new URL("../windows-ui-agent/Protocol.cs", import.meta.url), "utf8");
    const bridge = await readFile(new URL("../src/bridge/ui-named-pipe.ts", import.meta.url), "utf8");
    expect(protocol).not.toContain('"ui.control.invoke"');
    expect(protocol).not.toContain('"premiere.controls.catalog"');
    expect(bridge).not.toContain('request.operation === "ui.invoke"');
    expect(bridge).not.toContain('request.operation === "ui.catalog"');
    expect(protocol).toContain('"premiere.adapter.invoke"');
    expect(bridge).toContain('request.operation === "ui.adapter.invoke"');
  });
});
