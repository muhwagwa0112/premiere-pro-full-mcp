import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listActions } from "../src/catalog.js";
import { FEATURE_BACKENDS, FEATURE_STATUSES } from "../src/features/registry-contract.js";
import { listFeatureRegistry, renderFeatureMatrix, serializeFeatureRegistry } from "../src/features/registry.js";

const requiredRoadmapFamilies = [
  "project.create", "project.close", "project.bin_item.crud", "productions.manage", "team_projects.manage",
  "media.import", "media.folder.import", "media.relink", "media.proxy.manage", "media.ingest", "media.interpret_footage", "media.metadata", "media.subclip",
  "timeline.sequence.crud", "timeline.sequence.settings", "timeline.track.crud", "timeline.track.state", "timeline.clip.insert", "timeline.clip.overwrite", "timeline.clip.move_copy", "timeline.clip.delete", "timeline.edit.ripple_lift_extract", "timeline.clip.link_group_nest", "timeline.markers", "timeline.in_out", "timeline.playhead",
  "trim.ripple", "trim.roll", "trim.slip", "trim.slide", "trim.rate_stretch", "sync.audio_timecode", "multicam.source", "multicam.angle", "multicam.flatten",
  "effects.inventory", "effects.apply_remove_reorder", "effects.parameters", "effects.keyframes", "transitions.manage", "motion.transform", "opacity.manage", "time_remapping.manage", "masks.manage", "masks.object",
  "audio.clip_gain", "audio.volume_pan", "audio.keyframes", "audio.channel_mapping", "audio.track_mixer", "audio.submix_send", "audio.essential_sound", "audio.enhance_speech", "audio.remix", "audio.loudness",
  "transcript.status", "transcript.create", "transcript.search_edit", "text_based_editing", "captions.track_cue.crud", "captions.import_export", "graphics.mogrt", "graphics.properties",
  "color.lumetri", "color.lut", "color.space", "color.tone_mapping", "color.hdr_metadata", "color.curves_hsl_wheels",
  "export.frame", "export.sequence", "export.range", "export.batch", "ame.queue_status", "interchange.aaf", "interchange.xml", "interchange.edl", "interchange.omf", "export.captions", "project_manager.collect",
  "playback.control", "monitors.control", "workspace.select", "panels.control", "history.undo_redo", "preferences.manage", "scratch_disk.manage", "media_cache.manage",
  "collaboration.productions", "collaboration.team_projects", "cloud.frame_io", "cloud.stock", "cloud.media", "cloud.speech_caption", "ai.generative",
  "plugin.inventory", "plugin.adapters", "native.codec_importer_exporter", "native.hardware_sdk", "native.high_performance_video", "native.high_performance_audio", "native.ml",
] as const;

describe("complete feature registry", () => {
  it("registers every roadmap family and every public action exactly once", () => {
    const entries = listFeatureRegistry();
    const ids = entries.map((entry) => entry.featureId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(requiredRoadmapFamilies.every((id) => ids.includes(id))).toBe(true);
    expect(listActions().every((action) => ids.includes(action.id))).toBe(true);
  });

  it("records backend, state, version, preconditions, verifier, and truthful evidence state", () => {
    for (const entry of listFeatureRegistry()) {
      expect(entry.featureId).toMatch(/^[a-z0-9_.-]+$/);
      expect(FEATURE_STATUSES).toContain(entry.status);
      expect(entry.backends.every((backend) => FEATURE_BACKENDS.includes(backend))).toBe(true);
      expect(entry.minimumPremiereVersion === null || /^26\.3(?:\.\d+)?$/.test(entry.minimumPremiereVersion)).toBe(true);
      expect(entry.preconditions.length).toBeGreaterThan(0);
      expect(entry.verification.length).toBeGreaterThan(0);
      expect(entry.limitations.length).toBeGreaterThan(0);
      expect(["VERIFIED_AUTOMATED", "VERIFIED_READ_ONLY"]).not.toContain(entry.status);
    }
  });

  it("cannot contradict the public action catalog", () => {
    const byId = new Map(listFeatureRegistry().map((entry) => [entry.featureId, entry]));
    for (const action of listActions()) {
      const entry = byId.get(action.id)!;
      expect(entry.risk).toBe(action.risk);
      expect(entry.backends).toEqual(action.preferredBackends);
      expect(entry.minimumPremiereVersion).toBe(action.minimumPremiereVersion);
    }
  });

  it("has plan-only disposable fixture declarations for all required validation domains", () => {
    const manifest = JSON.parse(readFileSync("fixtures/feature-families.fixture.json", "utf8")) as {
      evidenceState: string; liveEvidence: boolean; fixtures: Array<{ fixtureId: string; covers: string[] }>;
    };
    expect(manifest.evidenceState).toBe("plan_only");
    expect(manifest.liveEvidence).toBe(false);
    const fixtureIds = new Set(manifest.fixtures.map((fixture) => fixture.fixtureId));
    const covered = new Set(manifest.fixtures.flatMap((fixture) => fixture.covers));
    expect([...new Set(listFeatureRegistry().flatMap((entry) => entry.fixture ? [entry.fixture] : []))].every((id) => fixtureIds.has(id))).toBe(true);
    for (const domain of ["project", "media", "timeline", "effects", "audio", "text", "color", "export"]) expect(covered.has(domain)).toBe(true);
  });

  it("serializes JSON and Markdown deterministically", () => {
    expect(serializeFeatureRegistry()).toBe(serializeFeatureRegistry());
    expect(renderFeatureMatrix()).toBe(renderFeatureMatrix());
    expect(readFileSync("generated/feature-registry.json", "utf8")).toBe(serializeFeatureRegistry());
    expect(readFileSync("docs/FEATURE_MATRIX.md", "utf8")).toBe(renderFeatureMatrix());
  });
});
