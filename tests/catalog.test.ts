import { describe, expect, it } from "vitest";
import { getAction, listActions, validateActionArgs } from "../src/catalog.js";

describe("action catalog", () => {
  it("contains every public domain and explicit safety metadata", () => {
    const actions = listActions();
    expect(new Set(actions.map((action) => action.domain))).toEqual(new Set([
      "api", "inspection", "project", "media", "timeline", "effects_audio", "text_captions", "export", "workspace", "plugins", "cloud",
    ]));
    for (const action of actions) {
      expect(action.preferredBackends.length).toBeGreaterThan(0);
      expect(action.verification.length).toBeGreaterThan(0);
      expect(action.minimumPremiereVersion).toMatch(/^26\.3/);
    }
  });

  it("validates action-specific arguments and rejects unknown fields", () => {
    const action = getAction("export.frame");
    expect(validateActionArgs(action, { outputPath: "C:\\out\\frame.png", timeSeconds: 2 })).toMatchObject({ timeSeconds: 2 });
    expect(() => validateActionArgs(action, { outputPath: "C:\\out\\frame.png", timeSeconds: -1 })).toThrow();
    expect(() => validateActionArgs(action, { outputPath: "C:\\out\\frame.png", timeSeconds: 2, rawScript: "bad" })).toThrow();
  });

  it("keeps transactions and generic UI fallback behind R3 confirmation", () => {
    expect(getAction("uxp.transaction.execute").risk).toBe("R3");
    expect(getAction("project.create").risk).toBe("R2");
    expect(getAction("ui.invoke").risk).toBe("R3");
  });

  it("exposes a typed R1 sequence creation contract without accepting paths", () => {
    const action = getAction("timeline.sequence.create_from_media");
    expect(action.risk).toBe("R1");
    expect(validateActionArgs(action, { name: "Live Validation", projectItemIds: ["node-1"] })).toMatchObject({ name: "Live Validation" });
    expect(() => validateActionArgs(action, { name: "Live Validation", projectItemIds: ["node-1"], path: "C:\\escape.mp4" })).toThrow();
  });
});
