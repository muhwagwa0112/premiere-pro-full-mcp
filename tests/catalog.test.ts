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
    expect(getAction("ui.adapter.invoke").risk).toBe("R3");
  });

  it("exposes a typed R1 sequence creation contract without accepting paths", () => {
    const action = getAction("timeline.sequence.create_from_media");
    expect(action.risk).toBe("R1");
    expect(validateActionArgs(action, { name: "Live Validation", projectItemIds: ["node-1"] })).toMatchObject({ name: "Live Validation" });
    expect(() => validateActionArgs(action, { name: "Live Validation", projectItemIds: ["node-1"], path: "C:\\escape.mp4" })).toThrow();
  });

  it("requires scoped state tokens and strict typed handles for core semantic mutations", () => {
    const handle = { $ref: "session-handle-1", type: "Sequence", session: "session-1234", stateToken: "semantic-v1-session-token" };
    for (const actionId of ["project.close_disposable", "project.save_as", "media.relink", "media.proxy.attach", "timeline.track.set_mute", "timeline.clip.insert"]) {
      const action = getAction(actionId);
      expect(action.stateTokenRequired).toBe(true);
      expect(action.stateScope).toBeTruthy();
      expect(action.verifierId).toMatch(/^.+\.v1$/);
    }
    expect(validateActionArgs(getAction("timeline.track.set_mute"), { sequence: handle, mediaType: "video", trackIndex: 0, muted: true })).toMatchObject({ trackIndex: 0, muted: true });
    expect(() => validateActionArgs(getAction("timeline.track.set_mute"), { sequence: { $ref: "session-handle-1" }, mediaType: "video", trackIndex: 0, muted: true })).toThrow();
    expect(() => validateActionArgs(getAction("timeline.clip.insert"), { sequence: handle, projectItem: handle, timeSeconds: 0, videoTrackIndex: 0, audioTrackIndex: 0, limitShift: true, selector: "*" })).toThrow();
    expect(() => validateActionArgs(getAction("timeline.clip.insert"), { sequence: handle, projectItem: handle, timeSeconds: 604_801, videoTrackIndex: 0, audioTrackIndex: 0 })).toThrow();
    expect(() => validateActionArgs(getAction("media.proxy.attach"), { clip: handle, path: "C:\\media\\proxy.mp4", teamProjectAlternate: true })).toThrow();
    expect(validateActionArgs(getAction("project.save_as"), { path: "C:\\project\\copy.prproj" })).toMatchObject({ overwrite: false });
    expect(() => validateActionArgs(getAction("project.save_as"), { path: "C:\\project\\copy.prproj", overwrite: true })).toThrow();
  });
});
