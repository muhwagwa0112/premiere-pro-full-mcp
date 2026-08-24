import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("UXP bridge deployment contract", () => {
  it("keeps network permission constrained to the authenticated localhost broker", async () => {
    const manifest = JSON.parse(await readFile(resolve("uxp-plugin/manifest.json"), "utf8"));
    expect(manifest.requiredPermissions.network.domains).toEqual(["ws://localhost/"]);
  });

  it("creates short-lived Adobe Action objects inside executeTransaction", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    const transaction = source.slice(source.indexOf('if (operation === "uxp.transaction.execute")'), source.indexOf('if (operation === "uxp.locked.batch")'));
    expect(transaction).toContain("project.lockedAccess(function ()");
    expect(transaction).toContain("project.executeTransaction(function (compoundAction)");
    expect(transaction).toContain("compoundAction.addAction(invocation.method.apply");
    expect(transaction).not.toContain("await invokeMember");
  });

  it("passes Premiere a Windows directory and basename for frame export", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    expect(source).toContain('const filename = normalized.slice(separator + 1)');
    expect(source).toContain('exportSequenceFrame(context.sequence, frameTime, filename, directory');
  });

  it("uses session-scoped typed handles and readback for semantic mutations", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    for (const operation of ["project.close_disposable", "media.relink", "media.proxy.attach", "timeline.track.set_mute", "timeline.clip.insert"]) {
      expect(source).toContain(`"${operation}"`);
      expect(source).toContain(`if (operation === "${operation}")`);
    }
    expect(source).toContain("handleRecord(reference.$ref, reference.session)");
    expect(source).toContain('semanticHandle(args && args.clip, "ClipProjectItem", activeProjectIdentity)');
    expect(source).toContain('semanticHandle(args && args.sequence, "Sequence", activeProjectIdentity)');
    expect(source).toContain("currentMaterial !== record.semanticStateMaterial");
    expect(source).toContain("record.projectIdentity !== activeProjectIdentity");
    expect(source).toContain("clip.getMediaFilePath()");
    expect(source).toContain("clip.getProxyPath()");
    expect(source).toContain("track.isMuted()");
    expect(source).toContain("context.project.executeTransaction(function (compoundAction)");
    expect(source).toMatch(/context\.project\.lockedAccess\(function \(\) \{[\s\S]*compoundAction\.addAction\(editor\.createInsertProjectItemAction/);
    expect(source).toContain("videoTrack.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)");
    expect(source).toContain("closedProjectIdentityAbsent");
    expect(source).toContain("savedBeforeClose !== true");
    for (const code of ["UXP_RELINK_NOT_VERIFIED", "UXP_PROXY_NOT_VERIFIED", "UXP_TRACK_MUTE_NOT_VERIFIED", "UXP_INSERT_NOT_VERIFIED", "UXP_PROJECT_CLOSE_NOT_VERIFIED"]) expect(source).toContain(code);
    expect(source).not.toContain("querySelectorAll");
  });

  it("accepts the host file picker's documented single file and defensive array result", async () => {
    const source = await readFile(resolve("uxp-plugin/main.cjs"), "utf8");
    expect(source).toContain("Array.isArray(selection) ? selection[0] : selection");
    expect(source).toContain('status("Validating installed helper…")');
    expect(source).toContain("createPersistentToken(file)");
  });

  it("registers the installed panel lifecycle with the manifest entrypoint id", async () => {
    const [source, manifestText] = await Promise.all([
      readFile(resolve("uxp-plugin/main.js"), "utf8"),
      readFile(resolve("uxp-plugin/manifest.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText);
    const panelId = manifest.entrypoints.find((entrypoint: { type?: string }) => entrypoint.type === "panel").id;
    expect(panelId).toBe("premiereMcp2026Panel");
    expect(source).toContain("entrypoints.setup({");
    expect(source).toContain("[PANEL_ID]: {");
    expect(source).toContain(`const PANEL_ID = "${panelId}"`);
    expect(source).toContain("mountPanel(rootNode)");
    expect(source).not.toContain('const panelContent = document.getElementById("premiere-mcp-panel");\nlet bridgeInitialized');
    expect(source).toMatch(/function mountPanel\(rootNode\) \{[\s\S]*const panelContent = document\.getElementById\("premiere-mcp-panel"\);/);
    expect(source).toMatch(/function initializeBridge\(\) \{[\s\S]*require\("\.\/main\.cjs"\);[\s\S]*\}/);
    expect(source).toMatch(/create\(rootNode\) \{[\s\S]*mountPanel\(rootNode\);[\s\S]*initializeBridge\(\);/);
    for (const hook of ["create(rootNode)", "show(rootNode)", "hide()", "destroy()"]) expect(source).toContain(hook);
  });
});
