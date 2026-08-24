import { describe, expect, it } from "vitest";
import { loadAdobeApiCatalog, requiredCapabilitiesForAdobeEntry, searchAdobeApiCatalog, validateAdobeRuntimeCall } from "../src/adobe-api-catalog.js";

describe("generated Adobe UXP API catalog", () => {
  it("covers the complete 26.3 declaration surface with fail-closed classifications", async () => {
    const catalog = await loadAdobeApiCatalog();
    expect(catalog.counts).toMatchObject({ roots: 69, methods: 418, properties: 323, constructors: 20, members: 761 });
    expect(catalog.entries).toHaveLength(761);
    expect(catalog.entries.every((entry) => ["read", "edit", "sensitive", "filesystem", "destructive"].includes(entry.bucket))).toBe(true);
    expect(catalog.entries.every((entry) => entry.implementationStatus === "runtime_adaptive" || entry.implementationStatus === "special_callback_adapter")).toBe(true);
  });

  it("keeps representative static, instance, constructor, callback, and destructive members distinct", async () => {
    const catalog = await loadAdobeApiCatalog();
    const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    expect(byId.get("ProjectStatic.getActiveProject")?.root).toBe("Project");
    expect(byId.get("Project.save")?.root).toBeNull();
    expect(byId.get("AAFExportOptions.$new")?.root).toBe("AAFExportOptions");
    expect(byId.get("AAFExportOptions.setSampleRate")?.bucket).toBe("edit");
    expect(byId.get("EventManagerStatic.addEventListener")?.bucket).toBe("edit");
    expect(byId.get("Project.close")?.bucket).toBe("destructive");
    expect(byId.get("EncoderManager.startBatchEncode")?.bucket).toBe("destructive");
    expect(byId.get("TranscriptStatic.exportToJSON")?.bucket).toBe("read");
    expect(byId.get("Project.executeTransaction")?.implementationStatus).toBe("special_callback_adapter");
  });

  it("paginates search and rejects risk bucket downgrades", async () => {
    const page = await searchAdobeApiCatalog({ query: "project", offset: 0, limit: 5 });
    expect(page.entries).toHaveLength(5);
    expect(page.nextOffset).toBe(5);
    await expect(validateAdobeRuntimeCall("uxp.read", { memberId: "Project.close" })).rejects.toThrow(/must use uxp\.destructive/);
    await expect(validateAdobeRuntimeCall("uxp.destructive", { memberId: "Project.close" })).resolves.toMatchObject({ bucket: "destructive" });
  });

  it("binds destructive delete and overwrite members to trusted security capabilities", async () => {
    const catalog = await loadAdobeApiCatalog();
    const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    expect(requiredCapabilitiesForAdobeEntry(byId.get("Project.deleteSequence")!)).toEqual(["delete"]);
    expect(requiredCapabilitiesForAdobeEntry(byId.get("SequenceEditor.createOverwriteItemAction")!)).toEqual(["overwrite"]);
  });
});
