import type { ProgramFeatureContract, ProgramRuntimeReadiness, ProgramBlockResult } from "./contracts.js";

const noEvidence = ["No live or disposable-fixture evidence is recorded; this is not a verified capability."];

const feature = (
  actionId: string,
  domain: ProgramFeatureContract["domain"],
  availability: ProgramFeatureContract["availability"],
  options: Partial<Pick<ProgramFeatureContract, "mutatesProject" | "exportsFile" | "executionSurface" | "entitlement" | "limitations">> = {},
): ProgramFeatureContract => ({
  actionId,
  domain,
  availability,
  mutatesProject: options.mutatesProject ?? false,
  exportsFile: options.exportsFile ?? false,
  executionSurface: options.executionSurface ?? "premiere_operations",
  entitlement: options.entitlement ?? null,
  evidenceState: "none",
  limitations: options.limitations ?? [...noEvidence],
});

const adobeSpeech = { key: "adobe.speech", product: "Adobe speech and caption service", probe: "runtime_entitlement_probe" as const };
const enhanceSpeech = { key: "adobe.enhance_speech", product: "Adobe Enhance Speech", probe: "runtime_entitlement_probe" as const };

export const postProductionProgram: readonly ProgramFeatureContract[] = [
  feature("effects.catalog", "effects", "handler_unverified"),
  // effects.apply now has a real typed QE-backed handler (see cep-plugin/host.jsx
  // PPMCP.semantic.applyEffect). It is unverified against live host evidence,
  // so it stays below "implemented_unverified" but is no longer "not_implemented".
  feature("effects.apply", "effects", "handler_unverified", { mutatesProject: true }),
  feature("effects.parameters", "effects", "not_implemented", { mutatesProject: true }),
  feature("effects.keyframes", "effects", "not_implemented", { mutatesProject: true }),
  feature("transitions.manage", "effects", "not_implemented", { mutatesProject: true }),
  feature("motion.transform", "effects", "not_implemented", { mutatesProject: true }),
  feature("opacity.manage", "effects", "not_implemented", { mutatesProject: true }),
  feature("time_remapping.manage", "effects", "not_implemented", { mutatesProject: true }),
  feature("masks.manage", "effects", "not_implemented", { mutatesProject: true }),
  feature("masks.object", "effects", "blocked_host_version", { mutatesProject: true }),

  feature("audio.clip_gain", "audio", "not_implemented", { mutatesProject: true }),
  feature("audio.volume_pan", "audio", "not_implemented", { mutatesProject: true }),
  feature("audio.keyframes", "audio", "not_implemented", { mutatesProject: true }),
  feature("audio.channel_mapping", "audio", "not_implemented", { mutatesProject: true }),
  feature("audio.track_mixer", "audio", "ui_adapter_required", { mutatesProject: true }),
  feature("audio.submix_send", "audio", "ui_adapter_required", { mutatesProject: true }),
  feature("audio.essential_sound", "audio", "ui_adapter_required", { mutatesProject: true }),
  feature("audio.enhance_speech", "audio", "blocked_external", { mutatesProject: true, entitlement: enhanceSpeech }),
  feature("audio.remix", "audio", "ui_adapter_required", { mutatesProject: true }),
  feature("audio.loudness", "audio", "ui_adapter_required", { mutatesProject: true }),

  feature("transcript.status", "text", "not_implemented"),
  feature("transcript.create", "text", "blocked_external", { mutatesProject: true, entitlement: adobeSpeech }),
  feature("transcript.search_edit", "text", "ui_adapter_required", { mutatesProject: true }),
  feature("text_based_editing", "text", "ui_adapter_required", { mutatesProject: true, executionSurface: "premiere_jobs" }),
  feature("graphics.mogrt", "text", "third_party_dependent", { mutatesProject: true }),
  feature("graphics.properties", "text", "not_implemented", { mutatesProject: true }),

  feature("captions.inspect", "captions", "handler_unverified"),
  feature("captions.track_cue.crud", "captions", "not_implemented", { mutatesProject: true }),
  feature("captions.import_export", "captions", "not_implemented", { mutatesProject: true, exportsFile: true, executionSurface: "premiere_jobs" }),

  feature("color.lumetri", "color", "not_implemented", { mutatesProject: true }),
  feature("color.lut", "color", "not_implemented", { mutatesProject: true }),
  feature("color.space", "color", "not_implemented", { mutatesProject: true }),
  feature("color.tone_mapping", "color", "not_implemented", { mutatesProject: true }),
  feature("color.hdr_metadata", "color", "not_implemented"),
  feature("color.curves_hsl_wheels", "color", "ui_adapter_required", { mutatesProject: true }),

  feature("export.frame", "export", "handler_unverified", { exportsFile: true }),
  feature("export.sequence", "export", "handler_unverified", { exportsFile: true }),
  feature("export.range", "export", "not_implemented", { exportsFile: true }),
  feature("export.batch", "export", "not_implemented", { exportsFile: true, executionSurface: "premiere_jobs" }),
  feature("ame.queue_status", "export", "not_implemented"),
  feature("interchange.aaf", "export", "ui_adapter_required", { exportsFile: true }),
  feature("interchange.xml", "export", "not_implemented", { exportsFile: true }),
  feature("interchange.edl", "export", "not_implemented", { exportsFile: true }),
  feature("interchange.omf", "export", "ui_adapter_required", { exportsFile: true }),
  feature("export.captions", "export", "not_implemented", { exportsFile: true }),
  feature("project_manager.collect", "export", "ui_adapter_required", { mutatesProject: true, exportsFile: true, executionSurface: "premiere_jobs" }),
];

export function evaluateProgramReadiness(contract: ProgramFeatureContract, runtime: ProgramRuntimeReadiness): ProgramBlockResult {
  if (contract.entitlement && !runtime.verifiedEntitlements.includes(contract.entitlement.key)) {
    return {
      status: "blocked_external",
      error: { code: "ENTITLEMENT_NOT_VERIFIED", message: `${contract.entitlement.product} entitlement was not verified by a runtime probe` },
    };
  }
  if (contract.availability === "ui_adapter_required") {
    const registered = runtime.registeredUiAdapters?.includes(contract.actionId) ?? false;
    return registered
      ? { status: "ready_unverified" }
      : { status: "unsupported", error: { code: "UI_ADAPTER_REQUIRED", message: `No registered semantic UI adapter exists for ${contract.actionId}` } };
  }
  if (contract.availability === "blocked_host_version") return { status: "unsupported", error: { code: "HOST_VERSION_BLOCKED", message: `${contract.actionId} is blocked by the current host capability boundary` } };
  if (contract.availability === "third_party_dependent") return { status: "unsupported", error: { code: "THIRD_PARTY_DEPENDENCY", message: `${contract.actionId} requires a separately verified third-party dependency` } };
  if (contract.availability === "not_implemented" || !runtime.advertisedHandlers.includes(contract.actionId)) {
    return { status: "unsupported", error: { code: "HANDLER_NOT_IMPLEMENTED", message: `No runtime handler is advertised for ${contract.actionId}` } };
  }
  return { status: "ready_unverified" };
}
